// 辅立码课导入成绩工作台 —— Host 半边。
//
// 职责：
//   1. 注册本机 HTTP 路由 /fuulea-import/api/*，供工作台页面（Client 半边）调用；
//   2. 学校「绑定」：账号密码只在本机保存一次，之后打开页面直接登录（可切换多所学校）；
//   3. 登录学校站点，拉取「已发布的考试×学科任务」，下载全通教育「班级对照表」模板；
//   4. 解析源成绩文件、调用 Python 填充模板 + 传前预检；
//   5. 导入成绩（source=qt，后台异步），核对 inbox 回执。
//
// 范围（第一版）：只做「平常考试」——任务已在平台发布；不做 绑卷/发布/阅卷收尾。
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawn, spawnSync } from 'node:child_process'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'
import { FuuleaApi, resolveBaseUrl, readCredentialsFile, DEFAULT_CREDENTIALS_FILE } from './lib/api.js'
import { BindingStore, DEFAULT_BINDINGS_FILE, aliasOf, isValidAlias, mask } from './lib/bindings.js'
import { parseXlsx, parseCsv, guessSubjectFromName, SUBJECT_ORDER } from './lib/parse.js'
import { parseTemplate } from './lib/template.js'
import { ruleAnalyze, buildFillPlan, normalizeQno } from './lib/qmap.js'
import { aiSuggestMappings } from './lib/ai.js'

export const name = 'fuulea-import'
export const inject = ['webServer', 'tools', 'llm', 'agentDefaultModel']

const PACKAGE_NAME = 'dsh-fuulea-import'
const PACKAGE_DIR = path.dirname(fileURLToPath(import.meta.url))
const VERSION = readLocalVersion(PACKAGE_DIR) || '1.0.0'
const ROUTE_PREFIX = '/fuulea-import/api'
const MAX_CACHED_CLIENTS = 24

const DEFAULT_CONFIG = {
  defaultSchool: 'lyyz',
  credentialsFile: DEFAULT_CREDENTIALS_FILE,
  bindingsFile: DEFAULT_BINDINGS_FILE,
  outputDir: '',
  pythonPath: 'python3',
  requestTimeoutMs: 90_000,
}

export function apply(ctx, rawConfig) {
  const config = { ...DEFAULT_CONFIG, ...(rawConfig || {}) }
  const clients = new Map()
  const bindings = new BindingStore(
    config.bindingsFile || process.env.FUULEA_IMPORT_BINDINGS_FILE || DEFAULT_BINDINGS_FILE,
  )
  // 复用「教学数据报告」工作台已保存的学校，老师换工作台不用再输一次账号。
  // 本工作台的绑定仍独立保存；共享源只读，解除绑定不会影响报告工作台。
  const reportBindings = new BindingStore(
    config.reportBindingsFile || path.join(os.homedir(), '.fuulea-report', 'bindings.json'),
  )

  const state = {
    ctx,
    config,
    bindings,
    reportBindings,
    clients,
    outputRoot: () => {
      const configured = config.outputDir || process.env.FUULEA_IMPORT_DIR || ''
      if (configured) return path.resolve(configured)
      return path.join(os.homedir(), '.fuulea-import', 'output')
    },
    scriptsDir: () => path.join(PACKAGE_DIR, 'scripts'),
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: ROUTE_PREFIX,
    handler: (req, res) => handle(state, req, res),
  }))

  ctx.effect(() => ctx.tools.register(importTool(state)))

  ctx.effect(() => () => {
    // 无需要清理的子进程（Python 调用都是短任务）
  })
}

// ---------------------------------------------------------------- 路由

