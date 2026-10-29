// AI 兜底：规则引擎判不了题号对应关系时，请模型给「映射建议」。
//
// ⚠️ 硬约束（不可放宽）：
//   1. 只允许模型输出「源表题号 → 模板题号」的对应关系，**绝不输出任何分数值**。
//   2. 返回的每条映射一律 needsConfirm=true，必须人工确认后才用。
//   3. 模型输出必须能被严格校验；解析失败就当没给建议，退回"不可自动填"。
//   4. 模型说"无法确定"是合法答案，且优先于编一个看起来合理的对应。
import { normalizeQno } from './qmap.js'

const SYSTEM = `你是成绩表结构对齐助手。你的唯一任务是判断「源成绩表的题号」与「上传模板的题号」之间的对应关系。

严格规则：
1. 绝对不要输出任何分数、得分、分值数字。只输出题号对应关系。
2. 只能使用我给出的题号，不要发明新题号。
3. 如果某个源表题号无法确定对应到模板的哪一列，把它放进 "unmapped"，并说明原因。**宁可说无法确定，也不要猜。**
4. 特别注意父子题结构：模板里 "4.1"/"4.2" 是第 4 题的子题。若源表只有 "4"，则无法还原 4.1/4.2 各自的分数，必须放进 unmapped。
5. 只输出 JSON，不要任何解释文字。

输出格式：
{"mappings":[{"source":"<源表题号>","target":"<模板题号>","reason":"<简短理由>"}],"unmapped":[{"source":"<源表题号>","reason":"<为什么无法确定>"}]}`

/** 从模型输出里抽出 JSON（容忍 ```json 包裹或前后有文字）。 */
function extractJson(text) {
  const s = String(text || '')
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(s)
  const body = fenced ? fenced[1] : s
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try { return JSON.parse(body.slice(start, end + 1)) } catch { return null }
}

/**
 * 请 AI 给题号映射建议。
 * @param llm ctx.llm（已确认可用）；不可用时直接返回 null
 * @param provider/model 当前默认模型
 * @param sourceHeaders 源表题号表头
 * @param targetHeaders 模板题号表头
 * @param context 额外上下文（任务名、学科等）
 * @returns { mappings:[{sourceQno,targetQno,kind:'ai',needsConfirm:true,reason}], unmapped:[...] } 或 null
 */
export async function aiSuggestMappings(llm, provider, model, sourceHeaders, targetHeaders, context = {}) {
  if (!llm || !provider || !model) return null

  const srcList = sourceHeaders.map((h) => normalizeQno(h)).filter((q) => q !== null)
  const tgtList = targetHeaders.map((h) => normalizeQno(h)).filter((q) => q !== null)
  if (!srcList.length || !tgtList.length) return null

  const user = [
    context.taskTitle ? `任务名：${context.taskTitle}` : '',
    context.subject ? `学科：${context.subject}` : '',
    `源表题号（按列顺序）：${srcList.join(', ')}`,
    `模板题号（按列顺序）：${tgtList.join(', ')}`,
    '请判断每个源表题号对应模板的哪个题号。无法确定的放进 unmapped。不要输出任何分数。',
  ].filter(Boolean).join('\n')

  let text = ''
  try {
    const stream = llm.stream({
      provider,
      model,
      messages: [{ role: 'user', content: [{ type: 'text', text: user }] }],
      system: SYSTEM,
      temperature: 0,
      maxTokens: 1200,
    })
    for await (const chunk of stream) {
      if (chunk && chunk.type === 'text-delta') text += chunk.text || ''
      if (chunk && chunk.type === 'finish' && chunk.reason && chunk.reason.kind === 'error') return null
    }
  } catch {
    return null
  }

  const json = extractJson(text)
  if (!json || typeof json !== 'object') return null

  const srcSet = new Set(srcList)
  const tgtSet = new Set(tgtList)
  const mappings = []
  const unmapped = []
  const usedTargets = new Set()

  for (const m of Array.isArray(json.mappings) ? json.mappings : []) {
    const s = normalizeQno(m && m.source)
    const t = normalizeQno(m && m.target)
    // 严格校验：题号必须真实存在于两侧；目标列不能被重复占用
    if (s === null || t === null) continue
    if (!srcSet.has(s) || !tgtSet.has(t)) continue
    if (usedTargets.has(t)) continue
    usedTargets.add(t)
    mappings.push({
      sourceQno: s,
      targetQno: t,
      kind: 'ai',
      needsConfirm: true,
      reason: String((m && m.reason) || '').slice(0, 120),
    })
  }
  for (const u of Array.isArray(json.unmapped) ? json.unmapped : []) {
    const s = normalizeQno(u && u.source)
    if (s === null || !srcSet.has(s)) continue
    unmapped.push({ sourceQno: s, reason: String((u && u.reason) || 'AI 无法确定').slice(0, 160) })
  }

  if (!mappings.length && !unmapped.length) return null
  return { mappings, unmapped }
}

export default { aiSuggestMappings }
