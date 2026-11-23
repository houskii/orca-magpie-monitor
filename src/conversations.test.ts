import { assert, test } from 'orca/testing'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { conversationSQL, parseConversations, readConversations, sessionDatabase } from './conversations'
import { sessionLabel } from './session-label'
import { sampleSnapshot } from './fixtures'

test('local Orca titles and prompts join only the latest exact provider handle', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'magpie-conversations-')), db = join(dir, 'sessions.db')
  const cli = process.platform === 'darwin' ? '/usr/bin/sqlite3' : 'sqlite3'
  const records = [
    { sessionId: 'orca-codex', providerHandleChain: [{ handle: { threadId: 'old' } }, { handle: { threadId: 'codex-thread' } }],
      conversationName: '修复 Magpie 用量', lastTurn: { prompt: '能显示具体的对话内容吗？' }, location: { executionHostId: 'local' }, updatedAt: 20 },
    { sessionId: 'orca-claude', providerHandleChain: [{ handle: { sessionId: 'claude-thread' } }],
      conversationName: '查看工作区进度', lastTurn: { prompt: '帮我检查当前进度。' }, location: { executionHostId: 'local' }, updatedAt: 30 },
    { sessionId: 'remote', providerHandleChain: [{ handle: { threadId: 'codex-thread' } }],
      conversationName: '不可误配远端', location: { executionHostId: 'remote-host' }, updatedAt: 40 },
  ]
  const quote = (value: string) => "'" + value.replace(/'/g, "''") + "'"
  const inserts = records.map(r => `INSERT INTO agent_session_records VALUES (${quote(r.sessionId)},${quote(JSON.stringify(r))});`).join('\n')
  try {
    execFileSync(cli, [db, 'CREATE TABLE agent_session_records (session_id TEXT, record_json TEXT);\n' + inserts])
    const rows = await readConversations(['old', 'codex-thread', 'claude-thread', "x'); DROP TABLE agent_session_records; --"], db)
    assert.equal(rows.length, 2)
    assert.equal(rows.find(r => r.session === 'codex-thread')?.title, '修复 Magpie 用量')
    assert.equal(rows.find(r => r.session === 'claude-thread')?.prompt, '帮我检查当前进度。')
    assert.equal(rows.some(r => r.session === 'old' || r.orcaSession === 'remote'), false)
    assert.equal(execFileSync(cli, ['-readonly', db, 'SELECT count(*) FROM agent_session_records;'], { encoding: 'utf8' }).trim(), '3')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
test('missing conversation store is an error; empty sessions never open a database', async () => {
  assert.equal(conversationSQL([]), null)
  assert.deepEqual(await readConversations([], '/does-not-exist/magpie.db'), [])
  await assert.rejects(readConversations(['thread'], '/does-not-exist/magpie.db'))
})
test('conversation reads follow a store migration and preserve the latest agent options', async () => {
  const root = mkdtempSync(join(tmpdir(), 'magpie-store-migration-'))
  const cli = process.platform === 'darwin' ? '/usr/bin/sqlite3' : 'sqlite3'
  const create = (name: string, provider: string, nativeId: string) => {
    const record = { provider, providerHandleChain: [{ handle: { nativeId } }], conversationName: provider,
      options: { model: provider === 'codex' ? 'gpt-6.1-sol' : 'gemini-4-neon', effort: 'high' },
      location: { executionHostId: 'local' }, updatedAt: 1 }
    const quoted = "'" + JSON.stringify(record).replace(/'/g, "''") + "'"
    execFileSync(cli, [join(root, name), `CREATE TABLE agent_session_records(session_id TEXT,record_json TEXT);
      INSERT INTO agent_session_records VALUES('same-orca-id',${quoted});`])
  }
  try {
    create('agent-session-journal.db', 'codex', 'old-native')
    const legacy = await readConversations(['old-native'], await sessionDatabase(root))
    assert.equal(legacy[0].agent, 'codex')
    create('agent-session-domain.db', 'antigravity', 'new-native')
    const current = await readConversations(['old-native', 'new-native'], await sessionDatabase(root))
    assert.equal(current.length, 1)
    assert.equal(current[0].session, 'new-native')
    assert.equal(current[0].agent, 'antigravity')
    assert.equal(current[0].model, 'gemini-4-neon')
    assert.equal(current[0].effort, 'high')
  } finally { rmSync(root, { recursive: true, force: true }) }
})
test('preview bounds keep plain user text; UI labels use content instead of raw IDs', () => {
  const rows = parseConversations([{ session: 'upstream', orcaSession: 'orca', title: 'A'.repeat(200), prompt: 'hello\nworld\0' }])
  assert.equal(rows[0].title.length, 160)
  assert.equal(rows[0].prompt, 'hello\nworld')
  const session = sampleSnapshot().sessions[0]
  assert.equal(sessionLabel(session), 'Magpie 网关 用量查询支持')
  session.conversation!.title = ''
  assert.ok(sessionLabel(session).startsWith('另外orca'))
})