const ROUTES = {
  'GET defaults': async (state) => {
    const list = listBindings(state)
    const lastSchool = state.bindings.defaultSchool() || state.reportBindings.defaultSchool()
    const school = lastSchool || state.config.defaultSchool
    const bound = list.find((item) => item.alias === school) || null
    return {
      ok: true,
      version: VERSION,
      defaults: {
        school,
        schoolTitle: bound ? bound.siteTitle : '',
        credentialsFile: state.config.credentialsFile,
        credentialsFileExists: fs.existsSync(state.config.credentialsFile),
        bindingsFile: state.bindings.file,
        outputDir: state.outputRoot(),
        bindings: list,
        lastSchool,
      },
    }
  },

  'POST bind': async (state, body) => {
    const params = body || {}
    const alias = requireAlias(params.school)
    const username = String(params.username || '').trim()
    const password = String(params.password || '')
    if (!username) throw new Error('请填写账号')
    if (!password) throw new Error('请填写密码')

    const baseUrl = resolveBaseUrl(alias)
    const api = new FuuleaApi({ baseUrl, username, password })
    let user
    try {
      user = await api.login()
    } catch (e) {
      throw new Error(`绑定「${alias}」失败：${e && e.message ? e.message : e}`)
    }
    const record = state.bindings.save({
      alias,
      baseUrl,
      siteTitle: (user && user.siteTitle) || '',
      username,
      password,
      token: api.token,
      tokenExpiresAt: api.expiresAt,
      user: pickUser(user),
    })
    invalidateClients(state, baseUrl)
    return {
      ok: true,
      binding: mask(record),
      bindings: listBindings(state),
      lastSchool: state.bindings.defaultSchool(),
    }
  },

  'POST unbind': async (state, body) => {
    const alias = requireAlias((body || {}).school)
    const removed = state.bindings.remove(alias)
    invalidateClients(state, resolveBaseUrl(alias))
    return {
      ok: true,
      removed,
      bindings: listBindings(state),
      lastSchool: state.bindings.defaultSchool(),
    }
  },

  'POST tasks': async (state, body) => {
    const params = body || {}
    const alias = requireAlias(params.school || state.bindings.defaultSchool() || state.config.defaultSchool)
    const { client, source } = clientFor(state, alias, params)
    const result = await fetchTaskGroups(state, client, alias, params)
    persistBinding(state, alias, client, source)
    return { ok: true, ...result, bindings: listBindings(state) }
  },

  'POST template': async (state, body) => {
    const params = body || {}
    const alias = requireAlias(params.school || state.bindings.defaultSchool() || state.config.defaultSchool)
    const taskId = String(params.taskId || '').trim()
    if (!taskId || !/^\d+$/.test(taskId)) throw new Error('请选择有效的任务（taskId）')
    const { client } = clientFor(state, alias, params)
    const buf = await client.getBinary(`/v2/tasks/${taskId}/class-list/`)
    const info = parseTemplate(buf)
    return { ok: true, taskId, ...info }
  },

  'POST parse': async (state, body) => {
    const params = body || {}
    const files = Array.isArray(params.files) ? params.files : []
    const parsed = []
    for (const f of files) {
      const name = String(f.name || 'file')
      const data = String(f.data || '')
      const buf = Buffer.from(data, 'base64')
      if (buf.length === 0) { parsed.push({ name, error: '空文件' }); continue }
      parsed.push(parseSourceBuffer(state, name, buf))
    }
    return { ok: true, files: parsed }
  },

  // 批量体检：拖进来的一堆文件（含 zip）里，哪些能用于当前任务。
  // 只读：不下模板以外的请求、不写任何数据。
  'POST batch-scan': async (state, body) => {
    const params = body || {}
    const alias = requireAlias(params.school || state.bindings.defaultSchool() || state.config.defaultSchool)
    const taskId = String(params.taskId || '').trim()
    if (!taskId || !/^\d+$/.test(taskId)) throw new Error('请先选择要导入的任务（批量体检需要模板名单来判定可用性）')

    const { client } = clientFor(state, alias, params)
    const tplBuf = await client.getBinary(`/v2/tasks/${taskId}/class-list/`)
    const tpl = parseTemplate(tplBuf)

    // 展开 zip → 得到扁平的文件清单
    const entries = []
    for (const f of Array.isArray(params.files) ? params.files : []) {
      const name = String(f.name || 'file')
      const buf = Buffer.from(String(f.data || ''), 'base64')
      if (!buf.length) continue
      if (/\.zip$/i.test(name)) {
        for (const m of unzipMembers(state, buf)) {
          entries.push({ name: m.name, buffer: m.buffer, size: m.buffer.length, fromZip: name })
        }
      } else {
        entries.push({ name, buffer: buf, size: buf.length })
      }
    }

    // 去重：同一文件名 + 同样大小视为重复（例如用户既拖了 zip 又拖了里面单个文件）
    const seenKey = new Set()
    const deduped = []
    for (const e of entries) {
      const key = `${e.name}::${e.size}`
      if (seenKey.has(key)) continue
      seenKey.add(key)
      deduped.push(e)
    }

    const files = evaluateFiles(state, tpl, deduped)
    const usable = files.filter((f) => f.usable)
    const skipped = files.filter((f) => !f.usable)
    return {
      ok: true,
      taskId,
      total: files.length,
      usableCount: usable.length,
      skippedCount: skipped.length,
      rosterCount: tpl.rosterCount,
      templateQuestionCount: tpl.questionCount,
      files,
    }
  },

  // 题号映射分析：规则优先，歧义才请 AI；AI 只给映射建议，不产生任何分值。
  // 无法精确还原的（如源表只有大题总分、模板要小题）一律标 unfillable，不自动填。
  'POST analyze': async (state, body) => {
    const params = body || {}
    const alias = requireAlias(params.school || state.bindings.defaultSchool() || state.config.defaultSchool)
    const taskId = String(params.taskId || '').trim()
    if (!taskId || !/^\d+$/.test(taskId)) throw new Error('请选择有效的任务（taskId）')

    const { client } = clientFor(state, alias, params)
    const tplBuf = await client.getBinary(`/v2/tasks/${taskId}/class-list/`)
    const tpl = parseTemplate(tplBuf)

    const srcName = String((params.sourceFile && params.sourceFile.name) || 'source')
    const srcBuf = Buffer.from(String((params.sourceFile && params.sourceFile.data) || ''), 'base64')
    const srcParsed = parseSourceBuffer(state, srcName, srcBuf, params.sourceSheet)
    const sheet = pickBestSheet(srcParsed)
    if (!sheet || !sheet.students || !sheet.students.length) {
      throw new Error('源表里没解析出学生（请确认有姓名列）')
    }
    // 题号一律用「标准化题号」（一→1、四(1)→4.1），原始表头另存一份用于展示。
    const rawSourceHeaders = (sheet.questionCols || []).map((c) => String((sheet.headers || [])[c] ?? '').trim())
    const sourceHeaders = rawSourceHeaders.map((h) => normalizeQno(h) || h)
    const rawTargetHeaders = tpl.questionHeaders
    const targetHeaders = rawTargetHeaders.map((h) => normalizeQno(h) || h)

    const rule = ruleAnalyze(sourceHeaders, targetHeaders)

    let ai = null
    let aiError = ''
    // AI 触发条件（放宽，因为老师给的表结构经常不规范）：
    //   ① 规则判出无法对应（needsAI）
    //   ② 规则只是「按位置猜」的（有 positional 映射，说明题号文本对不上）
    //   ③ 源表与模板题号数量不同（题组/合计列等结构差异）
    const hasPositional = rule.mappings.some((m) => m.kind === 'positional')
    const countDiff = sourceHeaders.length !== targetHeaders.length
    const wantAI = rule.needsAI || hasPositional || countDiff
    if (wantAI) {
      try {
        const sel = state.ctx.agentDefaultModel ? state.ctx.agentDefaultModel.currentSelection() : null
        if (sel && sel.provider && sel.model) {
          ai = await aiSuggestMappings(state.ctx.llm, sel.provider, sel.model, sourceHeaders, targetHeaders, {
            taskTitle: params.taskTitle || '',
            subject: params.subject || '',
          })
        } else {
          aiError = '未取到默认模型，跳过 AI 建议'
        }
      } catch (e) {
        aiError = 'AI 建议失败：' + (e && e.message ? e.message : e)
      }
    }

    const mappings = rule.mappings.slice()
    const unfillable = rule.unfillable.slice()
    // 规则已经明确判定为「冗余合计、应忽略」的题号：AI 不许再把它报成 unmapped 拖垮结果。
    // 规则已明确「应忽略」的源表题号：凡是既不在 mappings 里、也不在 unfillable 里的源表题号，
    // 都是规则主动跳过的（合计列 / 已含在父题里的子题）。AI 不许再把它们报成无法确定。
    const mappedSrc = new Set(rule.mappings.map((m) => String(m.sourceQno)))
    const unfillableSrc = new Set(rule.unfillable.map((u) => String(u.sourceQno)))
    const ignoredByRule = new Set(
      sourceHeaders
        .map((h) => normalizeQno(h) ?? String(h))
        .filter((q) => !mappedSrc.has(q) && !unfillableSrc.has(q)),
    )
    if (ai) {
      const have = new Set(mappings.map((m) => m.sourceQno))
      for (const m of ai.mappings) {
        if (have.has(m.sourceQno) || ignoredByRule.has(String(m.sourceQno))) continue
        mappings.push(m)
        have.add(m.sourceQno)
      }
      for (const u of ai.unmapped) {
        if (ignoredByRule.has(String(u.sourceQno))) continue
        if (unfillable.some((x) => x.sourceQno === u.sourceQno)) continue
        unfillable.push({ sourceQno: u.sourceQno, reason: 'AI 无法确定：' + u.reason })
      }
    }

    const plan = buildFillPlan(mappings, sourceHeaders, targetHeaders)
    const needsConfirm = mappings.some((m) => m.needsConfirm) || unfillable.length > 0
    const fillable = mappings.length > 0 && unfillable.length === 0
      && (plan.warnings || []).length === 0 && (rule.missingInSource || []).length === 0

    return {
      ok: true,
      taskId,
      sourceFile: srcName,
      sourceHeaders,
      targetHeaders,
      rawSourceHeaders,
      rawTargetHeaders,
      students: sheet.count,
      ruleFillable: rule.fillable,
      aiUsed: Boolean(ai),
      aiError,
      mappings,
      unfillable,
      missingInSource: rule.missingInSource || [],
      notes: rule.notes || [],
      plan: plan.plan,
      planWarnings: plan.warnings,
      fillable,
      needsConfirm,
    }
  },

  'POST fill': async (state, body) => {
    const params = body || {}
    const alias = requireAlias(params.school || state.bindings.defaultSchool() || state.config.defaultSchool)
    const taskId = String(params.taskId || '').trim()
    if (!taskId || !/^\d+$/.test(taskId)) throw new Error('请选择有效的任务（taskId）')

    // 1) 下模板
    const { client } = clientFor(state, alias, params)
    const tplBuf = await client.getBinary(`/v2/tasks/${taskId}/class-list/`)
    const tplInfo = parseTemplate(tplBuf)

    // 2) 解析源文件
    const srcName = String((params.sourceFile && params.sourceFile.name) || 'source')
    const srcBuf = Buffer.from(String((params.sourceFile && params.sourceFile.data) || ''), 'base64')
    const srcParsed = parseSourceBuffer(state, srcName, srcBuf, params.sourceSheet)
    const sheet = pickBestSheet(srcParsed)

    // 3) 写临时文件，调 Python 填充
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fli-fill-'))
    const tplPath = path.join(tmpDir, 'template.xlsx')
    fs.writeFileSync(tplPath, tplBuf)
    const outPath = path.join(tmpDir, 'filled.xlsx')
    try {
      // plan 由 /analyze 产出、经人工确认后回传。
      // 没有 plan 时：若源表列数与模板题号列数不同（题组/合计列等），自动先分析一次，
      // 避免直接撞「题数不一致」；分析后仍不可填就明确报原因。
      let plan = Array.isArray(params.plan) && params.plan.length ? params.plan : null
      if (!plan) {
        const srcQn = (sheet.questionCols || []).length
        if (srcQn !== tplInfo.questionCount) {
          const auto = await ROUTES['POST analyze'](state, {
            school: alias,
            taskId,
            taskTitle: params.taskTitle || '',
            subject: params.subject || '',
            sourceFile: { name: srcName, data: srcBuf.toString('base64') },
          })
          if (auto.needsConfirm) {
            throw new Error(
              '题号对应关系需要人工确认后才能填充：' +
              (auto.unfillable && auto.unfillable.length
                ? auto.unfillable.map((u) => '题号' + u.sourceQno + '（' + u.reason + '）').join('；')
                : '请在页面「题号映射」里勾选确认'),
            )
          }
          plan = auto.plan && auto.plan.length ? auto.plan : null
        }
      }
      const result = await runPython(state, 'fill_template.py', {
        template: tplPath,
        out: outPath,
        students: sheet.students || [],
        questionCount: sheet.questionCols.length,
        plan,
      })
      if (result.error) throw new Error(result.detail || result.error)
      // 把结果落到输出目录，供「打开」与后续导入使用
      fs.mkdirSync(state.outputRoot(), { recursive: true })
      const subjectGuess = guessSubjectFromName(srcName) || '科目'
      const filledName = `${subjectGuess}-任务${taskId}-${srcBase(srcName)}.xlsx`
      const finalOut = path.join(state.outputRoot(), filledName)
      fs.copyFileSync(outPath, finalOut)
      const filledBuf = fs.readFileSync(finalOut)
      return {
        ok: true,
        taskId,
        sourceFile: srcName,
        sheet: sheet.name,
        students: result.students,
        skipped: result.skipped,
        questionCount: result.questionCount,
        blankCells: result.blankCells,
        extraInScores: result.extraInScores || [],
        rosterCount: result.rosterCount,
        templateQuestionCount: tplInfo.questionCount,
        outFile: finalOut,
        filled: { name: filledName, bytes: filledBuf.length, data: filledBuf.toString('base64') },
      }
    } finally {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch { /* 忽略 */ }
    }
  },

  'POST precheck': async (state, body) => {
    const params = body || {}
    const data = String((params.filledFile && params.filledFile.data) || '')
    if (!data) throw new Error('缺少待预检的文件')

    // 取该任务的逐题满分，用于「分值上限」校验（平台对越界分值整份拒收）。
    // 拿不到满分时（例如任务没绑试卷）跳过这项，不影响其余检查。
    let maxScores = null
    let maxScoreWarning = ''
    const taskId = String(params.taskId || '').trim()
    if (taskId && /^\d+$/.test(taskId)) {
      try {
        const alias = requireAlias(params.school || state.bindings.defaultSchool() || state.config.defaultSchool)
        const { client } = clientFor(state, alias, params)
        maxScores = await fetchMaxScores(client, taskId)
        if (!maxScores || !Object.keys(maxScores).length) {
          maxScores = null
          maxScoreWarning = '未取到该任务的逐题满分，已跳过分值上限校验'
        }
      } catch (e) {
        maxScores = null
        maxScoreWarning = '读取逐题满分失败（' + (e && e.message ? e.message : e) + '），已跳过分值上限校验'
      }
    } else {
      maxScoreWarning = '未指定任务，已跳过分值上限校验'
    }

    const result = await runPython(state, 'precheck.py', { data, maxScores: maxScores || {} })
    if (result.error) throw new Error(result.error)
    return { ok: true, ...result, maxScoreWarning, maxScoreAvailable: Boolean(maxScores) }
  },

  'POST import': async (state, body) => {
    const params = body || {}
    const alias = requireAlias(params.school || state.bindings.defaultSchool() || state.config.defaultSchool)
    const taskId = String(params.taskId || '').trim()
    if (!taskId || !/^\d+$/.test(taskId)) throw new Error('请选择有效的任务（taskId）')
    const name = String((params.filledFile && params.filledFile.name) || 'filled.xlsx')
    const buf = Buffer.from(String((params.filledFile && params.filledFile.data) || ''), 'base64')
    if (buf.length < 1000 || buf.slice(0, 2).toString('hex') !== '504b') {
      throw new Error('不是有效的 xlsx 文件')
    }
    const { client } = clientFor(state, alias, params)
    const form = new FormData()
    form.append('usernamePrefix', '')
    form.append('source', 'qt')
    form.append('taskId', taskId)
    form.append('file', new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), name)
    const r = await client.postForm('/v2/tasks/import/data/', form)
    if (r.status !== 200) throw new Error('HTTP ' + r.status + ' ' + String(r.text).slice(0, 200))
    const keys = Object.keys(r.json || {})
    if (keys.length) {
      throw new Error('平台返回 ' + keys.length + ' 条问题：' + JSON.stringify(r.json).slice(0, 300))
    }
    return { ok: true, submitted: true, taskId, file: name, at: new Date().toISOString() }
  },

  'POST receipt': async (state, body) => {
    const params = body || {}
    const alias = requireAlias(params.school || state.bindings.defaultSchool() || state.config.defaultSchool)
    const { client } = clientFor(state, alias, params)
    const sinceISO = String(params.sinceISO || '')
    const fileNames = new Set((Array.isArray(params.fileNames) ? params.fileNames : []).map(String))
    const receipts = await fetchReceipts(state, client, sinceISO, fileNames)
    return { ok: true, ...receipts }
  },

  'POST open': async (state, body) => {
    const params = body || {}
    const target = String(params.path || '').trim()
    if (!target) throw new Error('缺少要打开的文件路径')
    const root = path.resolve(state.outputRoot())
    const abs = path.resolve(root, target)
    if (abs !== root && !abs.startsWith(root + path.sep)) {
      throw new Error('只能打开输出目录内的文件')
    }
    if (!fs.existsSync(abs)) throw new Error('文件不存在：' + target)
    const action = params.reveal ? 'reveal' : 'open'
    await openWithSystem(abs, action)
    return { ok: true, path: abs, action }
  },
}

