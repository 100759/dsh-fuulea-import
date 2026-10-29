// 题号映射分析：把「源成绩表的题号列」对齐到「模板的题号列」。
//
// 设计原则（重要，不要放宽）：
//   1. **分数永远由程序搬运**，AI 只负责判断「哪一列对应哪一列」，绝不生成任何分值。
//   2. 能确定性判断的，用规则引擎直接给出（exact），不调 AI。
//   3. 规则判断不了的（歧义结构），才请 AI 给建议，且结果一律标记 `needsConfirm: true`。
//   4. **无法精确还原的一律不自动填**：例如源表只有大题总分、模板要小题分，
//      程序不知道各小题真实得分 → 标记 `unfillable`，由人决定，绝不均摊。
//
// 题号形态：
//   模板实测可能是 1,2,3,4.1,4.2（父题 4 下挂子题 4.1/4.2，父题不占列）
//   源表可能是 1,2,3,4（只有父题总分）或 1,2,3,4.1,4.2

/** 题号标准化：'4.1' / '第4.1题' / 'T4.1' / '一' / '四(1)' → '4.1' 等。 */
export function normalizeQno(v) {
  if (v === null || v === undefined || v === '') return null
  const s = String(v).trim()
  if (!s) return null

  // 纯数字 / 小数
  if (/^\d+(\.\d+)?$/.test(s)) return stripLead(s)
  // 中文数字 + 括号子题：四(1) / 四（2）
  const cnSub = /^([一二三四五六七八九十]+)\s*[（(\-]\s*(\d+)\s*[)）]?$/.exec(s)
  if (cnSub) {
    const base = cnToNum(cnSub[1])
    if (base !== null) return `${base}.${stripLead(cnSub[2])}`
  }
  // 阿拉伯数字 + 括号/横线子题：4(1) / 4-1
  const arSub = /^(\d+)\s*[（(]\s*(\d+)\s*[)）]?$/.exec(s)
  if (arSub) return `${stripLead(arSub[1])}.${stripLead(arSub[2])}`
  const arDash = /^(\d+)\s*-\s*(\d+)$/.exec(s)
  if (arDash) return `${stripLead(arDash[1])}.${stripLead(arDash[2])}`
  // 第N题 / N题 / TN
  const withTi = /^第?\s*(\d+(?:\.\d+)?)\s*题?$/.exec(s)
  if (withTi) return stripLead(withTi[1])
  const tPrefix = /^T\s*(\d+(?:\.\d+)?)$/i.exec(s)
  if (tPrefix) return stripLead(tPrefix[1])
  // 纯中文数字
  const cn = cnToNum(s)
  if (cn !== null) return String(cn)
  // 含「题/分」的列头
  if (/题|分|sub|q|item/i.test(s)) {
    const n = /(\d+(?:\.\d+)?)/.exec(s)
    if (n) return stripLead(n[1])
    const cn2 = /([一二三四五六七八九十]+)/.exec(s)
    if (cn2) {
      const num = cnToNum(cn2[1])
      if (num !== null) return String(num)
    }
  }
  return null
}

const CN_DIGIT = { 零: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 }

/** 中文数字 → 阿拉伯数字（一~九十九）。 */
export function cnToNum(s) {
  const text = String(s || '').trim()
  if (!text) return null
  if (/^\d+$/.test(text)) return Number(text)
  if (text === '十') return 10
  const m = /^([一二三四五六七八九])?十([一二三四五六七八九])?$/.exec(text)
  if (m) {
    const tens = m[1] ? CN_DIGIT[m[1]] : 1
    const ones = m[2] ? CN_DIGIT[m[2]] : 0
    return tens * 10 + ones
  }
  if (text.length === 1 && CN_DIGIT[text] !== undefined) return CN_DIGIT[text]
  return null
}

function stripLead(s) {
  return String(s).replace(/^0+(?=\d)/, '')
}

/** 父题号：'4.1' → '4'；'16(1)' → '16'；'4' → '4' */
export function parentOf(qno) {
  if (qno === null || qno === undefined) return null
  // 先标准化：'16(1)' → '16.1'、'第16.1题' → '16.1'，再取父题
  const s = normalizeQno(qno) ?? String(qno)
  const i = s.indexOf('.')
  return i < 0 ? s : s.slice(0, i)
}

export function isSubQno(qno) {
  return String(qno || '').includes('.')
}

/**
 * 纯规则分析：源表题号列表 vs 模板题号列表。
 * 返回 { mappings, fillable, unfillable, notes, needsAI }
 *   mappings: [{ sourceQno, targetQno, kind: 'exact'|'sub-merge'|'parent-split'|'ai', needsConfirm }]
 *   unfillable: [{ sourceQno, reason }] —— 这些绝不自动填
 */
