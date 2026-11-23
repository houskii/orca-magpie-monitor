import type { Session } from './protocol'
export type SessionUsage = { averageTPS:number|null; output:number; milliseconds:number; samples:number;
  requests:number; startedAt:string|null; checkedAt:number; error:string|null; totalTokens?:number|null; cacheHitRate?:number|null }
const obj=(v:unknown):Record<string,unknown>=>v&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:{}
const count=(v:unknown):number=>typeof v==='number'&&Number.isFinite(v)&&v>=0?v:0
const date=(v:unknown):string|null=>typeof v==='string'&&Number.isFinite(Date.parse(v))?v:null
export const usageKey=(s:Pick<Session,'agent'|'session'>):string=>JSON.stringify([s.agent,s.session])
export async function readSessionUsage(get:(path:string)=>Promise<unknown>,s:Pick<Session,'agent'|'session'>,now:number):Promise<SessionUsage> {
  const params=new URLSearchParams({period:'all',agent:s.agent,q:s.session,via:'through',limit:'1'})
  const path=()=>'/v1/magpie/usage/requests?'+params.toString()
  let data=obj(await get(path()))
  if(!Array.isArray(data.rows)||typeof data.total!=='number')throw new Error('Magpie usage response format changed')
  function rowOf(v:Record<string,unknown>):Record<string,unknown> {
    const rows=Array.isArray(v.rows)?v.rows:[]
    const row=obj(rows[0])
    if (rows.length && (row.session!==s.session || row.agent!==s.agent)) throw new Error('Magpie session filter mismatch')
    return row
  }
  const latest=rowOf(data)
  let total=count(data.total),first:string|null=null
  if(total===1)first=date(latest.t)
  // Read only the oldest row, never download or retain the request history.
  for(let attempt=0;total>1&&attempt<3;attempt++){
    params.set('offset',String(total-1))
    const oldest=obj(await get(path())),row=rowOf(oldest),next=count(oldest.total)
    data=oldest
    if(next===total){first=date(row.t);break}
    total=next
    if(total===1){first=date(row.t);break}
  }
  const milliseconds=count(data.decode_ms),output=count(data.decode_out),samples=count(data.decode_n)
  const hasTokens=typeof data.input==='number'&&typeof data.output==='number'
  const input=count(data.input),read=count(data.cache_read),write=count(data.cache_write)
  const prompt=input+read+write-count(data.cache_unknown)
  return {averageTPS:milliseconds>0&&samples>0?output*1000/milliseconds:null,output,milliseconds,samples,
    requests:count(data.total),startedAt:first,checkedAt:now,error:null,
    totalTokens:hasTokens?input+count(data.output)+read+write:null,
    cacheHitRate:hasTokens&&prompt>0?Math.min(1,read/prompt):null}
}
export function attachUsage(sessions:Session[],cache:Map<string,SessionUsage>):Session[]{
  const counts=new Map<string,number>()
  for(const s of sessions)counts.set(usageKey(s),(counts.get(usageKey(s))||0)+1)
  return sessions.map(s=>{
    if(s.statsSource==='antigravity-native')return s
    const stats=cache.get(usageKey(s))
    // The aggregate belongs to the whole session. Keep it on the parent row,
    // and do not copy it into children that share the same session ID.
    if(s.subagent&&(counts.get(usageKey(s))||0)>1)return {...s,
      averageTPS:null,measuredOutput:0,generationMs:0,measuredRequests:0,startedAt:null,
      totalTokens:null,cacheHitRate:null,statsSource:'unavailable',
      statsError:'Magpie 未返回该子代理的独立历史均速；共享会话的历史汇总显示在主会话。'}
    if(!stats)return {...s,statsSource:'pending'}
    return {...s,averageTPS:stats.averageTPS,measuredOutput:stats.output,generationMs:stats.milliseconds,
      measuredRequests:stats.samples,requests:stats.requests,startedAt:stats.startedAt,
      totalTokens:stats.totalTokens??null,cacheHitRate:stats.cacheHitRate??null,
      statsSource:stats.error?'unavailable':'magpie',statsError:stats.error}
  })
}