async function handle(state, req, res) {
  const url = new URL(req.url || '/', 'http://localhost')
  if (!url.pathname.startsWith(ROUTE_PREFIX)) return json(res, 404, { ok: false, error: '未知路由' })
  const sub = url.pathname.slice(ROUTE_PREFIX.length).replace(/^\/+/, '')

  try {
    if (req.method === 'GET' && sub === 'file') {
      return serveFile(state, url, res)
    }
    const key = `${req.method} ${sub}`
    const route = ROUTES[key]
    if (!route) return json(res, 404, { ok: false, error: `未知接口 ${key}` })
    const body = req.method === 'POST' ? await readJsonBody(req) : null
    const payload = await withTimeout(route(state, body, url), state.config.requestTimeoutMs, '接口处理超时')
    return json(res, 200, payload)
  } catch (e) {
    return json(res, 400, { ok: false, error: e && e.message ? e.message : String(e) })
  }
}

// ---------------------------------------------------------------- 任务拉取

const SUBJ = SUBJECT_ORDER

/**
 * 拉取「已发布的考试×学科任务」。
 * /v2/tasks/ 默认按账号学科收窄，需要遍历 9 个 subjectId 拿全量；用 gradeId 过滤。
 * 返回按 (exam, subject) 分组，每组给一个代表 taskId（同组合模板相同，任选其一）。
 */
