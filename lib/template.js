// 解析全通教育「班级对照表」上传模板的结构。
//
// 模板 xlsx 两张表（实测）：
//   `小题分` 表：表头第 3 行、B 列=姓名、第 9 列(I)起=题号列（题号列数随考试×学科变化）。
//   `班级对照表` 表：无表头，A 列=姓名（覆盖该考试该学科全部班级）。
import { readWorkbook } from './xlsx.js'

const HDR_ROW = 2 // 0 基 → 第 3 行
const NAME_COL = 1 // 0 基 → B 列
const QCOL_START = 8 // 0 基 → 第 9 列(I)

/**
 * 题号表头判定。模板题号可能是：
 *   整数 "1"/"2"、小数子题号 "4.1"/"4.2"（父题下挂子题时）、或 "第1题"。
 * ⚠️ 不能只认整数：实测「10月26日任务」模板题号是 1,2,3,4.1,4.2 —— 只认整数会数成 3 列，
 * 与真实 5 列不符，填充时列数校验直接失败。
 */
function questionNoOf(v) {
  if (v === null || v === undefined || v === '') return null
  const s = String(v).trim()
  // 纯数字或小数（1 / 4.1 / 04.2）
  if (/^\d+(\.\d+)?$/.test(s)) return s.replace(/^0+(?=\d)/, '')
  // "第4.1题" / "4.1题" / "T4.1"
  const m = /(\d+(?:\.\d+)?)/.exec(s)
  if (m && /题|^T/i.test(s)) return m[1].replace(/^0+(?=\d)/, '')
  return null
}

/** 解析模板 buffer → { roster, questionHeaders, questionCount, headerRow }。 */
export function parseTemplate(buf) {
  const wb = readWorkbook(buf)
  const byName = new Map(wb.sheets.map((s) => [s.name, s]))

  const scoreSheet = byName.get('小题分')
  if (!scoreSheet) throw new Error('模板缺少「小题分」表')

  const rows = scoreSheet.rows
  const headerRow = rows[HDR_ROW] || []
  const nameHeader = String(headerRow[NAME_COL] ?? '').trim()
  if (nameHeader !== '姓名') {
    throw new Error(`模板第 3 行 B 列不是「姓名」（读到「${nameHeader}」），坐标可能已变化`)
  }
  const questionCols = []
  for (let c = QCOL_START; c < headerRow.length; c += 1) {
    if (questionNoOf(headerRow[c]) !== null) questionCols.push(c)
  }
  const questionHeaders = questionCols.map((c) => String(headerRow[c] ?? '').trim())
  const questionCount = questionCols.length

  // 班级对照表名单（A 列）
  const roster = []
  const seen = new Set()
  const mapSheet = byName.get('班级对照表')
  if (mapSheet) {
    for (const row of mapSheet.rows) {
      const name = row[0]
      if (name === null || name === undefined || name === '') continue
      const norm = String(name).trim()
      if (!norm || seen.has(norm)) continue
      seen.add(norm)
      roster.push(norm)
    }
  }

  // 小题分表现有学生（可能为空，模板刚下载通常只有表头）
  const existingNames = []
  for (let r = HDR_ROW + 1; r < rows.length; r += 1) {
    const nm = (rows[r] || [])[NAME_COL]
    if (nm === null || nm === undefined || nm === '') continue
    existingNames.push(String(nm).trim())
  }

  return {
    roster,
    rosterCount: roster.length,
    questionHeaders,
    questionCount,
    headerRow: HDR_ROW + 1, // 转回 1 基
    existingNames,
  }
}

export default { parseTemplate }
