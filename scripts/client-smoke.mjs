// Client 半边本地冒烟测试（不依赖浏览器）：极简 React 替身 + 渲染循环，
// 验证「打开工作台 → 加载任务 → 拖入文件解析 → 填充 → 预检 → 导入 → 回执」路径不抛异常，
// 并断言样式表已随页面挂载（这是 v1.0.0 的真实缺陷：定义了样式却没挂上去）。
//
// 用法：node scripts/client-smoke.mjs
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const clientPath = path.join(root, 'client.js')

let failures = 0
function check(label, ok, extra = '') {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`)
}

// ---------------------------------------------------------------- 极简 React

let currentInstance = null
let dirty = false
const pendingEffects = []
const instances = new Map()

function nameOf(type) {
  return (type && (type.displayName || type.name)) || 'anonymous'
}

function getInstance(key) {
  let instance = instances.get(key)
  if (!instance) {
    instance = { key, hooks: [], index: 0, ranEffects: new Set() }
    instances.set(key, instance)
  }
  return instance
}

const React = {
  createElement(type, props, ...children) {
    const next = Object.assign({}, props)
    if (children.length) next.children = children.length === 1 ? children[0] : children
    return { $$el: true, type, props: next }
  },
  useState(initial) {
    const inst = currentInstance
    const index = inst.index++
    if (!(index in inst.hooks)) inst.hooks[index] = typeof initial === 'function' ? initial() : initial
    const setter = (value) => {
      const prev = inst.hooks[index]
      const next = typeof value === 'function' ? value(prev) : value
      if (!Object.is(prev, next)) { inst.hooks[index] = next; dirty = true }
    }
    return [inst.hooks[index], setter]
  },
  useEffect(fn) {
    const inst = currentInstance
    const index = inst.index++
    if (!inst.ranEffects.has(index)) pendingEffects.push({ inst, index, fn })
  },
  useRef(initial) {
    const inst = currentInstance
    const index = inst.index++
    if (!(index in inst.hooks)) inst.hooks[index] = { current: initial }
    return inst.hooks[index]
  },
}

// ---------------------------------------------------------------- 渲染

function renderNode(node, pathKey) {
  if (node === null || node === undefined || typeof node === 'boolean') return null
  if (typeof node === 'string' || typeof node === 'number') return { text: String(node) }
  if (Array.isArray(node)) {
    return { children: node.map((c, i) => renderNode(c, pathKey + '.' + i)).filter(Boolean) }
  }
  if (!node.$$el) throw new Error('未知节点：' + JSON.stringify(node))
  const { type, props } = node
  if (typeof type === 'function') {
    const key = pathKey + '<' + nameOf(type) + '>'
    const inst = getInstance(key)
    const prev = currentInstance
    currentInstance = inst
    inst.index = 0
    let out
    try { out = type(props || {}) } finally { currentInstance = prev }
    return renderNode(out, key)
  }
  if (typeof type === 'string') {
    const children = props && props.children
    return {
      type,
      props: props || {},
      children: children === undefined ? [] : [].concat(renderNode(children, pathKey + '>' + type)).filter(Boolean),
    }
  }
  throw new Error('未知元素类型：' + String(type))
}

function collect(node, out = []) {
  if (!node) return out
  if (Array.isArray(node)) { for (const c of node) collect(c, out); return out }
  if (node.text !== undefined) { out.push({ text: node.text }); return out }
  out.push(node)
  if (node.children) collect(node.children, out)
  return out
}

function textOf(node) {
  return collect(node).filter((i) => i.text !== undefined).map((i) => i.text).join(' ')
}

function findAll(node, pred) {
  return collect(node).filter((i) => i.type !== undefined && pred(i))
}

function findButton(node, text) {
  return findAll(node, (i) => i.type === 'button' && textOf(i).includes(text))
}

// ---------------------------------------------------------------- 环境替身

const response = (payload, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => payload,
})

const binding = {
  alias: 'lyyz', baseUrl: 'https://lyyz.fuulea.com', siteTitle: '福建省龙岩第一中学',
  username: 'lyyzadmin', maskedUsername: 'lyy***n',
  boundAt: '2026-10-20T02:00:00.000Z', lastUsedAt: '2026-10-24T02:00:00.000Z', hasPassword: true,
}

const calls = { defaults: 0, tasks: 0, parse: 0, analyze: 0, batch: 0, fill: 0, precheck: 0, import: 0, receipt: 0, bind: 0, updateCheck: 0, update: 0 }

// 版本检查的模拟状态：初始有新版可更新；POST /update 之后变成「已装好、待重启」。
const versionState = { latest: '1.1.0', installed: '1.0.0', updated: false }

async function fakeFetch(url, init) {
  const pathname = String(url)
  const method = String((init && init.method) || 'GET').toUpperCase()
  // 注意顺序：/update-check 也包含 "/update"，必须先判断。
  if (pathname.includes('/update-check')) {
    calls.updateCheck++
    return response({
      ok: true,
      version: versionState.installed,
      runningVersion: '1.0.0',
      repo: '100759/dsh-fuulea-import',
      repoUrl: 'https://github.com/100759/dsh-fuulea-import',
      latest: versionState.latest,
      updateAvailable: versionState.installed !== versionState.latest,
      restartPending: versionState.updated,
      source: 'github',
      spec: 'github:100759/dsh-fuulea-import',
      disabled: false,
      checkedAt: 1761700000000,
      error: '',
      updating: false,
    })
  }
  if (pathname.includes('/update') && method === 'POST') {
    calls.update++
    versionState.installed = versionState.latest
    versionState.updated = true
    return response({
      ok: true,
      from: '1.0.0',
      to: versionState.latest,
      latest: versionState.latest,
      restartRequired: true,
      message: '已更新到 ' + versionState.latest + '，重启 DeepSeek Harness 后生效',
    })
  }
  if (pathname.includes('/defaults')) {
    calls.defaults++
    return response({
      ok: true, version: '1.0.0',
      defaults: {
        school: 'lyyz', schoolTitle: '福建省龙岩第一中学',
        credentialsFile: '/tmp/.credentials', credentialsFileExists: true,
        bindingsFile: '/tmp/bindings.json', outputDir: '/tmp/out',
        bindings: [binding], lastSchool: 'lyyz',
      },
    })
  }
  if (pathname.includes('/tasks')) {
    calls.tasks++
    return response({
      ok: true, groupTotal: 2, taskTotal: 3,
      groups: [
        { exam: '高一期中考试', subject: '语文', subjectId: 1, taskId: '17100521', className: '2024级19班', gradeId: 2434, title: '高一期中考试 语文', taskCount: 2 },
        { exam: '高一第1次月考', subject: '语文', subjectId: 1, taskId: '17118088', className: '2024级19班', gradeId: 2434, title: '高一第1次月考 语文', taskCount: 1 },
        { exam: '10月26日任务', subject: '历史', subjectId: 8, taskId: '17643391', className: 'student01等3人 - 靶向班', gradeId: 2434, title: '10月26日任务', taskCount: 1 },
      ],
      subjects: [
        { name: '语文', id: 1, count: 2 },
        { name: '历史', id: 8, count: 1 },
      ],
      bindings: [binding],
    })
  }
  if (pathname.includes('/batch-scan')) {
    calls.batch = (calls.batch || 0) + 1
    return response({
      ok: true, taskId: '17643391', total: 3, usableCount: 1, skippedCount: 2,
      rosterCount: 3, templateQuestionCount: 5,
      files: [
        { name: '历史.xlsx', usable: true, reason: '', students: 3, questionCount: 5, matched: 3, total: 3 },
        { name: '说明.docx', usable: false, reason: '不是表格文件', students: 0, questionCount: 0, matched: 0, total: 0 },
        { name: '旧版.xlsx', usable: false, reason: '学生都不在模板的班级对照表里', students: 2, questionCount: 5, matched: 0, total: 2 },
      ],
    })
  }
  if (pathname.includes('/analyze')) {
    calls.analyze++
    return response({
      ok: true, taskId: '17100521', sourceFile: '语文.xlsx',
      sourceHeaders: ['1', '2', '3', '4.1', '4.2'], targetHeaders: ['1', '2', '3', '4'],
      students: 3, ruleFillable: false, aiUsed: true, aiError: '',
      mappings: [
        { sourceQno: '1', targetQno: '1', kind: 'exact', needsConfirm: false },
        { sourceQno: '2', targetQno: '2', kind: 'exact', needsConfirm: false },
        { sourceQno: '3', targetQno: '3', kind: 'exact', needsConfirm: false },
        { sourceQno: '4.1', targetQno: '4', kind: 'sub-merge', needsConfirm: true },
        { sourceQno: '4.2', targetQno: '4', kind: 'sub-merge', needsConfirm: true },
      ],
      unfillable: [], missingInSource: [], notes: ['源表小题 4.1 需要合并进模板大题 4（程序会求和）'],
      plan: [
        { targetIndex: 0, targetQno: '1', sources: [0], op: 'copy' },
        { targetIndex: 1, targetQno: '2', sources: [1], op: 'copy' },
        { targetIndex: 2, targetQno: '3', sources: [2], op: 'copy' },
        { targetIndex: 3, targetQno: '4', sources: [3, 4], op: 'sum' },
      ],
      planWarnings: [], fillable: true, needsConfirm: true,
    })
  }
  if (pathname.includes('/parse')) {
    calls.parse++
    return response({ ok: true, files: [{ name: '语文.xlsx', subjectGuess: '语文', count: 3, questionCount: 5 }] })
  }
  if (pathname.includes('/fill')) {
    calls.fill++
    return response({
      ok: true, taskId: '17100521', sourceFile: '语文.xlsx', sheet: 'Sheet1',
      students: 3, skipped: 1, questionCount: 5, blankCells: 0, extraInScores: [],
      rosterCount: 3, templateQuestionCount: 5, outFile: '/tmp/out/语文-任务17100521-语文.xlsx',
      filled: { name: '语文-任务17100521-语文.xlsx', bytes: 4096, data: 'UEsDBA==' },
    })
  }
  if (pathname.includes('/precheck')) {
    calls.precheck++
    return response({ ok: true, students: 3, qcols: 5, empty_cells: 0, blank_rows: [], partial_rows: [], extra_in_scores: [], missing_in_map: [], no_subscores: false, ok: true })
  }
  if (pathname.includes('/import')) {
    calls.import++
    return response({ ok: true, submitted: true, taskId: '17100521', file: '语文-任务17100521-语文.xlsx' })
  }
  if (pathname.includes('/receipt')) {
    calls.receipt++
    return response({ ok: true, count: 1, successCount: 1, failCount: 0, matched: [{ createAt: '2026-10-26T02:00:00+00:00', title: '导入任务数据', file: '语文-任务17100521-语文.xlsx', success: true, students: 3, error: '' }] })
  }
  if (pathname.includes('/bind')) {
    calls.bind++
    return response({ ok: true, binding, bindings: [binding], lastSchool: 'lyyz' })
  }
  return response({ ok: false, error: 'unexpected ' + pathname }, 404)
}

// ---------------------------------------------------------------- 加载模块

const sandbox = {
  window: { __ModuleLoader__: { load(def) { sandbox.__def = def } } },
  fetch: fakeFetch,
  FileReader: class {
    readAsDataURL() { this.onload && this.onload() }
    get result() { return 'data:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;base64,UEsDBA==' }
  },
  console,
  setTimeout, clearTimeout, Date, Math, JSON, Promise, Object, Array, String, Number, Boolean, Error, RegExp,
}
sandbox.globalThis = sandbox
vm.createContext(sandbox)
vm.runInContext(fs.readFileSync(clientPath, 'utf8'), sandbox, { filename: 'client.js' })

check('client.js 调用 ModuleLoader.load', Boolean(sandbox.__def))
const def = sandbox.__def
check('模块 id 为 dsh-fuulea-import', def && def.id === 'dsh-fuulea-import', def && def.id)

const registrations = []
const ctx = {
  slots: {
    inject(name, cb) { cb() },
    register(options, component) { registrations.push({ options, component }); return () => {} },
  },
}
const plugin = def.factory((id) => {
  if (id === 'react') return React
  throw new Error('未预期的 require：' + id)
})
check('factory 返回 apply', typeof plugin.apply === 'function')
plugin.apply(ctx)
check('注册了两个槽位（侧边栏 + 主面板）', registrations.length === 2, String(registrations.length))
const sidebar = registrations.find((r) => r.options.name === 'sidebar.panellist')
const main = registrations.find((r) => r.options.name === 'main')
check('侧边栏 id=fuulea-import', sidebar && sidebar.options.id === 'fuulea-import')
check('侧边栏 label=导入成绩', sidebar && typeof sidebar.options.label === 'function' && sidebar.options.label() === '导入成绩')
check('主面板 key=fuulea-import', main && main.options.key === 'fuulea-import')

// ---------------------------------------------------------------- 渲染循环

const Page = main.component

async function flush(times = 6) {
  for (let i = 0; i < times; i++) {
    await new Promise((r) => setTimeout(r, 0))
    while (pendingEffects.length) {
      const { inst, index, fn } = pendingEffects.shift()
      inst.ranEffects.add(index)
      const cleanup = fn()
      if (typeof cleanup === 'function') inst.cleanups = (inst.cleanups || []).concat(cleanup)
    }
  }
}

let tree = null
try {
  tree = renderNode(React.createElement(Page, {}), 'root')
  check('首次渲染无异常', true)
} catch (e) {
  check('首次渲染无异常', false, e.message)
  console.error(e)
  process.exit(1)
}
await flush()
tree = renderNode(React.createElement(Page, {}), 'root')
await flush()

// 关键断言：样式表必须随页面挂载（v1.0.0 的缺陷）
const styles = findAll(tree, (i) => i.type === 'style')
check('页面内挂载了 <style>（修复样式丢失）', styles.length === 1, '找到 ' + styles.length)
const css = styles.length ? String(styles[0].props.children || '') : ''
check('样式含 .fli-page 规则', css.includes('.fli-page{'))
check('样式含 .fli-dropzone 规则', css.includes('.fli-dropzone'))
check('未向 document 写样式（无 document 依赖）', !css.includes('document.createElement'))

check('渲染出「导入成绩」标题', textOf(tree).includes('导入成绩'))
check('渲染出「加载任务」按钮', findButton(tree, '加载任务').length === 1)
check('渲染出「解析文件」按钮', findButton(tree, '解析文件').length === 1)
check('渲染出拖放区文案', textOf(tree).includes('拖入成绩文件到这里'))
check('渲染出「＋ 绑定学校」按钮', findButton(tree, '绑定学校').length === 1)

// 点「加载任务」
const loadBtn = findButton(tree, '加载任务')[0]
loadBtn.props.onClick()
await flush()
tree = renderNode(React.createElement(Page, {}), 'root')
await flush()
check('加载任务调用了 /tasks', calls.tasks >= 1, 'calls=' + calls.tasks)
check('任务下拉出现考试×学科选项', textOf(tree).includes('高一期中考试 · 语文'))

// 展开绑定表单
findButton(tree, '绑定学校')[0].props.onClick()
await flush()
tree = renderNode(React.createElement(Page, {}), 'root')
await flush()
check('展开绑定表单后出现「验证并绑定」', findButton(tree, '验证并绑定').length === 1)

// 任务搜索：输入关键词后下拉只剩匹配项
const searchBox = findAll(tree, (i) => i.type === 'input' && String(i.props.placeholder || '').includes('任务名')).slice(-1)[0]
check('渲染出任务搜索框', Boolean(searchBox))
if (searchBox) {
  searchBox.props.onChange({ target: { value: '月考' } })
  await flush()
  tree = renderNode(React.createElement(Page, {}), 'root')
  await flush()
  const opts = findAll(tree, (i) => i.type === 'option').map((o) => textOf(o))
  const hasMonth = opts.some((t) => t.includes('第1次月考'))
  const hasMidterm = opts.some((t) => t.includes('期中考试'))
  check('搜索「月考」只留匹配项', hasMonth && !hasMidterm, opts.join(' | ').slice(0, 120))
}

// 科目筛选：先清空搜索词，再选「历史」，应只剩历史任务
if (searchBox) {
  searchBox.props.onChange({ target: { value: '' } })
  await flush()
  tree = renderNode(React.createElement(Page, {}), 'root')
  await flush()
}
const subjectSelect = findAll(tree, (i) => i.type === 'select' && textOf(i).includes('全部科目'))[0]
check('渲染出科目筛选下拉', Boolean(subjectSelect))
if (subjectSelect) {
  const subjOpts = findAll(tree, (i) => i.type === 'option').map((o) => textOf(o))
  check('科目下拉含语文/历史', subjOpts.some((t) => t.includes('语文')) && subjOpts.some((t) => t.includes('历史')), subjOpts.join(' | ').slice(0, 120))
  subjectSelect.props.onChange({ target: { value: '历史' } })
  await flush()
  tree = renderNode(React.createElement(Page, {}), 'root')
  await flush()
  const opts = findAll(tree, (i) => i.type === 'option').map((o) => textOf(o))
  check('选「历史」只剩历史任务', opts.some((t) => t.includes('10月26日')) && !opts.some((t) => t.includes('期中考试')), opts.join(' | ').slice(0, 120))
}

// 选中目标任务（后续填充/分析都要求已选任务）
const taskSelect = findAll(tree, (i) => i.type === 'select' && (textOf(i).includes('请选择任务') || textOf(i).includes('没有匹配')))[0]
check('渲染出任务下拉', Boolean(taskSelect))
if (taskSelect) {
  taskSelect.props.onChange({ target: { value: '17643391' } })
  await flush()
  tree = renderNode(React.createElement(Page, {}), 'root')
  await flush()
  check('已选中任务', textOf(tree).includes('10月26日任务'))
}

// 端到端：选文件 → 解析（回归「点了没反应」）
const fileInput = findAll(tree, (i) => i.type === 'input' && i.props.type === 'file')[0]
check('渲染出文件选择 input', Boolean(fileInput))
if (fileInput) {
  fileInput.props.onChange({ target: { files: [{ name: '语文.xlsx', size: 9536 }], value: '' } })
  await flush(12)
  tree = renderNode(React.createElement(Page, {}), 'root')
  await flush()
  check('选完文件后显示「已读取」', textOf(tree).includes('已读取'))

  const parseBtn = findButton(tree, '解析文件')[0]
  check('「解析文件」按钮可用', parseBtn && !parseBtn.props.disabled)
  if (parseBtn) {
    parseBtn.props.onClick()
    await flush(15)
    tree = renderNode(React.createElement(Page, {}), 'root')
    await flush()
    check('点「解析文件」真的发出 /parse', calls.parse >= 1, 'calls=' + calls.parse)
    check('解析后显示人数与题数', textOf(tree).includes('3 人') && textOf(tree).includes('5 题'))
  }
}

// 题号映射：分析 → 未确认不能填 → 勾选后可填
const analyzeBtn = findButton(tree, '分析题号映射')[0]
check('渲染出「分析题号映射」按钮', Boolean(analyzeBtn))
if (analyzeBtn) {
  analyzeBtn.props.onClick()
  await flush(15)
  tree = renderNode(React.createElement(Page, {}), 'root')
  await flush()
  check('分析调用了 /analyze', calls.analyze >= 1, 'calls=' + calls.analyze)
  check('显示「题号映射」卡片', textOf(tree).includes('题号映射'))
  check('显示小题合并说明', textOf(tree).includes('小题合并'))
  check('显示确认勾选框', textOf(tree).includes('我已核对上述题号对应关系'))

  const fillBtnBefore = findButton(tree, '填充模板')[0]
  fillBtnBefore.props.onClick()
  await flush(10)
  tree = renderNode(React.createElement(Page, {}), 'root')
  await flush()
  check('未确认时填充被拦下', calls.fill === 0 && textOf(tree).includes('需要你确认'), 'fill=' + calls.fill)

  const checkbox = findAll(tree, (i) => i.type === 'input' && i.props.type === 'checkbox')[0]
  check('找到确认勾选框', Boolean(checkbox))
  if (checkbox) {
    checkbox.props.onChange({ target: { checked: true } })
    await flush(10)
    tree = renderNode(React.createElement(Page, {}), 'root')
    await flush()
    const fillBtn = findButton(tree, '填充模板')[0]
    fillBtn.props.onClick()
    await flush(15)
    tree = renderNode(React.createElement(Page, {}), 'root')
    await flush()
    check('确认后填充被调用', calls.fill >= 1, 'fill=' + calls.fill)
  }
}

// 批量体检：一堆文件里挑出能用的
const batchBtn = findButton(tree, '批量体检')[0]
check('渲染出「批量体检」按钮', Boolean(batchBtn))
if (batchBtn) {
  batchBtn.props.onClick()
  await flush(15)
  tree = renderNode(React.createElement(Page, {}), 'root')
  await flush()
  check('批量体检调用了 /batch-scan', calls.batch >= 1, 'calls=' + calls.batch)
  check('显示批量体检结果', textOf(tree).includes('批量体检'))
  check('显示可用/跳过统计', textOf(tree).includes('可用 1') && textOf(tree).includes('跳过 2'))
  check('跳过原因可见', textOf(tree).includes('不是表格文件'))
  check('提供「用这份」入口', textOf(tree).includes('用这份'))
}

// 回执：本次成功时不能显示为失败
const importBtn = findButton(tree, '导入')[0]
check('渲染出「导入」按钮', Boolean(importBtn))
if (importBtn) {
  importBtn.props.onClick()
  await flush(20)
  tree = renderNode(React.createElement(Page, {}), 'root')
  await flush()
  check('导入调用了 /import', calls.import >= 1, 'calls=' + calls.import)
  check('核对回执调用了 /receipt', calls.receipt >= 1, 'calls=' + calls.receipt)
  check('显示「本次导入成功」', textOf(tree).includes('本次导入成功'))
  check('不显示为失败', !textOf(tree).includes('被平台拒收'))
}

// ---------------------------------------------------------------- 版本与更新

check('版本检查调用了 /update-check', calls.updateCheck >= 1, 'calls=' + calls.updateCheck)
const versionBtn = findAll(tree, (i) => i.type === 'button' && String(i.props.className || '').includes('fli-version'))
check('渲染出可点击的版本徽标', versionBtn.length === 1, '找到 ' + versionBtn.length)
check('有新版本时徽标带 --new 样式', versionBtn.length === 1 && String(versionBtn[0].props.className).includes('fli-version--new'))
check('有新版本时徽标出现红点', versionBtn.length === 1 && findAll(versionBtn[0], (i) => String(i.props.className || '').includes('fli-version-dot')).length === 1)
check('徽标显示当前版本 v1.0.0', textOf(versionBtn[0]).includes('v1.0.0'))
check('徽标提示可更新', textOf(versionBtn[0]).includes('可更新'))

// 有新版本时版本面板默认展开（不需要先点徽标）
check('自动展开版本面板', textOf(tree).includes('有新版本可用：v1.1.0'))
check('面板显示安装来源', textOf(tree).includes('GitHub 安装'))
check('面板有「立即更新」按钮', findButton(tree, '立即更新').length === 1)
check('面板有「检查更新」按钮', findButton(tree, '检查更新').length === 1)

// 点「立即更新」：调用 POST /update，并提示重启
const updateBtn = findButton(tree, '立即更新')[0]
if (updateBtn) {
  check('立即更新按钮可用（GitHub 源安装）', updateBtn.props.disabled === false)
  updateBtn.props.onClick()
  await flush(20)
  tree = renderNode(React.createElement(Page, {}), 'root')
  await flush()
  check('调用了 POST /update', calls.update === 1, 'calls=' + calls.update)
  check('更新后提示重启 Harness', textOf(tree).includes('重启'))
  check('更新后红点消失（restartPending）', textOf(tree).includes('已更新到 v1.1.0'))
}

console.log('\n' + (failures ? `✗ ${failures} 项失败` : '✓ 全部通过'))
process.exit(failures ? 1 : 0)