async function fetchTaskGroups(state, client, alias, params) {
  await client.ensureAuth()
  const user = client.user || {}
  const gradeIds = Array.isArray(user.chargedGradeIds) ? user.chargedGradeIds.map(Number) : []
  const gradeId = Number(params.gradeId) || (gradeIds[0] ?? 0)
  if (!gradeId) throw new Error('当前账号没有可用的年级（chargedGradeIds 为空），无法列出任务')

  // 学科 id 列表：从一个考试的 subjects 接口拿（复用技能包做法）
  const subjectIds = await discoverSubjects(client)

  // ⚠️ 三个必踩的坑（2026-10-26 实测，test.fuulea.com）：
  //   1) gradeId 必须带，不带时 /v2/tasks/ 静默返回 0 条（不报错，看起来像"没有任务"）；
  //   2) 不能按 type 过滤。type 是「任务来源」不是「任务分类」：
  //      type=1 周考/考试、2 普通任务、6/7 资料、11/12 其他；
  //      前端「作业」标签只是 type 的展示样式，用 type=2 会漏掉周考/考试类任务。
  //   3) 不能只按「某场考试里出现过的学科」遍历 —— 实测任务会分布在别的学科上
  //      （账号自身 subjectId=8 历史，而考试里只取到 6/7/1/3/2/5），
  //      只遍历那 6 个会漏掉历史任务。所以：先不带 subjectId 拉一遍（拿账号自己的学科），
  //      再按 1..12 把每个学科都补一遍，合并去重。
  const tasks = []
  const seen = new Set()
  const collect = (arr, subjectId, subjectName) => {
    for (const t of arr) {
      const id = String(t.taskId ?? t.id ?? '')
      if (!id || seen.has(id)) continue
      seen.add(id)
      tasks.push({
        taskId: id,
        title: String(t.title || ''),
        className: String(t.classroomName || t.className || ''),
        subjectId: subjectId ?? t.subjectId ?? null,
        subject: subjectName || t.subjectName || '',
        gradeId,
        taskType: t.type,
        deleted: Boolean(t.deletedAt),
        // 时间：优先发布时间，其次截止时间；都没有就用 taskId 当近似（雪花式递增）
        publishedAt: String(t.publishedAt || t.createAt || ''),
        endAt: String(t.endAt || ''),
      })
    }
  }
  const pullAll = async (extra) => {
    let page = 1
    while (page <= 80) {
      const r = await client.get('/v2/tasks/', { ...extra, gradeId, type: 0, page })
      const arr = (r.json && r.json.results) || []
      if (!arr.length) break
      collect(arr, extra.subjectId, extra.__name)
      const count = (r.json && r.json.count) || 0
      if (arr.length < 15 || page * 15 >= count) break
      page += 1
    }
  }

  // ① 不带 subjectId：拿账号自身学科的已发布任务
  await pullAll({})
  // ② 按 1..12 逐学科补齐（学科名从 discoverSubjects 或兜底表取）
  const knownName = new Map(subjectIds.map((s) => [Number(s.id), s.name]))
  const FALLBACK_SUBJECT = { 1: '数学', 2: '化学', 3: '物理', 4: '政治', 5: '生物', 6: '英语', 7: '语文', 8: '历史', 9: '地理' }
  for (let sid = 1; sid <= 12; sid += 1) {
    if (knownName.has(sid)) continue // 上面 ① 已覆盖账号学科，这里补齐其余
    await pullAll({ subjectId: sid, __name: FALLBACK_SUBJECT[sid] || '' })
  }
  // ③ 账号学科若在 discoverSubjects 里也补一次（确保名字正确）
  for (const s of subjectIds) await pullAll({ subjectId: s.id, __name: s.name })

  // 学科名解析：优先 knownName / 兜底表，其次任务自带的 subjectName
  const subjectNameOf = (id, fallback) => {
    const n = Number(id)
    return knownName.get(n) || FALLBACK_SUBJECT[n] || fallback || ''
  }

  // 按 (学科, 标题) 分组：学科用解析出的真实名称，标题作为「考试/任务名」；
  // 同一 (学科, 标题) 下多个班级任务共享同一模板，任选一个 taskId 即可。
  const groups = []
  const groupMap = new Map()
  for (const t of tasks) {
    const subject = subjectNameOf(t.subjectId, t.subject)
    let exam = (t.title || '').trim()
    // 若标题以学科名结尾，去掉它作为考试名（如「…期中考试 语文」→「…期中考试」）
    if (subject && exam.endsWith(subject)) exam = exam.slice(0, -subject.length).trim()
    if (!exam) exam = t.title || '未命名任务'
    const key = subject + '||' + exam
    if (!groupMap.has(key)) {
      const g = {
        exam,
        subject,
        subjectId: t.subjectId,
        taskId: t.taskId,
        className: t.className,
        gradeId: t.gradeId,
        title: t.title,
        taskCount: 1,
        publishedAt: t.publishedAt || '',
        endAt: t.endAt || '',
        sortKey: timeKeyOf(t),
      }
      groupMap.set(key, g)
      groups.push(g)
    } else {
      const g = groupMap.get(key)
      g.taskCount += 1
      // 同一 (学科,标题) 取最新那条的时间做排序依据
      const k = timeKeyOf(t)
      if (k > g.sortKey) { g.sortKey = k; g.publishedAt = t.publishedAt || g.publishedAt; g.endAt = t.endAt || g.endAt }
    }
  }
  // 越新的任务越靠前
  sortGroupsByTime(groups)

  // 有些任务在列表接口里不带 subjectId/subjectName（实测 test 站「10月26日任务」就是这样），
  // 会让学科显示为空、也无法按科目筛选。这类任务逐个查详情，用 exercise.subjectId 补全。
  const missing = groups.filter((g) => !g.subject)
  for (const g of missing) {
    try {
      const det = await client.get(`/v2/tasks/${g.taskId}/detail/`)
      const ex = det.json && det.json.exercise
      if (ex) {
        const sid = ex.subjectId
        const name = String(ex.subjectName || '').replace(/^(高中|初中|小学)/, '')
        g.subjectId = sid ?? g.subjectId
        g.subject = name || subjectNameOf(sid, '')
      }
    } catch { /* 补不到就走下面的标题兜底 */ }
    // ② 任务没绑试卷时 exercise 是 null（实测「周考4生物学试题」就是这样），
    //    详情里拿不到学科 → 退而从标题猜（「…生物学试题」→ 生物）。
    if (!g.subject) {
      const guessed = guessSubjectFromName(g.title || g.exam || '')
      if (guessed) g.subject = guessed
    }
  }
  // 补完学科后再按时间排一次（保持"新的在前"）
  sortGroupsByTime(groups)

  // 「只看近期」：默认 90 天。太久远的任务通常不用导，靠前端/接口参数控制。
  // days<=0 表示不限制。
  const rawDays = params.days === undefined || params.days === null || params.days === ''
    ? 90 : Number(params.days)
  const days = Number.isFinite(rawDays) ? rawDays : 90
  const now = Date.now()
  const inWindow = (g) => {
    if (!days || days <= 0) return true
    const k = g.sortKey || 0
    // 没有时间信息的任务一律保留，避免被误过滤掉
    if (!k) return true
    return k >= now - days * 24 * 3600 * 1000
  }
  const allGroups = groups.slice()
  const visible = allGroups.filter(inWindow)

  // 学科筛选用的下拉选项（按可见任务统计）
  const usedSubjects = [...new Set(visible.map((g) => g.subject).filter(Boolean))]
  usedSubjects.sort((a, b) => {
    const ia = SUBJ.indexOf(a); const ib = SUBJ.indexOf(b)
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b)
  })
  const subjects = usedSubjects.map((name) => ({
    name,
    id: (visible.find((g) => g.subject === name) || {}).subjectId ?? null,
    count: visible.filter((g) => g.subject === name).length,
  }))

  const grades = []
  if (gradeIds.length) {
    grades.push(...gradeIds.map((id) => ({ id, name: `年级${id}` })))
  }
  return {
    groups: visible,
    subjects,
    grades,
    days,
    taskTotal: tasks.length,
    groupTotal: visible.length,
    hiddenByTime: allGroups.length - visible.length,
    allGroupTotal: allGroups.length,
  }
}

