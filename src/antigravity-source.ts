import { isAbsolute, join } from 'node:path'
import { orcaDataRoot, readSQLite, sessionDatabase } from './conversations'
import type { FocusedConversation, Session } from './protocol'

type Reader = (offset: number, length: number) => Uint8Array
type Range = { offset: number; length: number; wire: number; value?: number }
export type NativeGeneration = {
  input: number; output: number; cacheRead: number; cacheWrite: number;
  milliseconds: number | null; startedAt: number | null; model: string
}
const MAX_FIELDS = 4096, MAX_GENERATIONS = 5000, MAX_ROW_BYTES = 32 * 1024 * 1024

function varint(read: Reader, offset: number, end: number, skipLarge = false): [number, number] {
  let value = 0n
  for (let count = 0; count < 10 && offset < end; count++) {
    const byte = read(offset++, 1)[0]
    if (byte === undefined) throw new Error('Truncated native metadata')
    value |= BigInt(byte & 127) << BigInt(count * 7)
    if (byte < 128) {
      if (!skipLarge && value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Native counter is out of range')
      return [Number(value), offset]
    }
  }
  throw new Error('Invalid native metadata integer')
}

/** Walk protobuf headers and skip payloads in SQLite. Prompt/tool bodies are never fetched. */
function ranges(read: Reader, start: number, end: number, wanted: number[]): Map<number, Range> {
  const result = new Map<number, Range>()
  let offset = start, fields = 0
  while (offset < end) {
    if (++fields > MAX_FIELDS) throw new Error('Native metadata has too many fields')
    let tag: number
    ;[tag, offset] = varint(read, offset, end)
    const field = Math.floor(tag / 8), wire = tag & 7
    if (!field) throw new Error('Invalid native metadata field')
    let length = 0, value: number | undefined
    if (wire === 0) {
      ;[value, offset] = varint(read, offset, end, true)
    } else if (wire === 2) {
      ;[length, offset] = varint(read, offset, end)
    } else if (wire === 1 || wire === 5) length = wire === 1 ? 8 : 4
    else throw new Error('Unsupported native metadata encoding')
    if (offset + length > end) throw new Error('Truncated native metadata payload')
    if (wanted.includes(field)) {
      if (value !== undefined && !Number.isSafeInteger(value)) throw new Error('Native counter is out of range')
      result.set(field, { offset, length, wire, ...(value === undefined ? {} : { value }) })
    }
    offset += length
  }
  return result
}
function nested(read: Reader, range: Range | undefined, fields: number[]): Map<number, Range> {
  return range?.wire === 2 ? ranges(read, range.offset, range.offset + range.length, fields) : new Map()
}
function count(fields: Map<number, Range>, field: number): number { return fields.get(field)?.value ?? 0 }
function time(read: Reader, range: Range | undefined): number | null {
  if (!range || range.length > 32) return null
  const value = nested(read, range, [1, 2]), seconds = count(value, 1), nanos = count(value, 2)
  if (nanos >= 1e9) throw new Error('Invalid native metadata time')
  return seconds * 1000 + nanos / 1e6
}

/** Field numbers are from Antigravity ACP 1.5.2's embedded protobuf descriptors:
 *  CortexStepGeneratorMetadata.chat_model=1; ChatModelMetadata.usage=4,
 *  chat_start_metadata=9, time_to_first_token=11, streaming_duration=12.
 *  ModelUsageStats.output_tokens includes thinking and response tokens.
 */
export function readNativeGeneration(read: Reader, size: number): NativeGeneration | null {
  if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_ROW_BYTES) return null
  const generation = ranges(read, 0, size, [1, 5])
  if (generation.get(5)?.length) return null
  const chat = nested(read, generation.get(1), [4, 9, 11, 12, 19, 22])
  if (!chat.has(4)) return null
  const usage = nested(read, chat.get(4), [2, 3, 4, 5])
  const firstToken = time(read, chat.get(11)), streaming = time(read, chat.get(12))
  const elapsed = firstToken !== null && streaming !== null ? firstToken + streaming : null
  const start = nested(read, chat.get(9), [4])
  const modelField = chat.get(22) ?? chat.get(19)
  const model = modelField?.wire === 2 && modelField.length <= 256
    ? new TextDecoder().decode(read(modelField.offset, modelField.length)).replace(/[\u0000-\u001f]/g, '') : ''
  return { input: count(usage, 2), output: count(usage, 3), cacheWrite: count(usage, 4), cacheRead: count(usage, 5),
    milliseconds: elapsed !== null && elapsed > 0 ? elapsed : null,
    startedAt: time(read, start.get(4)), model }
}

