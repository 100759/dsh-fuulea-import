// 源成绩文件解析：从「平常考试」的常见成绩表里识别 姓名列 / 题号列 / 总分列。
//
// 支持的输入形态（宽容解析）：
//   - xlsx（多 sheet 或单 sheet）、csv；xls 与 zip 由 Host 解包后统一交给本模块或 Python 处理。
//   - 每个 sheet：表头行含「姓名/学生/学生姓名」列；题号列 = 表头能解析成数字 或 含「题/分」的连续列；
//     总分列 = 表头含「总分/总成绩/合计」。
//   - 姓名归一化：去首尾空白、去末尾数字后缀（「张同学2」→「张同学」）。
import { readWorkbook } from './xlsx.js'
import { normalizeQno } from './qmap.js'

export const SUBJECT_ORDER = ['语文', '数学', '英语', '物理', '化学', '生物', '政治', '历史', '地理']

const NAME_KEYS = ['姓名', '学生', '学生姓名', '名字', 'name', 'Name', 'NAME']
const TOTAL_KEYS = ['总分', '总成绩', '合计', '总分合计', '总分分']

function isBlank(v) {
  return v === null || v === undefined || String(v).trim() === ''
}

// 占位符/无效姓名：全表导出常带合计行、空行，姓名格是 - / -- / — / 合计 / 总计 等，
// 这些不能当学生，否则会一路走到预检报「学生班级未找到」。
const PLACEHOLDER_NAMES = new Set([
  '-', '--', '---', '—', '——', '－', '无', '合计', '小计', '总计', '汇总', '平均', '平均分', '人数', '/',
])

function normName(v) {
  if (isBlank(v)) return ''
  const text = String(v).trim().replace(/\s+/g, '')
  if (PLACEHOLDER_NAMES.has(text)) return ''
  // 纯符号（如 -、—、*）也不当姓名
  if (!/[\u4e00-\u9fa5A-Za-z0-9]/.test(text)) return ''
  // 只对「中文姓名 + 末尾数字后缀」做归一化（如「张同学2」→「张同学」，那是重复导入标记）。
  // ⚠️ 学号/账号形态（student01、20240101）必须原样保留，否则会被误合并成同一人。
  if (/[\u4e00-\u9fa5]/.test(text) && /\d+$/.test(text)) {
    return text.replace(/\d+$/, '').trim()
  }
  return text
}

// 题号识别统一走 qmap.normalizeQno（支持 1 / 4.1 / 第4题 / 一 / 四(1) 等），
// 避免这里和映射模块出现两套不一致的解析。
function asQuestionHeader(v) {
  if (isBlank(v)) return null
  return normalizeQno(v)
}

function isNameHeader(v) {
  const s = String(v == null ? '' : v).trim()
  if (!s) return false
  return NAME_KEYS.some((k) => s === k || s.includes(k))
}

function isTotalHeader(v) {
  const s = String(v == null ? '' : v).trim()
  return s && TOTAL_KEYS.some((k) => s === k || s.includes(k))
}

/**
 * 从一行表头里定位列结构。
 * @returns {{nameCol:number, questionCols:number[], totalCol:number, headers:string[]}}
 *   nameCol/questionCols/totalCol 为 0 基列索引；-1 表示未找到。
 */
export function detectColumns(headerRow) {
  const headers = (headerRow || []).map((v) => (v == null ? '' : String(v).trim()))
  let nameCol = -1
  let totalCol = -1
  const questionCols = []
  for (let i = 0; i < headers.length; i += 1) {
    const h = headers[i]
    if (!h) continue
    if (nameCol < 0 && isNameHeader(h)) nameCol = i
    else if (totalCol < 0 && isTotalHeader(h)) totalCol = i
    else if (asQuestionHeader(h) !== null) questionCols.push(i)
  }
  return { nameCol, questionCols, totalCol, headers }
}

/** 找表头行：前 8 行里第一个含「姓名」类列头的行。 */
export function findHeaderRow(rows) {
  for (let r = 0; r < Math.min(rows.length, 8); r += 1) {
    const d = detectColumns(rows[r] || [])
    if (d.nameCol >= 0) return { rowIndex: r, ...d }
  }
  // 找不到姓名列时退化为第一行
  return { rowIndex: 0, ...detectColumns(rows[0] || []) }
}

/**
 * 兜底：没有「姓名」表头时，按数据特征推断姓名列。
 *
 * 依据（实测老师给的表常这样：B1 是空的，下面才是人名）：
 *   - 姓名列通常是**文本**（不是数字），且每行都有值、彼此不同；
 *   - 题号列在表头行是数字，数据行也是数字。
 * 所以：在表头行里找「不是题号、不是总分」的列，再看它下面是不是一串互不相同的文本。
 */