/**
 * 取某任务「逐题满分」：任务详情 → 试卷 id → /v2/papers/<id>/ 的 questions 树。
 * 返回 { 题号: 满分 }（题号取 questions[].no，与上传模板题号列一一对应）。
 *
 * 实测（test.fuulea.com 16401145）：11 道小题 no=1..11、score=1.5×10 + 60 = 75 = totalScore，
 * 与模板题号列完全对应；平台对「分值 > 该题满分」的整份拒收，
 * 回执形如 {"学生xxx":"1 的分数大于题目分数"}。
 */
async function fetchMaxScores(client, taskId) {
  const det = await client.get(`/v2/tasks/${taskId}/detail/`)
  const exercise = det.json && det.json.exercise
  const paperId = exercise && (exercise.id || exercise.paperId)
  if (!paperId) return null

  const pr = await client.get(`/v2/papers/${paperId}/`, { taskId })
  const paper = pr.json
  if (!paper || !Array.isArray(paper.questions)) return null

  const out = {}
  const walk = (list) => {
    for (const q of list || []) {
      // 只收叶子题（有大题干/父题的容器本身没有可填的题号）
      const children = q.children || []
      if (children.length) { walk(children); continue }
      const no = q.no
      const score = Number(q.score)
      if (no === null || no === undefined || no === '') continue
      if (!Number.isFinite(score)) continue
      out[String(no)] = score
    }
  }
  walk(paper.questions)
  return out
}

async function discoverSubjects(client) {
  // 从多场考试的 subjects 接口聚合学科 id（单场考试可能只含部分学科）。
  const seen = new Map()
  try {
    for (let p = 1; p <= 5; p += 1) {
      const r = await client.get('/v2/exam/', { role: 'grade', name: '', page: p })
      const results = (r.json && r.json.results) || []
      if (!results.length) break
      for (const exam of results) {
        const sj = await client.get(`/v2/exam/${exam.id}/subjects/`)
        const data = (sj.json && sj.json.data) || []
        for (const d of data) {
          const id = String(d.subject && d.subject.id)
          const name = String((d.subject && d.subject.name) || '')
          if (id && name && !seen.has(id)) seen.set(id, { id: Number(id), name })
        }
      }
    }
  } catch { /* 忽略，回退 */ }
  if (seen.size) {
    const list = [...seen.values()]
    return list.sort((a, b) => SUBJ.indexOf(a.name) - SUBJ.indexOf(b.name))
  }
  // 回退：固定 9 科的 subjectId（不同学校可能不同，尽量从上面拿到真实 id）
  return SUBJ.map((name, i) => ({ id: i + 1, name }))
}

// ---------------------------------------------------------------- 源文件解析

function parseSourceBuffer(state, name, buf, sourceSheet) {
  const lower = name.toLowerCase()
  const result = { name, subjectGuess: guessSubjectFromName(name) }
  try {
    if (lower.endsWith('.csv')) {
      const parsed = parseCsv(buf.toString('utf8'))
      result.sheets = parsed.sheets
      result.subjectGuess = result.subjectGuess || parsed.subjectGuess
    } else if (lower.endsWith('.xlsx')) {
      const parsed = parseXlsx(buf)
      result.sheets = parsed.sheets
      result.subjectGuess = result.subjectGuess || parsed.subjectGuess
    } else if (lower.endsWith('.xls')) {
      // 老式 .xls 需要 xlrd；交给 Python 解析（返回 JSON）
      result.needsPython = true
      result.error = '老式 .xls 暂不支持，请另存为 .xlsx 后重试'
    } else if (lower.endsWith('.zip')) {
      // zip 由 Host 解包后逐个解析
      const members = unzipMembers(state, buf)
      const inner = []
      for (const m of members) {
        inner.push(parseSourceBuffer(state, m.name, m.buffer))
      }
      result.inner = inner
      result.sheets = []
    } else {
      result.error = '不支持的格式：' + lower
    }
    // 汇总：取第一份有学生的 sheet 作为主 sheet
    const sheet = pickBestSheet(result)
    if (sheet && !sheet.error) {
      result.students = sheet.students
      result.count = sheet.count
      result.questionCount = sheet.questionCols.length
      result.totalColumn = sheet.totalCol
    }
  } catch (e) {
    result.error = e && e.message ? e.message : String(e)
  }
  return result
}

/**
 * 批量体检：把用户拖进来的一堆文件（含 zip 展开后的成员）逐个判定「能不能用」。
 *
 * 判据（按顺序，第一个不满足即判跳过）：
 *   1. 格式可解析（xlsx/csv；zip 递归展开）
 *   2. 能识别出「姓名列」
 *   3. 有 ≥1 个题号列
 *   4. 有 ≥1 个学生
 *   5. 学生能与模板「班级对照表」对上（至少 1 人）—— 对不上的整份传了也会被平台拒
 *
 * 返回 [{ name, size, usable, reason, subjectGuess, students, questionCount, matched, total }]
 */
