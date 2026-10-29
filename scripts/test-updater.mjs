// 版本检查与更新路由的自测（不联网、不真的跑 pnpm）。
//
// 覆盖：
//   1. compareVersions / detectInstallSource 的纯逻辑；
//   2. GET /update-check 的返回形状（把 globalThis.fetch 换成假 GitHub）；
//   3. POST /update 的三条拦截分支（link 安装 / 非 GitHub 安装 / 关闭联网检查），
//      确保不会在测试里真的执行 pnpm。
//
// 用法：node scripts/test-updater.mjs
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const updaterPath = pathToFileURL(path.join(root, 'lib', 'updater.js')).href

let failures = 0
function check(label, ok, extra = '') {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`)
}

const {
  compareVersions,
  detectInstallSource,
  readLocalVersion,
  fetchRemotePackage,
  createVersionChecker,
} = await import(updaterPath)

// ---------------------------------------------------------------- 纯逻辑

check('compareVersions 1.1.0 > 1.0.0', compareVersions('1.1.0', '1.0.0') === 1)
check('compareVersions 1.0.0 < 1.1.0', compareVersions('1.0.0', '1.1.0') === -1)
check('compareVersions 1.0.0 == v1.0.0', compareVersions('v1.0.0', '1.0.0') === 0)
check('compareVersions 1.10.0 > 1.9.9', compareVersions('1.10.0', '1.9.9') === 1)
check('compareVersions 2.0.0 > 1.99.99', compareVersions('2.0.0', '1.99.99') === 1)

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fuulea-import-updater-'))

function profileWith(spec) {
  const dir = fs.mkdtempSync(path.join(tmp, 'profile-'))
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    name: 'dsh-profile-test',
    dsh: { profile: { bundles: [] } },
    dependencies: spec ? { 'dsh-fuulea-import': spec } : {},
  }))
  return dir
}

check('detectInstallSource github:',
  detectInstallSource(profileWith('github:100759/dsh-fuulea-import'), 'dsh-fuulea-import').source === 'github')
check('detectInstallSource github 带 #tag 也能取到 repo',
  detectInstallSource(profileWith('github:100759/dsh-fuulea-import#v1.0.0'), 'dsh-fuulea-import').repo === '100759/dsh-fuulea-import')
check('detectInstallSource link:',
  detectInstallSource(profileWith('link:/tmp/somewhere'), 'dsh-fuulea-import').source === 'link')
check('detectInstallSource 版本号 → registry',
  detectInstallSource(profileWith('1.0.0'), 'dsh-fuulea-import').source === 'registry')
check('detectInstallSource 无该依赖 → unknown',
  detectInstallSource(profileWith(''), 'dsh-fuulea-import').source === 'unknown')
check('readLocalVersion 与 package.json 一致', readLocalVersion(root) === JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version)

// ---------------------------------------------------------------- 假 GitHub

const realFetch = globalThis.fetch
const remotePkg = { version: '9.9.9', description: 'test' }
let fetchCalls = 0

function stubGitHub(mode) {
  fetchCalls = 0
  globalThis.fetch = async (url) => {
    fetchCalls++
    if (mode === 'fail') throw new Error('模拟网络不可达')
    return {
      ok: true,
      status: 200,
      json: async () => ({ content: Buffer.from(JSON.stringify(remotePkg)).toString('base64') }),
    }
  }
}

stubGitHub('ok')
const remote = await fetchRemotePackage('100759/dsh-fuulea-import')
check('fetchRemotePackage 读到远端版本', remote.version === '9.9.9', remote.version)
check('fetchRemotePackage 优先走 contents API', String(fetchCalls) === '1', 'calls=' + fetchCalls)

// ---------------------------------------------------------------- 版本检查

const checker = createVersionChecker({
  repo: '100759/dsh-fuulea-import',
  currentVersion: () => '1.0.0',
  installedVersion: () => '1.0.0',
  installSource: () => ({ source: 'github', spec: 'github:100759/dsh-fuulea-import' }),
})
const info = await checker.check(true)
check('有新版本时 updateAvailable=true', info.updateAvailable === true)
check('updateAvailable 的 latest 是远端版本', info.latest === '9.9.9')
check('未更新时 restartPending=false', info.restartPending === false)
check('checker 记录安装来源', info.source === 'github')

const checkerRestart = createVersionChecker({
  repo: '100759/dsh-fuulea-import',
  currentVersion: () => '1.0.0',
  installedVersion: () => '9.9.9',
  installSource: () => ({ source: 'github', spec: '' }),
})
const infoRestart = await checkerRestart.check(true)
check('磁盘版本已更新但进程仍旧 → restartPending=true', infoRestart.restartPending === true)
check('restartPending 时不再提示可更新', infoRestart.updateAvailable === false)

stubGitHub('fail')
const checkerOffline = createVersionChecker({ repo: 'x/y', currentVersion: () => '1.0.0' })
const infoOffline = await checkerOffline.check(true)
check('网络失败时不抛错，返回 error 文本', Boolean(infoOffline.error), infoOffline.error)
check('网络失败时 updateAvailable=false', infoOffline.updateAvailable === false)

const checkerDisabled = createVersionChecker({ repo: 'x/y', currentVersion: () => '1.0.0', enabled: false })
const infoDisabled = await checkerDisabled.check(true)
check('checkUpdates=false 时 disabled=true 且不联网', infoDisabled.disabled === true && fetchCalls >= 1)

globalThis.fetch = realFetch

// ---------------------------------------------------------------- 路由级

// 用假 ctx 拿到 webServer handler，起一个真实 HTTP 端口来发请求。
process.env.DSH_PROFILE_DIR = profileWith('github:100759/dsh-fuulea-import')
process.env.DSH_PROFILE = 'desktop'

const plugin = await import(pathToFileURL(path.join(root, 'index.js')).href)
let handler = null
const fakeCtx = {
  effect: (fn) => { const r = fn(); return () => {} },
  webServer: { register: (opts) => { handler = opts.handler; return () => {} } },
  tools: { register: () => () => {} },
  get: () => undefined,
}

check('index.js 导出 apply', typeof plugin.apply === 'function')
plugin.apply(fakeCtx, {})
check('注册了 HTTP 前缀处理器', typeof handler === 'function')

const server = http.createServer((req, res) => handler(req, res))
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
const base = `http://127.0.0.1:${port}/fuulea-import/api`

async function call(method, p) {
  const res = await realFetch(base + p, { method, headers: method === 'POST' ? { 'Content-Type': 'application/json' } : undefined, body: method === 'POST' ? '{}' : undefined })
  return { status: res.status, body: await res.json() }
}

// 让版本检查走假 GitHub（此时 plugin 已加载，fetch 在调用时才读取）。
stubGitHub('ok')
const uc = await call('GET', '/update-check')
check('GET /update-check 返回 200', uc.status === 200, 'status=' + uc.status)
check('返回 ok=true', uc.body.ok === true)
check('返回当前版本字段', typeof uc.body.version === 'string' && uc.body.version.length > 0, uc.body.version)
check('返回 latest', uc.body.latest === '9.9.9', String(uc.body.latest))
check('返回 updateAvailable', uc.body.updateAvailable === true)
check('返回 source=github', uc.body.source === 'github', String(uc.body.source))
check('返回 repoUrl', String(uc.body.repoUrl || '').includes('dsh-fuulea-import'))

// POST /update 的三条拦截分支：都必须给出可读原因，且不能真的执行 pnpm。
globalThis.fetch = realFetch

const linkProfile = profileWith('link:/tmp/whatever')
process.env.DSH_PROFILE_DIR = linkProfile
const linkRes = await call('POST', '/update')
check('link 安装时 POST /update 被拦下', linkRes.status === 400, 'status=' + linkRes.status)
check('link 安装给出可读原因', String(linkRes.body.error || '').includes('本地目录方式安装'), String(linkRes.body.error))

const regProfile = profileWith('1.0.0')
process.env.DSH_PROFILE_DIR = regProfile
const regRes = await call('POST', '/update')
check('registry 安装时 POST /update 被拦下', regRes.status === 400, 'status=' + regRes.status)
check('registry 安装提示手动命令', String(regRes.body.error || '').includes('dsh plugin --profile'), String(regRes.body.error))

process.env.DSH_PROFILE_DIR = profileWith('github:100759/dsh-fuulea-import')
const offCtx = {
  effect: (fn) => { fn() },
  webServer: { register: (opts) => { handler = opts.handler } },
  tools: { register: () => () => {} },
  get: () => undefined,
}
plugin.apply(offCtx, { checkUpdates: false })
const server2 = http.createServer((req, res) => handler(req, res))
await new Promise((resolve) => server2.listen(0, '127.0.0.1', resolve))
const base2 = `http://127.0.0.1:${server2.address().port}/fuulea-import/api`
const offCheck = await (await realFetch(base2 + '/update-check')).json()
check('checkUpdates=false 时 update-check 报 disabled', offCheck.disabled === true)
const offUpdate = await (await realFetch(base2 + '/update', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }))
const offUpdateBody = await offUpdate.json()
check('checkUpdates=false 时 POST /update 被拦下', offUpdate.status === 400, 'status=' + offUpdate.status)
check('关闭联网检查时给出可读原因', String(offUpdateBody.error || '').includes('checkUpdates=false'), String(offUpdateBody.error))

server.close()
server2.close()
fs.rmSync(tmp, { recursive: true, force: true })

console.log('\n' + (failures ? `✗ ${failures} 项失败` : '✓ 全部通过'))
process.exit(failures ? 1 : 0)
