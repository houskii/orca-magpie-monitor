import { readFile, stat } from 'node:fs/promises'
import { watch, type FSWatcher } from 'node:fs'
import { join } from 'node:path'
import { conversationAgent, orcaDataRoot, readSQLite, sessionDatabase } from './conversations'
import type { FocusedConversation } from './protocol'

type Obj = Record<string, any>
const object = (v: unknown): Obj => v && typeof v === 'object' && !Array.isArray(v) ? v as Obj : {}
const fields = ['activeWorkspaceKey', 'activeWorktreeId', 'activeWorkspaceExecutionHostId', 'activeTabId',
  'activeTabIdByWorktree', 'activeGroupIdByWorktree', 'tabGroups', 'unifiedTabs']

export function focusedOrcaSession(rows: unknown[]): { orcaSession: string; workspace: string } | null {
  let state: Obj = {}
  for (const value of rows) {
    const row = object(value)
    if (!row.part_key) state = object(JSON.parse(row.payload || '{}'))
    else {
      const path: unknown = JSON.parse(row.part_key)
      if (!Array.isArray(path) || !fields.includes(path[0]) || path.length > 2) continue
      const v = JSON.parse(row.payload)
      if (path.length === 1) state[path[0]] = v
      else state[path[0]] = { ...object(state[path[0]]), [path[1]]: v }
    }
  }
  if (state.activeWorkspaceExecutionHostId && state.activeWorkspaceExecutionHostId !== 'local') return null
  const key = state.activeWorkspaceKey || state.activeWorktreeId
  if (typeof key !== 'string') return null
  const workspace = key.startsWith('worktree:') ? key.slice('worktree:'.length) : key
  const groupId = object(state.activeGroupIdByWorktree)[workspace]
  const groups = object(state.tabGroups)[workspace]
  const group = Array.isArray(groups) ? groups.find(g => g.id === groupId) : null
  if (groupId && !group) return null
  const tabId = group?.activeTabId || object(state.activeTabIdByWorktree)[workspace] || state.activeTabId
  const tabs = object(state.unifiedTabs)[workspace]
  const tab = Array.isArray(tabs) ? tabs.find(t => t.id === tabId) : null
  if (!tab || tab.contentType !== 'agent-session' || tab.executionHostId && tab.executionHostId !== 'local'
      || typeof tab.entityId !== 'string' || !tab.entityId || tab.entityId.length > 256) return null
  return { orcaSession: tab.entityId, workspace }
}

async function readSmallJSON(path: string): Promise<Obj> {
  if ((await stat(path)).size > 64 * 1024) throw new Error('Orca focus metadata too large')
  return object(JSON.parse(await readFile(path, 'utf8')))
}
export async function readFocus(root = orcaDataRoot()): Promise<FocusedConversation | null> {
  const id = (await readSmallJSON(join(root, 'orca-profile-index.json'))).activeProfileId
  if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error('Orca profile unavailable')
  const profile = join(root, 'profiles', id)
  try {
    const view = await readSmallJSON(join(profile, 'active-view.json'))
    if (view.activeView && view.activeView !== 'terminal') return null
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  // Project only focus-related fields, never the whole workspace/profile document.
  const projection = 'json_object(' + fields.map(f => `'${f}',json_extract(payload,'$.${f}')`).join(',') + ')'
  const list = fields.map(f => `'${f}'`).join(',')
  const rows = await readSQLite(join(profile, 'profile-state.db'), `SELECT NULL AS part_key, ${projection} AS payload, 0 AS depth
    FROM profile_state_documents WHERE domain='workspaceSession'
    UNION ALL SELECT part_key,payload,json_array_length(part_key) AS depth FROM profile_state_document_parts
    WHERE domain='workspaceSession' AND json_array_length(part_key)<=2 AND json_extract(part_key,'$[0]') IN (${list})
    ORDER BY depth,part_key;`, 1024 * 1024)
  const focus = focusedOrcaSession(rows)
  if (!focus) return null
  const quoted = focus.orcaSession.replace(/'/g, "''")
  const result = await readSQLite(await sessionDatabase(root), `SELECT
    coalesce(json_extract(record_json,'$.providerHandleChain[#-1].handle.threadId'),
      json_extract(record_json,'$.providerHandleChain[#-1].handle.sessionId'),
      json_extract(record_json,'$.providerHandleChain[#-1].handle.nativeId')) AS session,
    substr(json_extract(record_json,'$.conversationName'),1,160) AS title,
    json_extract(record_json,'$.provider') AS agent,
    json_extract(record_json,'$.options.model') AS model,
    json_extract(record_json,'$.options.effort') AS effort
    FROM agent_session_records WHERE session_id='${quoted}'
      AND json_extract(record_json,'$.location.executionHostId')='local' LIMIT 1;`, 16 * 1024)
  const row = object(result[0])
  return { ...focus, session: typeof row.session === 'string' ? row.session.slice(0,256) : '',
    title: typeof row.title === 'string' ? row.title : '', ...conversationAgent(row) }
}

/** Wake on saved UI changes; the worker also polls in case a watch event is lost. */
export function watchFocus(onChange: () => void, root = orcaDataRoot()): () => void {
  let stopped=false, profileId='', rootWatch:FSWatcher|undefined, profileWatch:FSWatcher|undefined
  const files=new Map<string,FSWatcher>()
  function direct(path:string,changed:()=>void):void{
    if(stopped||files.has(path))return
    if(path!==indexPath&&!['profile-state.db','profile-state.db-wal','active-view.json']
      .some(name=>path===join(root,'profiles',profileId,name)))return
    try{
      const watcher=watch(path,{persistent:false},event=>{
        changed()
        if(event==='rename'){watcher.close();files.delete(path);direct(path,changed)}
      })
      watcher.on('error',()=>{watcher.close();files.delete(path);onChange()})
      files.set(path,watcher)
    }catch{ /* Parent directory notices file creation; polling covers missed notifications. */ }
  }
  const indexPath=join(root,'orca-profile-index.json')
  const changedIndex=()=>{void configure();onChange()}
  function profileFiles():void{
    if(!profileId)return
    for(const name of ['profile-state.db','profile-state.db-wal','active-view.json'])
      direct(join(root,'profiles',profileId,name),onChange)
  }
  async function configure():Promise<void>{
    try {
      const id=(await readSmallJSON(join(root,'orca-profile-index.json'))).activeProfileId
      if(stopped||typeof id!=='string'||!/^[a-zA-Z0-9_-]+$/.test(id))return
      if(id===profileId){profileFiles();return}
      profileWatch?.close()
      for(const [path,watcher]of files)if(path!==indexPath){watcher.close();files.delete(path)}
      profileId=id
      profileWatch=watch(join(root,'profiles',id),{persistent:false},(_event,name)=>{
        if(!name||/^(profile-state\.db(?:-wal|-shm)?|active-view\.json)$/.test(String(name))){profileFiles();onChange()}
      })
      profileWatch.on('error',onChange)
      profileFiles()
    } catch { /* Periodic reads still report unavailable state and recover independently. */ }
  }
  try {
    rootWatch=watch(root,{persistent:false},(_event,name)=>{
      if(!name||String(name)==='orca-profile-index.json'){direct(indexPath,changedIndex);changedIndex()}
    })
    rootWatch.on('error',onChange)
    direct(indexPath,changedIndex)
    void configure()
  } catch { /* Polling remains active when watching is unsupported. */ }
  return()=>{stopped=true;rootWatch?.close();profileWatch?.close();for(const watcher of files.values())watcher.close();files.clear()}
}