function evaluateFiles(state, templates, entries) {
  const rosterSet = new Set((templates && templates.roster) || [])
  const out = []
  for (const entry of entries) {
    const { name, buffer, size } = entry
    const lower = String(name || '').toLowerCase()
    const rec = {
      name,
      size: size != null ? size : (buffer ? buffer.length : 0),
      usable: false,
      reason: '',
      subjectGuess: guessSubjectFromName(name) || '',
      students: 0,
      questionCount: 0,
      matched: 0,
      total: 0,
    }
    if (!/\.(xlsx|csv)$/i.test(lower)) {
      rec.reason = /\.xls$/i.test(lower) ? '老式 .xls 不支持，请另存为 .xlsx' : '不是表格文件'
      out.push(rec)
      continue
    }
    let parsed
    try {
      parsed = parseSourceBuffer(state, name, buffer)
    } catch (e) {
      rec.reason = '解析失败：' + (e && e.message ? e.message : e)
      out.push(rec)
      continue
    }
    const sheet = pickBestSheet(parsed)
    if (!sheet || !sheet.students || !sheet.students.length) {
      rec.reason = sheet && sheet.error ? sheet.error : '没识别出学生（缺姓名列或没有数据行）'
      out.push(rec)
      continue
    }
    rec.students = sheet.count || sheet.students.length
    rec.questionCount = (sheet.questionCols || []).length
    rec.subjectGuess = rec.subjectGuess || parsed.subjectGuess || ''
    if (!rec.questionCount) {
      rec.reason = '没有题号列（只有总分或缺逐题分）'
      out.push(rec)
      continue
    }
    // 与模板名单匹配
    const names = sheet.students.map((s) => String(s.name || '').trim()).filter(Boolean)
    rec.total = names.length
    if (rosterSet.size) {
      rec.matched = names.filter((n) => rosterSet.has(n)).length
      if (rec.matched === 0) {
        rec.reason = '学生都不在模板的班级对照表里（' + names.slice(0, 3).join('、') + '…），传了也会被平台拒'
        out.push(rec)
        continue
      }
    } else {
      rec.matched = names.length
    }
    rec.usable = true
    rec.reason = ''
    out.push(rec)
  }
  return out
}

/** 任务排序键：优先发布时间，其次截止时间，都没有就用 taskId（平台 id 大体递增）。 */
function timeKeyOf(t) {
  const p = Date.parse(t.publishedAt || '')
  if (Number.isFinite(p)) return p
  const e = Date.parse(t.endAt || '')
  if (Number.isFinite(e)) return e
  const id = Number(t.taskId)
  return Number.isFinite(id) ? id * 1000 : 0
}

/** 任务分组按时间倒序（越新的越靠前）。 */
function sortGroupsByTime(groups) {
  groups.sort((a, b) => {
    const ka = a.sortKey || 0
    const kb = b.sortKey || 0
    if (kb !== ka) return kb - ka
    return a.exam.localeCompare(b.exam)
  })
}

function pickBestSheet(parsed) {
  if (parsed.sheets && parsed.sheets.length) {
    const withStudents = parsed.sheets.filter((s) => s.students && s.students.length)
    if (withStudents.length) {
      // 题数列最多的 sheet 优先
      withStudents.sort((a, b) => b.questionCols.length - a.questionCols.length)
      return withStudents[0]
    }
    return parsed.sheets[0]
  }
  if (parsed.inner && parsed.inner.length) {
    for (const child of parsed.inner) {
      const s = pickBestSheet(child)
      if (s && s.students && s.students.length) return s
    }
  }
  return parsed
}

/**
 * 纯 Node 解 zip（不调系统 unzip）。
 *
 * 为什么不用系统 unzip：实测 Windows 打的 zip（如「导出报表(按班级导出).zip」）
 * 中文名走 UTF-8 + flag 0x800，而 macOS 的 unzip 会按本地编码处理，解出来是乱码，
 * 连 .xlsx 扩展名都认不出 → 上层解析出 0 个文件。
 * 这里自己读中央目录，文件名一律按 UTF-8 解（非 UTF-8 时再试 GBK 兜底）。
 */
function unzipMembers(state, buf) {
  const entries = []
  // 找 EOCD
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65558); i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
  }
  if (eocd < 0) return entries
  const count = buf.readUInt16LE(eocd + 10)
  let off = buf.readUInt32LE(eocd + 16)

  for (let n = 0; n < count; n += 1) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break
    const flags = buf.readUInt16LE(off + 8)
    const method = buf.readUInt16LE(off + 10)
    const csize = buf.readUInt32LE(off + 20)
    const nameLen = buf.readUInt16LE(off + 28)
    const extraLen = buf.readUInt16LE(off + 30)
    const commentLen = buf.readUInt16LE(off + 32)
    const localOff = buf.readUInt32LE(off + 42)
    const rawName = buf.subarray(off + 46, off + 46 + nameLen)

    // flag bit 11 (0x800) = 文件名是 UTF-8；否则尝试 UTF-8 → GBK
    let name = rawName.toString('utf8')
    if (!(flags & 0x800)) {
      // 非 UTF-8：先看 utf8 解出来是否含替换符，含则试 GBK
      if (name.includes('\uFFFD')) {
        try {
          name = new TextDecoder('gbk').decode(rawName)
        } catch { /* 保留 utf8 结果 */ }
      }
    }
    name = name.replace(/\\/g, '/')
    const isDir = name.endsWith('/')

    if (!isDir && /\.(xlsx|xls|csv)$/i.test(name)) {
      // 读本地头拿真实数据偏移
      const lo = localOff
      const lNameLen = buf.readUInt16LE(lo + 26)
      const lExtraLen = buf.readUInt16LE(lo + 28)
      const dataStart = lo + 30 + lNameLen + lExtraLen
      const data = buf.subarray(dataStart, dataStart + csize)
      let out = null
      try {
        if (method === 0) out = data
        else if (method === 8) out = zlib.inflateRawSync(data)
      } catch { out = null }
      if (out) {
        entries.push({ name: name.split('/').pop(), path: name, buffer: out })
      }
    }
    off += 46 + nameLen + extraLen + commentLen
  }
  return entries
}

function walk(dir, fn) {
  let entries = []
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const e of entries) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, fn)
    else fn(p)
  }
}

function runUnzipSync(cmd, args) {
  try {
    return spawnSync(cmd, args, { encoding: 'utf8', timeout: 30000 })
  } catch (e) {
    return { status: 1, error: e }
  }
}

// ---------------------------------------------------------------- 回执

