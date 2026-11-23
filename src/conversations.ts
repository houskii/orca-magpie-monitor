import { execFile } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ConversationPreview } from './protocol'

const clean = (v: unknown, limit: number): string => typeof v === 'string' ? v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').slice(0, limit) : ''
export function conversationAgent(value: Record<string, unknown>): { agent?: string; model?: string; effort?: string } {
  const agent = clean(value.agent, 64), model = clean(value.model, 256), effort = clean(value.effort, 64)
  return { ...(agent ? { agent } : {}), ...(model ? { model } : {}), ...(effort ? { effort } : {}) }
}
export function conversationSQL(sessions: string[]): string | null {
  // Bound the query to IDs already observed at Magpie. Quote data, never shell-interpolate it.
  const ids = [...new Set(sessions.filter(s => s.length > 0 && s.length <= 256))].slice(0, 500)
  if (!ids.length) return null
  const list = ids.map(id => "'" + id.replace(/'/g, "''") + "'").join(',')
  return `WITH previews AS (
    SELECT session_id AS orcaSession,
      coalesce(json_extract(record_json, '$.providerHandleChain[#-1].handle.threadId'),
        json_extract(record_json, '$.providerHandleChain[#-1].handle.sessionId'),
        json_extract(record_json, '$.providerHandleChain[#-1].handle.nativeId')) AS session,
      substr(json_extract(record_json, '$.conversationName'), 1, 160) AS title,
      substr(json_extract(record_json, '$.lastTurn.prompt'), 1, 4000) AS prompt,
      json_extract(record_json, '$.provider') AS agent,
      json_extract(record_json, '$.options.model') AS model,
      json_extract(record_json, '$.options.effort') AS effort,
      (json_extract(record_json, '$.lastTurn.state') = 'open') AS running,
      json_extract(record_json, '$.updatedAt') AS updatedAt
    FROM agent_session_records
    WHERE json_extract(record_json, '$.location.executionHostId') = 'local'
  ) SELECT * FROM previews WHERE session IN (${list}) ORDER BY updatedAt DESC LIMIT 500;`
}
export function parseConversations(payload: unknown): ConversationPreview[] {
  if (!Array.isArray(payload)) throw new Error('Orca conversation format changed')
  return payload.slice(0, 500).map(value => {
    const v = value && typeof value === 'object' ? value as Record<string, unknown> : {}
    return { session: clean(v.session, 256), orcaSession: clean(v.orcaSession, 256), title: clean(v.title, 160),
      prompt: clean(v.prompt, 4000), running: v.running === 1 || v.running === true,
      updatedAt: typeof v.updatedAt === 'number' && Number.isFinite(v.updatedAt) ? v.updatedAt : 0,
      ...conversationAgent(v) }
  }).filter(v => v.session && v.orcaSession)
}
export function orcaDataRoot(): string {
  return process.env.ORCA_USER_DATA_PATH || (process.platform === 'darwin'
    ? join(homedir(), 'Library', 'Application Support', 'orca')
    : join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'orca'))
}
/** The domain store replaces the legacy journal. Once present it is authoritative:
 *  missing rows and read failures must not resurrect an older provider handle. */
export async function sessionDatabase(root = orcaDataRoot()): Promise<string> {
  const current = join(root, 'agent-session-domain.db')
  try {
    if (!(await stat(current)).isFile()) throw new Error('Orca conversation store is not a file')
    return current
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return join(root, 'agent-session-journal.db')
  }
}
export async function readSQLite(path: string, sql: string, maxBuffer = 4 * 1024 * 1024): Promise<unknown[]> {
  const stdout = await new Promise<string>((resolve, reject) => {
    execFile(process.platform === 'darwin' ? '/usr/bin/sqlite3' : 'sqlite3', ['-readonly', '-json', path, sql],
      { encoding: 'utf8', timeout: 2000, maxBuffer },
      (error, output) => error ? reject(new Error('Orca conversation store unavailable')) : resolve(output))
  })
  const rows: unknown = JSON.parse(stdout || '[]')
  if (!Array.isArray(rows)) throw new Error('Orca store format changed')
  return rows
}
export async function readConversations(sessions: string[], database?: string): Promise<ConversationPreview[]> {
  const sql = conversationSQL(sessions)
  if (!sql) return []
  return parseConversations(await readSQLite(database || await sessionDatabase(), sql))
}
