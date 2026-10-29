// 校验 ai.js 的输出约束：只搬运映射、绝不产生分值、全部 needsConfirm。
//
// 用法：node scripts/test-ai.mjs
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const { aiSuggestMappings } = await import(pathToFileURL(path.join(root, 'lib', 'ai.js')).href)

const fakeLlm = {
  stream() {
    return (async function* () {
      yield { type: 'text-delta', text: '好的：\n```json\n{"mappings":[{"source":"4","target":"4.1","reason":"猜测"},{"source":"5","target":"5","reason":"同号"}],"unmapped":[{"source":"6","reason":"无对应"}]}\n```' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })()
  },
}

const r = await aiSuggestMappings(fakeLlm, 'p', 'm', ['4', '5', '6'], ['4.1', '5'])
console.log('mappings =', JSON.stringify(r.mappings))
console.log('unmapped =', JSON.stringify(r.unmapped))
console.log('全部 needsConfirm =', r.mappings.every((x) => x.needsConfirm === true))
console.log('无任何分值字段 =', r.mappings.every((x) => !('score' in x) && !('value' in x)))

// 越界题号必须被丢弃
const bad = {
  stream() {
    return (async function* () {
      yield { type: 'text-delta', text: '{"mappings":[{"source":"99","target":"1"},{"source":"1","target":"1"}],"unmapped":[]}' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })()
  },
}
const r2 = await aiSuggestMappings(bad, 'p', 'm', ['1', '2'], ['1', '2'])
console.log('越界题号已丢弃 =', r2.mappings.length === 1 && r2.mappings[0].sourceQno === '1')

// 模型胡说（非 JSON）应返回 null
const junk = {
  stream() {
    return (async function* () {
      yield { type: 'text-delta', text: '抱歉我无法处理' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })()
  },
}
console.log('非 JSON 返回 null =', (await aiSuggestMappings(junk, 'p', 'm', ['1'], ['1'])) === null)