function dec(s) {
  let t = String(s)
  for (let i = 0; i < 2; i += 1) {
    try {
      const v = JSON.parse('"' + t.replace(/"/g, '\\"') + '"')
      if (typeof v !== 'string') return v
      t = v
    } catch { break }
  }
  return t
}

function briefReceipt(content) {
  const c = dec(content)
  let j = null
  try { j = JSON.parse(c) } catch { /* 非 JSON 按成功处理 */ }
  if (!j || typeof j !== 'object') return { ok: true, text: c.slice(0, 200) }
  const err = j.error
  const hasErr = err && typeof err === 'object' && Object.keys(err).length > 0
  if (hasErr) return { ok: false, text: JSON.stringify(err), detail: err }
  const succ = (j.success && typeof j.success === 'object') ? j.success : {}
  const pairs = Object.entries(succ)
  if (pairs.length) {
    const file = pairs[0][0]
    const m = /导入学生[:：]\s*(\d+)/.exec(String(pairs[0][1]))
    return { ok: true, text: JSON.stringify(Object.fromEntries(pairs)), file, students: m ? Number(m[1]) : null }
  }
  return { ok: true, text: c.slice(0, 200) }
}

async function fetchReceipts(state, client, sinceISO, fileNames) {
  // 没给 sinceISO 时，默认只看最近 30 分钟——否则会把几天前的历史回执算进本次结果，
  // 让"本次导入成功"被历史失败记录拖成红色（实测踩过）。
  const DEFAULT_WINDOW_MS = 30 * 60 * 1000
  const cutoff = sinceISO ? Date.parse(sinceISO) : (Date.now() - DEFAULT_WINDOW_MS)
  const all = []
  for (let p = 1; p <= 30; p += 1) {
    const r = await client.get('/v2/inbox/trainer/', { page: p })
    const arr = (r.json && (r.json.results || r.json.data)) || []
    if (!arr.length) break
    all.push(...arr)
  }
  const imports = all.filter((x) => x.title === '导入任务数据')
  const matched = []
  let successCount = 0
  let failCount = 0
  for (const x of imports) {
    const t = Date.parse(x.createAt)
    if (cutoff && !(t >= cutoff)) continue
    const b = briefReceipt(x.content)
    // 文件匹配：文件名在 fileNames 集合里，或未指定集合时全部
    if (fileNames.size && b.file && !fileNames.has(b.file)) {
      // 仍按标题/内容宽松匹配一次（文件可能带路径）
      const hit = [...fileNames].some((f) => String(x.content).includes(f) || String(b.file || '').includes(f))
      if (!hit) continue
    }
    if (b.ok) successCount += 1
    else failCount += 1
    matched.push({
      createAt: x.createAt,
      title: x.title,
      content: dec(x.content),
      file: b.file || '',
      success: b.ok,
      students: b.students ?? null,
      error: b.detail ? JSON.stringify(b.detail) : (b.ok ? '' : b.text),
    })
  }
  matched.sort((a, b) => String(b.createAt).localeCompare(String(a.createAt)))
  return { count: imports.length, matched, successCount, failCount }
}

// ---------------------------------------------------------------- 凭据

function requireAlias(raw) {
  const alias = aliasOf(raw)
  if (!alias) throw new Error('请填写学校子域名（例如 lyyz）')
  if (!isValidAlias(alias)) throw new Error('学校子域名只能包含字母、数字和连字符（例如 lyyz）')
  return alias
}

function listBindings(state) {
  const merged = new Map(state.reportBindings.list().map((item) => [item.alias, item]))
  for (const item of state.bindings.list()) merged.set(item.alias, item)
  return [...merged.values()].sort((a, b) =>
    String(b.lastUsedAt || b.boundAt).localeCompare(String(a.lastUsedAt || a.boundAt)),
  )
}

function clientFor(state, school, body) {
  const alias = aliasOf(school)
  const baseUrl = resolveBaseUrl(alias)
  const inputUser = String(body.username || '').trim()
  const inputPass = String(body.password || '')
  const bound = state.bindings.get(alias) || state.reportBindings.get(alias)

  let username = ''
  let password = ''
  let source = ''
  let token = ''
  let tokenExpiresAt = 0
  let savedUser = null

  if (inputUser && inputPass) {
    username = inputUser
    password = inputPass
    source = 'input'
  } else if (bound && bound.username && bound.password) {
    username = bound.username
    password = bound.password
    source = 'binding'
    token = bound.token
    tokenExpiresAt = bound.tokenExpiresAt
    savedUser = bound.user || null
  } else {
    const saved = readCredentialsFile(state.config.credentialsFile, alias)
    if (saved) {
      username = saved.username
      password = saved.password
      source = 'file'
    }
  }

  if (!username || !password) {
    throw new Error(
      `「${alias}」还没有绑定账号：请在学校设置里填写一次账号密码（之后会自动登录），` +
      `或在 ${state.config.credentialsFile} 中配置「${alias}|账号|密码」`,
    )
  }

  const reuseToken = Boolean(
    source === 'binding' && token && savedUser && tokenExpiresAt && tokenExpiresAt - Date.now() > 120_000,
  )
  const cacheKey = `${baseUrl}|${username}|${reuseToken ? 'token' : 'pass'}`
  let client = state.clients.get(cacheKey)
  if (!client) {
    client = new FuuleaApi({ baseUrl, username, password, token: reuseToken ? token : undefined })
    if (reuseToken) {
      client.expiresAt = tokenExpiresAt
      client.user = savedUser
    }
    state.clients.set(cacheKey, client)
    if (state.clients.size > MAX_CACHED_CLIENTS) {
      const oldest = state.clients.keys().next().value
      if (oldest !== undefined) state.clients.delete(oldest)
    }
  } else {
    client.username = username
    client.password = password
  }
  return { client, alias, source }
}

function persistBinding(state, alias, client, source) {
  const user = client.user || {}
  const siteTitle = (user && user.siteTitle) || ''
  const tokenExpiresAt = client.expiresAt || 0
  const existing = state.bindings.get(alias)
  try {
    if (source === 'input' || (!existing && source === 'binding')) {
      state.bindings.save({
        alias,
        baseUrl: client.baseUrl,
        siteTitle,
        username: client.username,
        password: client.password,
        token: client.token,
        tokenExpiresAt,
        user: pickUser(user),
      })
    } else if (existing) {
      state.bindings.patch(alias, {
        siteTitle: siteTitle || existing.siteTitle,
        username: client.username,
        password: client.password,
        token: client.token || existing.token,
        tokenExpiresAt: tokenExpiresAt || existing.tokenExpiresAt,
        user: pickUser(user) || existing.user,
        lastUsedAt: new Date().toISOString(),
      })
    }
    state.bindings.setLastSchool(alias)
  } catch (e) {
    try { state.ctx.logger.warn('fuulea-import: 保存绑定失败：' + (e && e.message ? e.message : e)) } catch { /* 无 logger */ }
  }
}

function pickUser(user) {
  if (!user || typeof user !== 'object') return null
  const out = {}
  for (const key of ['siteId', 'siteTitle', 'chargedGradeIds', 'manageGradeIds', 'userName', 'firstName', 'isSuper', 'id', 'userId']) {
    if (user[key] !== undefined && user[key] !== null) out[key] = user[key]
  }
  return Object.keys(out).length ? out : null
}

function invalidateClients(state, baseUrl) {
  const prefix = String(baseUrl).replace(/\/+$/, '') + '|'
  for (const key of [...state.clients.keys()]) {
    if (key.startsWith(prefix)) state.clients.delete(key)
  }
}

// ---------------------------------------------------------------- Python 调用

function runPython(state, scriptName, input) {
  return new Promise((resolve, reject) => {
    const python = state.config.pythonPath || 'python3'
    const script = path.join(state.scriptsDir(), scriptName)
    if (!fs.existsSync(script)) { reject(new Error(`脚本缺失：${script}`)); return }
    let child
    try {
      child = spawn(python, [script], { stdio: ['pipe', 'pipe', 'pipe'] })
    } catch (e) {
      reject(e)
      return
    }
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { err += d })
    child.on('error', (e) => reject(e))
    child.on('close', (code) => {
      let json = null
      try { json = JSON.parse(out.trim()) } catch { /* 非 JSON */ }
      if (json && json.error) { reject(new Error(json.error)); return }
      if (!json) { reject(new Error(`Python 脚本输出异常（code ${code}）：${(err || out).slice(0, 300)}`)); return }
      resolve(json)
    })
    child.stdin.write(JSON.stringify(input))
    child.stdin.end()
  })
}

// ---------------------------------------------------------------- 文件服务

async function serveFile(state, url, res) {
  const rel = url.searchParams.get('path') || ''
  const root = state.outputRoot()
  const abs = path.resolve(root, rel)
  const rootResolved = path.resolve(root)
  if (abs !== rootResolved && !abs.startsWith(rootResolved + path.sep)) {
    return json(res, 403, { ok: false, error: '只能读取输出目录内的文件' })
  }
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
    return json(res, 404, { ok: false, error: '文件不存在：' + rel })
  }
  const ext = path.extname(abs).toLowerCase()
  const types = {
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.xls': 'application/vnd.ms-excel',
    '.csv': 'text/csv; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
  }
  res.writeHead(200, {
    'Content-Type': types[ext] || 'application/octet-stream',
    'Content-Length': fs.statSync(abs).size,
    'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(path.basename(abs))}`,
    'Cache-Control': 'no-store',
  })
  fs.createReadStream(abs).pipe(res)
}