export function ruleAnalyze(sourceQnos, targetQnos) {
  // 统一标准化后再比对：'16(1)'→'16.1'、'第4题'→'4'、'一'→'1'。
  // 不先归一的话，srcSet 里是 '16(1)' 而 parentOf 得到 '16'，两边永远匹配不上。
  const norm = (q) => normalizeQno(q) ?? String(q)
  const src = sourceQnos.map(norm)
  const tgt = targetQnos.map(norm)
  const mappings = []
  const unfillable = []
  const notes = []

  const srcSet = new Set(src)
  const tgtSet = new Set(tgt)

  // ① 完全一致：直接对应
  const exactAll = src.length === tgt.length && src.every((q, i) => q === tgt[i])
  if (exactAll) {
    for (const q of src) mappings.push({ sourceQno: q, targetQno: q, kind: 'exact', needsConfirm: false })
    return { mappings, fillable: true, unfillable, notes: ['源表与模板题号完全一致'], needsAI: false }
  }

  // ② 逐个题号判断
  for (const q of src) {
    // 【题组：源表既有父题合计、又有子题，而模板只要父题】
    // 实测全通教育「小题得分明细」导出：题号是 1..20 外加 16(1)..16(6)、17(1)..17(7) 等子题，
    // 而平台模板只要 1..20。此时父题列(16)已经包含子题总和，子题列属于冗余，必须忽略，
    // 否则会被误判成"按位置对到别的题号"，把分数搬错列。
    if (isSubQno(q)) {
      const p = parentOf(q)
      if (srcSet.has(p) && tgtSet.has(p)) {
        notes.push(`源表子题 ${q} 已包含在父题 ${p} 里，且模板只要 ${p}，已忽略子题列`)
        continue
      }
    }
    if (tgtSet.has(q)) {
      // 同题号直接对
      mappings.push({ sourceQno: q, targetQno: q, kind: 'exact', needsConfirm: false })
      continue
    }
    // 源表是子题号(4.1) 而模板只有父题(4) → 需要合并子题分数到父题
    if (isSubQno(q)) {
      const p = parentOf(q)
      if (tgtSet.has(p)) {
        mappings.push({ sourceQno: q, targetQno: p, kind: 'sub-merge', needsConfirm: true })
        notes.push(`源表小题 ${q} 需要合并进模板大题 ${p}（程序会求和）`)
        continue
      }
    }
    // 源表是父题号(4)、模板是子题(4.1,4.2)：分两种情况
    //   a) 源表**同时**有该父题的子题列（4 与 4.1/4.2 并存）→ 4 是冗余合计，直接忽略
    //      （实测老师导出的表常这样：大题合计和小题分同时给）
    //   b) 源表只有父题总分 → 无法还原各子题得分，不自动填
    if (!isSubQno(q) && tgt.some((t) => parentOf(t) === q)) {
      const srcSubs = src.filter((s) => isSubQno(s) && parentOf(s) === q)
      if (srcSubs.length) {
        notes.push(`源表的 ${q} 是合计列（源表另有小题 ${srcSubs.join('、')}），已忽略该列`)
        continue
      }
      unfillable.push({
        sourceQno: q,
        reason: `源表只有大题 ${q} 的总分，模板要的是小题（${tgt.filter((t) => parentOf(t) === q).join('、')}）。` +
          '程序无法还原各小题真实得分，不做均摊，需人工处理。',
      })
      continue
    }
    // 其余：位置能对上就按位置（保守，需确认）
    const si = src.indexOf(q)
    if (si < tgt.length && !mappings.some((m) => m.targetQno === tgt[si])) {
      mappings.push({ sourceQno: q, targetQno: tgt[si], kind: 'positional', needsConfirm: true })
      notes.push(`源表第 ${si + 1} 列（题号 ${q}）按位置对到模板 ${tgt[si]}，需确认`)
      continue
    }
    unfillable.push({ sourceQno: q, reason: `模板里找不到与题号 ${q} 对应的列` })
  }

  // 模板有但源表没有的题号 → 会留空（预检会拦）
  const covered = new Set(mappings.map((m) => m.targetQno))
  const missingInSource = tgt.filter((t) => !covered.has(t))
  if (missingInSource.length) {
    notes.push(`模板题号 ${missingInSource.join('、')} 在源表里没有对应列，这些格会留空（平台会整份拒收）`)
  }

  const needsConfirm = mappings.some((m) => m.needsConfirm) || unfillable.length > 0
  const fillable = mappings.length > 0 && unfillable.length === 0 && missingInSource.length === 0
  return { mappings, fillable, unfillable, notes, needsAI: !fillable && unfillable.length > 0, missingInSource }
}

/**
 * 把映射方案落到「模板列序号 ← 源表列序号」的填表指令。
 * 只做搬运与求和，不产生任何新分值。
 * @param mappings [{ sourceQno, targetQno }]
 * @param sourceHeaders 源表题号表头（按列顺序）
 * @param targetHeaders 模板题号表头（按列顺序）
 * @returns { plan: [{ targetIndex, sources:[sourceIndex...], op:'copy'|'sum' }], warnings:[] }
 */
export function buildFillPlan(mappings, sourceHeaders, targetHeaders) {
  const srcIdx = new Map()
  sourceHeaders.forEach((h, i) => {
    const q = normalizeQno(h)
    if (q !== null) srcIdx.set(q, i)
  })
  const tgtIdx = new Map()
  targetHeaders.forEach((h, i) => {
    const q = normalizeQno(h)
    if (q !== null) tgtIdx.set(q, i)
  })

  const byTarget = new Map()
  const warnings = []
  for (const m of mappings) {
    const si = srcIdx.get(String(m.sourceQno))
    const ti = tgtIdx.get(String(m.targetQno))
    if (si === undefined) { warnings.push(`源表缺少题号 ${m.sourceQno} 的列`); continue }
    if (ti === undefined) { warnings.push(`模板缺少题号 ${m.targetQno} 的列`); continue }
    if (!byTarget.has(ti)) byTarget.set(ti, [])
    byTarget.get(ti).push(si)
  }

  const plan = []
  for (const [ti, sis] of [...byTarget.entries()].sort((a, b) => a[0] - b[0])) {
    plan.push({ targetIndex: ti, targetQno: targetHeaders[ti], sources: sis, op: sis.length > 1 ? 'sum' : 'copy' })
  }
  return { plan, warnings }
}

export default { normalizeQno, parentOf, isSubQno, ruleAnalyze, buildFillPlan }