export async function readAntigravitySession(focus: FocusedConversation, now: number, root = orcaDataRoot()): Promise<Session | null> {
  if (focus.agent !== 'antigravity' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(focus.session)) return null
  const quote = (value: string) => "'" + value.replace(/'/g, "''") + "'"
  const rows = await readSQLite(await sessionDatabase(root), `SELECT
    json_extract(record_json,'$.accountHome.path') AS home,
    json_extract(record_json,'$.accountHome.variable') AS variable,
    (json_extract(record_json,'$.lastTurn.state')='open') AS running
    FROM agent_session_records WHERE session_id=${quote(focus.orcaSession)}
    AND json_extract(record_json,'$.provider')='antigravity'
    AND json_extract(record_json,'$.location.executionHostId')='local'
    AND json_extract(record_json,'$.providerHandleChain[#-1].handle.nativeId')=${quote(focus.session)} LIMIT 1;`, 8192)
  const record = rows[0] as { home?: string; variable?: string; running?: number } | undefined
  if (!record || record.variable !== 'GEMINI_HOME' || typeof record.home !== 'string' || !isAbsolute(record.home)) return null
  // No auth files, prompts or step payloads are opened; only the exact current native conversation's counters.
  const { DatabaseSync } = await import('node:sqlite')
  const database = new DatabaseSync(join(record.home, 'antigravity-acp', 'conversations', focus.session + '.db'), { readOnly: true })
  try {
    database.exec('BEGIN')
    if (!database.prepare('SELECT 1 FROM trajectory_meta WHERE cascade_id=? LIMIT 1').get(focus.session)) return null
    const generations = database.prepare('SELECT idx,length(data) AS size FROM gen_metadata ORDER BY idx LIMIT ?').all(MAX_GENERATIONS + 1)
    if (generations.length > MAX_GENERATIONS) throw new Error('Native conversation exceeds the supported counter limit')
    const slice = database.prepare('SELECT substr(data,?,?) AS value FROM gen_metadata WHERE idx=?')
    let input = 0, output = 0, cacheRead = 0, cacheWrite = 0, measuredOutput = 0, milliseconds = 0, samples = 0
    let first: number | null = null, lastAt = 0, lastTPS: number | null = null, model = focus.model || ''
    for (const row of generations) {
      const idx = Number(row.idx), size = Number(row.size)
      const read: Reader = (offset, length) => {
        const value = slice.get(offset + 1, length, idx)?.value
        if (!(value instanceof Uint8Array) || value.length !== length) throw new Error('Native metadata changed during read')
        return value
      }
      const generation = readNativeGeneration(read, size)
      if (!generation) continue
      input += generation.input; output += generation.output; cacheRead += generation.cacheRead; cacheWrite += generation.cacheWrite
      if (generation.model) model = generation.model
      if (generation.startedAt !== null) {
        first = first === null ? generation.startedAt : Math.min(first, generation.startedAt)
        lastAt = Math.max(lastAt, generation.startedAt + (generation.milliseconds ?? 0))
      }
      if (generation.output > 0 && generation.milliseconds !== null) {
        measuredOutput += generation.output; milliseconds += generation.milliseconds; samples++
        lastTPS = generation.output * 1000 / generation.milliseconds
      }
    }
    if (!samples || !milliseconds) return null
    const prompt = input + cacheRead + cacheWrite
    return { key: 'native:' + JSON.stringify([focus.agent, focus.session]), session: focus.session, agent: focus.agent,
      folder: '', model, requestedModel: focus.model, provider: 'antigravity', quotaProvider: 'antigravity', subagent: '',
      active: 0, liveTPS: null, runningTPS: null, averageTPS: measuredOutput * 1000 / milliseconds, lastTPS,
      measuredRequests: samples, requests: generations.length, output, lastAt: lastAt || now,
      measuredOutput, generationMs: milliseconds, startedAt: first === null ? null : new Date(first).toISOString(),
      statsSource: 'antigravity-native', statsError: null,
      totalTokens: prompt + output, cacheHitRate: prompt > 0 ? cacheRead / prompt : null,
      state: record.running ? 'waiting' : 'idle',
      conversation: { ...focus, prompt: '', updatedAt: now, running: record.running === 1 } }
  } finally { database.close() }
}