function openWithSystem(target, action) {
  const platform = process.platform
  let command = ''
  let args = []
  if (platform === 'darwin') {
    command = 'open'
    args = action === 'reveal' ? ['-R', target] : [target]
  } else if (platform === 'win32') {
    if (action === 'reveal') {
      command = 'explorer.exe'
      args = [`/select,${target}`]
    } else {
      command = 'cmd.exe'
      args = ['/c', 'start', '', target]
    }
  } else {
    command = 'xdg-open'
    args = [action === 'reveal' ? path.dirname(target) : target]
  }
  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn(command, args, { detached: true, stdio: 'ignore' })
    } catch (e) {
      reject(new Error(`无法调用系统打开命令（${command}）：${e.message}`))
      return
    }
    let settled = false
    const finish = (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) reject(error)
      else { try { child.unref() } catch { /* 忽略 */ } resolve() }
    }
    const timer = setTimeout(() => finish(new Error('调用系统打开命令超时')), 8000)
    child.once('error', (e) => finish(new Error(`无法调用系统打开命令（${command}）：${e.message}`)))
    child.once('spawn', () => finish())
  })
}

// ---------------------------------------------------------------- Agent 工具

function importTool(state) {
  return {
    name: 'fuulea_import_scores',
    description:
      '在辅立码课（智慧教学云）学校站点把成绩导入已发布的「平常考试」任务：' +
      '选择学校与任务，解析源成绩文件（xlsx/xls/csv 或 zip），下载全通教育「班级对照表」模板并自动填充，' +
      '预检后一键导入，并核对平台回执。' +
      'action=tasks 列出可导入的任务；action=import 执行导入。' +
      'school 为学校子域名（如 lyyz，对应 https://lyyz.fuulea.com）。' +
      '写操作（import）会真实修改生产站成绩，需谨慎并取得用户同意。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['tasks', 'import'],
          description: 'tasks = 列出可导入的任务；import = 执行导入',
        },
        school: { type: 'string', description: '学校子域名，如 lyyz；省略用默认学校' },
        taskId: { type: 'string', description: '要导入的目标任务 taskId（action=import 时必填）' },
        filePath: { type: 'string', description: '本地成绩文件绝对路径（xlsx/xls/csv 或 zip）' },
      },
      required: ['action'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['ok'],
        properties: {
          ok: { type: 'boolean' },
          action: { type: 'string' },
          groups: { type: 'array', items: { type: 'object', additionalProperties: true } },
          groupTotal: { type: 'number' },
          submitted: { type: 'boolean' },
          taskId: { type: 'string' },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => {
        const v = value || {}
        if (!v.ok) return [{ type: 'text', text: '操作失败：' + (v.error || '未知错误') }]
        if (v.action === 'tasks') {
          const lines = [`共 ${v.groupTotal} 个「考试×学科」任务：`]
          for (const g of (v.groups || []).slice(0, 40)) {
            lines.push(`- ${g.exam} · ${g.subject}（taskId=${g.taskId}，${g.className}）`)
          }
          return [{ type: 'text', text: lines.join('\n') }]
        }
        return [{ type: 'text', text: `已提交导入 taskId=${v.taskId}，结果看平台消息回执（` + (v.submitted ? '已提交' : '未提交') + `）` }]
      },
    },
    execute: async (args) => {
      const params = args || {}
      try {
        const alias = requireAlias(params.school || state.bindings.defaultSchool() || state.config.defaultSchool)
        if (params.action === 'tasks') {
          const { client } = clientFor(state, alias, params)
          const result = await fetchTaskGroups(state, client, alias, params)
          return { ok: true, action: 'tasks', ...result }
        }
        if (params.action === 'import') {
          const taskId = String(params.taskId || '').trim()
          const filePath = String(params.filePath || '').trim()
          if (!taskId || !/^\d+$/.test(taskId)) throw new Error('请提供有效的 taskId')
          if (!filePath || !fs.existsSync(filePath)) throw new Error('请提供存在的成绩文件路径')
          const buf = fs.readFileSync(filePath)
          const name = path.basename(filePath)
          const { client } = clientFor(state, alias, params)
          // 下模板 → 解析源 → 填充 → 预检 → 导入（复用同一套流程，但这里直接落盘）
          const fillResult = await ROUTES['POST fill'](state, {
            school: alias,
            taskId,
            sourceFile: { name, data: buf.toString('base64') },
          })
          if (!fillResult.ok || !fillResult.outFile) throw new Error(fillResult.error || '填充失败')
          const filledBuf = fs.readFileSync(fillResult.outFile)
          const imp = await ROUTES['POST import'](state, {
            school: alias,
            taskId,
            filledFile: { name: path.basename(fillResult.outFile), data: filledBuf.toString('base64') },
          })
          return { ok: true, action: 'import', submitted: imp.submitted, taskId, students: fillResult.students }
        }
        throw new Error('未知 action：' + params.action)
      } catch (e) {
        return { ok: false, error: e && e.message ? e.message : String(e) }
      }
    },
    presentCall: (args) => ({ card: 'generic', title: '导入成绩', kind: 'other', rawInput: args }),
  }
}

// ---------------------------------------------------------------- 工具

function safeName(s) {
  return String(s || '').replace(/[\\/:*?"<>|\s]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'file'
}

function srcBase(name) {
  return safeName(String(name || '').replace(/\.(xlsx|xls|csv|zip)$/i, '')).slice(0, 40) || '成绩'
}

function readLocalVersion(dir) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
    return pkg.version
  } catch {
    return ''
  }
}

function json(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  })
  res.end(body)
}

function readJsonBody(req, limit = 50_000_000) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      if (!text) return resolve({})
      try { resolve(JSON.parse(text)) } catch { reject(new Error('请求体不是合法 JSON')) }
    })
    req.on('error', reject)
  })
}

function withTimeout(promise, ms, message) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

export default { name, inject, apply }
