import { assert, test } from 'orca/testing'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readAntigravitySession, readNativeGeneration } from './antigravity-source'
import { attachUsage } from './usage-source'
import { meanLabel, liveRate } from './presentation'
import type { FocusedConversation } from './protocol'

function integer(value: number | bigint): Buffer {
  let n = BigInt(value); const bytes: number[] = []
  do { bytes.push(Number(n & 127n) | (n > 127n ? 128 : 0)); n >>= 7n } while (n)
  return Buffer.from(bytes)
}
const scalar = (field: number, value: number | bigint) => Buffer.concat([integer(field * 8), integer(value)])
const blob = (field: number, value: Uint8Array | string) => {
  const data = typeof value === 'string' ? Buffer.from(value) : Buffer.from(value)
  return Buffer.concat([integer(field * 8 + 2), integer(data.length), data])
}
function generation(output: number, wait: number, stream: number, start = 100, promptSize = 0): Buffer {
  const duration = (ms: number) => Buffer.concat([scalar(1, Math.floor(ms / 1000)), scalar(2, Math.round(ms % 1000 * 1e6))])
  const usage = Buffer.concat([scalar(2, 100), scalar(3, output), scalar(5, 900)])
  const chat = Buffer.concat([blob(1, Buffer.alloc(promptSize, 80)), blob(4, usage), scalar(6, (1n << 64n) - 1n),
    blob(9, blob(4, scalar(1, start))), blob(11, duration(wait)), blob(12, duration(stream)), blob(19, 'gemini-4-neon')])
  return Buffer.concat([blob(2, Buffer.from([1, 2])), blob(3, Buffer.alloc(promptSize, 81)), blob(1, chat)])
}

test('native counters use request duration and skip prompt payloads, including large messages', () => {
  const data = generation(100, 1000, 1000, 100, 1024 * 1024)
  let fetched = 0, largestRead = 0
  const result = readNativeGeneration((offset, length) => {
    fetched += length; largestRead = Math.max(largestRead, length)
    return data.subarray(offset, offset + length)
  }, data.length)
  assert.deepEqual(result, { input: 100, output: 100, cacheRead: 900, cacheWrite: 0,
    milliseconds: 2000, startedAt: 100000, model: 'gemini-4-neon' })
  assert.ok(fetched < 256)
  assert.ok(largestRead <= 256)
})

test('missing native timings stay unavailable and malformed counters never become measurements', () => {
  const data = blob(1, blob(4, scalar(3, 100)))
  assert.equal(readNativeGeneration((a, n) => data.subarray(a, a + n), data.length)?.milliseconds, null)
  const broken = Buffer.from([10, 127, 1])
  assert.throws(() => readNativeGeneration((a, n) => broken.subarray(a, a + n), broken.length))
  const unsafe = blob(1, blob(4, scalar(3, 1n << 60n)))
  assert.throws(() => readNativeGeneration((a, n) => unsafe.subarray(a, a + n), unsafe.length))
})

test('native session summaries join the exact provider handle and retain duration-weighted counters', async () => {
  const root = mkdtempSync(join(tmpdir(), 'magpie-antigravity-')), home = join(root, 'gemini-home')
  const id = '11111111-1111-4111-8111-111111111111'
  const focus: FocusedConversation = { orcaSession: 'orca-native', session: id, workspace: 'workspace', title: '原生测试', agent: 'antigravity', model: 'gemini-4-neon' }
  mkdirSync(join(home, 'antigravity-acp', 'conversations'), { recursive: true })
  try {
    const store = new DatabaseSync(join(root, 'agent-session-domain.db'))
    store.exec('CREATE TABLE agent_session_records(session_id TEXT,record_json TEXT)')
    store.prepare('INSERT INTO agent_session_records VALUES(?,?)').run(focus.orcaSession, JSON.stringify({
      provider: 'antigravity', location: { executionHostId: 'local' }, accountHome: { variable: 'GEMINI_HOME', path: home },
      providerHandleChain: [{ handle: { nativeId: id } }], lastTurn: { state: 'open' }
    }))
    store.close()
    const path = join(home, 'antigravity-acp', 'conversations', id + '.db'), native = new DatabaseSync(path)
    native.exec('CREATE TABLE trajectory_meta(cascade_id TEXT);CREATE TABLE gen_metadata(idx INTEGER PRIMARY KEY,data BLOB)')
    native.prepare('INSERT INTO trajectory_meta VALUES(?)').run(id)
    const add = native.prepare('INSERT INTO gen_metadata VALUES(?,?)')
    add.run(0, generation(100, 1000, 1000)); add.run(1, generation(300, 2000, 1000, 110)); add.run(2, blob(2, Buffer.from([3])))
    native.close()
    const result = (await readAntigravitySession(focus, 120000, root))!
    assert.equal(result.averageTPS, 80)
    assert.equal(result.requests, 3); assert.equal(result.measuredRequests, 2)
    assert.equal(result.measuredOutput, 400); assert.equal(result.generationMs, 5000)
    assert.equal(result.totalTokens, 2400); assert.equal(result.cacheHitRate, .9)
    assert.equal(result.startedAt, new Date(100000).toISOString())
    assert.equal(result.conversation?.running, true)
    assert.equal(meanLabel(result), '原生请求均速'); assert.equal(liveRate(result), '—T/s')
    assert.equal(attachUsage([result], new Map())[0].statsSource, 'antigravity-native')
    assert.equal(attachUsage([result], new Map())[0].averageTPS, 80)
    assert.equal(await readAntigravitySession({ ...focus, orcaSession: 'different' }, 0, root), null)
    assert.equal(await readAntigravitySession({ ...focus, session: '../../other' }, 0, root), null)
    assert.equal(await readAntigravitySession({ ...focus, agent: 'codex' }, 0, root), null)
    const after = new DatabaseSync(path, { readOnly: true })
    assert.equal(after.prepare('SELECT count(*) AS count FROM gen_metadata').get()?.count, 3)
    after.close()
  } finally { rmSync(root, { recursive: true, force: true }) }
})