function inferNameCol(rows, headerRowIndex, questionCols, totalCol) {
  const header = rows[headerRowIndex] || []
  const skip = new Set([...questionCols, totalCol >= 0 ? totalCol : -1])
  const candidates = []
  for (let c = 0; c < header.length; c += 1) {
    if (skip.has(c)) continue
    const vals = []
    for (let r = headerRowIndex + 1; r < Math.min(rows.length, headerRowIndex + 40); r += 1) {
      const v = (rows[r] || [])[c]
      if (!isBlank(v)) vals.push(String(v).trim())
    }
    if (vals.length < 1) continue
    const textish = vals.filter((v) => !/^-?\d+(\.\d+)?$/.test(v)).length
    const distinct = new Set(vals).size
    candidates.push({ c, vals: vals.length, textish, distinct, ratio: vals.length ? textish / vals.length : 0 })
  }
  if (!candidates.length) return -1
  candidates.sort((a, b) => {
    const scoreA = a.ratio * 2 + (a.distinct === a.vals ? 1 : 0)
    const scoreB = b.ratio * 2 + (b.distinct === b.vals ? 1 : 0)
    if (scoreB !== scoreA) return scoreB - scoreA
    return a.c - b.c
  })
  const best = candidates[0]
  // 至少要有一半是文本，否则宁可判失败（避免把学号/分数当姓名）
  return best && best.ratio >= 0.5 ? best.c : -1
}

/** 解析一个 sheet 的表格数据为结构化记录。 */
export function parseSheetRows(rows) {
  const header = findHeaderRow(rows)
  const { rowIndex, questionCols, totalCol } = header
  let { nameCol } = header
  let inferredName = false

  // 表头里没有「姓名」→ 按数据特征推断（老师给的表常缺表头）
  if (nameCol < 0 && questionCols.length > 0) {
    const guess = inferNameCol(rows, rowIndex, questionCols, totalCol)
    if (guess >= 0) {
      nameCol = guess
      inferredName = true
    }
  }
  if (nameCol < 0) return { ...header, students: [], error: '找不到姓名列' }

  const students = []
  const seen = new Set()
  for (let r = rowIndex + 1; r < rows.length; r += 1) {
    const row = rows[r] || []
    const raw = row[nameCol]
    if (isBlank(raw)) continue
    const name = normName(raw)
    if (!name) continue
    if (seen.has(name)) continue
    seen.add(name)
    const questions = questionCols.map((ci) => {
      const v = row[ci]
      if (isBlank(v)) return null
      const n = Number(v)
      return Number.isFinite(n) ? n : String(v).trim()
    })
    const totalRaw = totalCol >= 0 ? row[totalCol] : null
    const total = totalRaw === null || totalRaw === undefined || totalRaw === '' ? null : Number(totalRaw)
    students.push({ name, questions, total: Number.isFinite(total) ? total : (totalRaw ?? null) })
  }
  return { ...header, nameCol, inferredName, students, count: students.length }
}

/**
 * 解析 xlsx buffer → 各 sheet 的解析结果。
 * @returns {{sheets:[{name, rowIndex, nameCol, questionCols, totalCol, headers, students, count, error?}], subjectGuess}}
 */
export function parseXlsx(buf) {
  const wb = readWorkbook(buf)
  const sheets = []
  for (const sheet of wb.sheets) {
    const parsed = parseSheetRows(sheet.rows)
    sheets.push({ name: sheet.name, ...parsed })
  }
  const subjectGuess = guessSubject(buf, sheets)
  return { sheets, subjectGuess }
}

/** 解析 csv 文本 → 单 sheet。 */
export function parseCsv(text) {
  const rows = []
  for (const rawLine of text.split(/\r?\n/)) {
    if (!rawLine.trim()) continue
    // 简易 CSV：支持引号，逗号分隔
    const cells = []
    let cur = ''
    let inQ = false
    for (let i = 0; i < rawLine.length; i += 1) {
      const ch = rawLine[i]
      if (inQ) {
        if (ch === '"') {
          if (rawLine[i + 1] === '"') { cur += '"'; i += 1 } else inQ = false
        } else cur += ch
      } else if (ch === '"') inQ = true
      else if (ch === ',' || ch === '\t') { cells.push(cur); cur = '' }
      else cur += ch
    }
    cells.push(cur)
    rows.push(cells)
  }
  const parsed = parseSheetRows(rows)
  return { sheets: [{ name: 'csv', ...parsed }], subjectGuess: guessSubject(null, [{ name: 'csv', ...parsed }]) }
}

/** 从文件名或 sheet 名猜测学科。 */
export function guessSubject(buf, sheets) {
  // 优先文件名（外部传入），这里只根据 sheet 名猜
  const names = (sheets || []).map((s) => String(s.name || ''))
  for (const subj of SUBJECT_ORDER) {
    if (names.some((n) => n.includes(subj))) return subj
  }
  return ''
}

export function guessSubjectFromName(fileName) {
  const base = String(fileName || '').replace(/\.(xlsx|xls|csv)$/i, '')
  for (const subj of SUBJECT_ORDER) {
    if (base.includes(subj)) return subj
  }
  return ''
}

export default { parseXlsx, parseCsv, parseSheetRows, detectColumns, findHeaderRow, guessSubject, guessSubjectFromName, SUBJECT_ORDER, normName }
