import { assert, test } from 'orca/testing'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { focusedOrcaSession, readFocus } from './focus'

function createFocusStore(): { root: string; put: (database: string, record?: object) => void } {
  const root = mkdtempSync(join(tmpdir(), 'magpie-focus-store-')), dir = join(root, 'profiles', 'local-default')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(root, 'orca-profile-index.json'), JSON.stringify({ activeProfileId: 'local-default' }))
  const state = { activeWorktreeId: 'workspace', activeTabId: 'tab', unifiedTabs: {
    workspace: [{ id: 'tab', entityId: 'current', contentType: 'agent-session', executionHostId: 'local' }]
  } }
  const cli = process.platform === 'darwin' ? '/usr/bin/sqlite3' : 'sqlite3'
  const quote = (v: unknown) => "'" + JSON.stringify(v).replace(/'/g, "''") + "'"
  execFileSync(cli, [join(dir, 'profile-state.db'), `CREATE TABLE profile_state_documents(domain TEXT,payload TEXT);
    CREATE TABLE profile_state_document_parts(domain TEXT,part_key TEXT,payload TEXT);
    INSERT INTO profile_state_documents VALUES('workspaceSession',${quote(state)});`])
  return { root, put(database, record) {
    execFileSync(cli, [join(root, database), `CREATE TABLE agent_session_records(session_id TEXT,record_json TEXT);`
      + (record ? `INSERT INTO agent_session_records VALUES('current',${quote(record)});` : '')])
  } }
}

test('domain store restores the current agent and model instead of the stale legacy handle', async () => {
  const { root, put } = createFocusStore()
  try {
    put('agent-session-journal.db', { provider: 'claude', providerHandleChain: [{ handle: { sessionId: 'stale' } }],
      conversationName: '旧标题', location: { executionHostId: 'local' } })
    put('agent-session-domain.db', { provider: 'antigravity', providerHandleChain: [{ handle: { nativeId: 'current-native' } }],
      conversationName: '当前标题', options: { model: 'gemini-4-neon', effort: 'high' }, location: { executionHostId: 'local' } })
    assert.deepEqual(await readFocus(root), { orcaSession: 'current', session: 'current-native', workspace: 'workspace',
      title: '当前标题', agent: 'antigravity', model: 'gemini-4-neon', effort: 'high' })
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('a missing row or unreadable domain store cannot revive a legacy conversation', async () => {
  const { root, put } = createFocusStore()
  try {
    put('agent-session-journal.db', { providerHandleChain: [{ handle: { threadId: 'stale' } }], location: { executionHostId: 'local' } })
    put('agent-session-domain.db')
    assert.equal((await readFocus(root))?.session, '')
    writeFileSync(join(root, 'agent-session-domain.db'), 'not a database')
    await assert.rejects(readFocus(root))
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('current workspace and split-group selection wins over stale legacy active-tab IDs', async () => {
  const root=mkdtempSync(join(tmpdir(),'magpie-focus-')), dir=join(root,'profiles','local-default')
  mkdirSync(dir,{recursive:true}); writeFileSync(join(root,'orca-profile-index.json'),JSON.stringify({activeProfileId:'local-default'}))
  const cli=process.platform==='darwin'?'/usr/bin/sqlite3':'sqlite3'
  const sql=(db:string,text:string)=>execFileSync(cli,[db,text])
  const q=(v:unknown)=>"'"+JSON.stringify(v).replace(/'/g,"''")+"'"
  const state={ activeWorkspaceKey:'worktree:workspace',activeWorktreeId:'workspace',activeWorkspaceExecutionHostId:'local',activeTabId:'old-tab',
    activeGroupIdByWorktree:{workspace:'group'},tabGroups:{workspace:[{id:'group',activeTabId:'old-tab'}]},
    unifiedTabs:{workspace:[{id:'old-tab',entityId:'orca-a',contentType:'agent-session',executionHostId:'local'},
      {id:'new-tab',entityId:'orca-b',contentType:'agent-session',executionHostId:'local'}]} }
  const profile=join(dir,'profile-state.db'), journal=join(root,'agent-session-journal.db')
  try {
    sql(profile,`CREATE TABLE profile_state_documents(domain TEXT,payload TEXT);
      CREATE TABLE profile_state_document_parts(domain TEXT,part_key TEXT,payload TEXT);
      INSERT INTO profile_state_documents VALUES('workspaceSession',${q(state)});
      INSERT INTO profile_state_document_parts VALUES('workspaceSession','["tabGroups","workspace"]',${q([{id:'group',activeTabId:'new-tab'}])});`)
    sql(journal,`CREATE TABLE agent_session_records(session_id TEXT,record_json TEXT);
      INSERT INTO agent_session_records VALUES('orca-b',${q({providerHandleChain:[{handle:{threadId:'native-b'}}],location:{executionHostId:'local'}})});`)
    assert.deepEqual(await readFocus(root),{orcaSession:'orca-b',session:'native-b',workspace:'workspace',title:''})
    sql(profile,`UPDATE profile_state_document_parts SET payload=${q([{id:'group',activeTabId:'old-tab'}])};`)
    assert.equal((await readFocus(root))?.orcaSession,'orca-a')
    assert.equal((await readFocus(root))?.session,'')
    writeFileSync(join(dir,'active-view.json'),JSON.stringify({activeView:'automations'}))
    assert.equal(await readFocus(root),null)
    writeFileSync(join(dir,'active-view.json'),JSON.stringify({activeView:'terminal'}))
    assert.equal((await readFocus(root))?.orcaSession,'orca-a')
    const remote={...state,activeWorkspaceExecutionHostId:'ssh-host'}
    assert.equal(focusedOrcaSession([{payload:JSON.stringify(remote)}]),null)
    state.unifiedTabs.workspace[0].contentType='editor'
    assert.equal(focusedOrcaSession([{payload:JSON.stringify(state)}]),null)
  } finally {rmSync(root,{recursive:true,force:true})}
})
