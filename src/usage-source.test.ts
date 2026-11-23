import {assert,test} from 'orca/testing'
import {readSessionUsage,attachUsage,usageKey} from './usage-source'
import {sampleSnapshot} from './fixtures'
test('Magpie supplies the all-history counters and the oldest request time in bounded pages',async()=>{
 const session={agent:'orca_desktop',session:'thread'},paths:string[]=[]
 const get=async(path:string)=>{paths.push(path);const q=new URL('http://localhost'+path).searchParams
  assert.equal(q.get('limit'),'1');assert.equal(q.get('period'),'all');assert.equal(q.get('via'),'through')
  return {total:20000,decode_out:600000,decode_ms:10000000,decode_n:10000,input:100,output:200,cache_read:600,cache_write:100,rows:[{agent:session.agent,session:session.session,t:q.has('offset')?'2026-11-01T12:00:00Z':'2026-11-13T12:00:00Z'}]}}
 const stats=await readSessionUsage(get,session,1)
 assert.equal(stats.averageTPS,60);assert.equal(stats.startedAt,'2026-11-01T12:00:00Z')
 assert.equal(stats.requests,20000);assert.equal(paths.length,2);assert.ok(paths[1].includes('offset=19999'))
 assert.equal(stats.totalTokens,1000);assert.equal(stats.cacheHitRate,.75)
 const row={...sampleSnapshot().sessions[0],...session}
 const next=attachUsage([row],new Map([[usageKey(row),stats]]))[0]
 assert.equal(next.measuredOutput,600000);assert.equal(next.generationMs,10000000);assert.equal(next.statsSource,'magpie')
 assert.equal(next.totalTokens,1000);assert.equal(next.cacheHitRate,.75)
})
test('new requests during the oldest-page read cause only a bounded offset correction',async()=>{
 let n=0
 const stats=await readSessionUsage(async path=>{n++;return {total:n===1?2:3,decode_out:10,decode_ms:1000,decode_n:1,
  rows:[{agent:'orca',session:'thread',t:n===3?'2026-11-01T00:00:00Z':'2026-11-13T00:00:00Z'}]}},{agent:'orca',session:'thread'},0)
 assert.equal(n,3);assert.equal(stats.startedAt,'2026-11-01T00:00:00Z')
})
test('a mismatched session or invalid payload cannot become another dialogue mean',async()=>{
 await assert.rejects(readSessionUsage(async()=>({total:1,rows:[{session:'other',agent:'orca'}]}),{agent:'orca',session:'thread'},0))
 await assert.rejects(readSessionUsage(async()=>({data:[]}),{agent:'orca',session:'thread'},0))
})

test('shared-session child rows do not suppress the parent aggregate or duplicate its counters',async()=>{
 const parent={...sampleSnapshot().sessions[0],agent:'claude',session:'shared-thread',subagent:''}
 const child={...parent,key:'child',subagent:'worker-1',averageTPS:999,totalTokens:999,cacheHitRate:1}
 const stats=await readSessionUsage(async()=>({total:1,decode_out:57742,decode_ms:417408,decode_n:57,
  input:452,output:160580,cache_read:32749820,cache_write:936230,
  rows:[{agent:'claude',session:'shared-thread',t:'2026-11-16T08:00:00Z'}]}),parent,0)
 const [main,sub]=attachUsage([parent,child],new Map([[usageKey(parent),stats]]))
 assert.ok(main.averageTPS!==null&&Math.abs(main.averageTPS-138.33467494633547)<.0001)
 assert.equal(main.measuredRequests,57);assert.equal(main.statsSource,'magpie')
 assert.equal(main.totalTokens,33847082)
 assert.equal(sub.averageTPS,null);assert.equal(sub.totalTokens,null);assert.equal(sub.cacheHitRate,null)
 assert.equal(sub.measuredRequests,0);assert.equal(sub.startedAt,null);assert.equal(sub.statsSource,'unavailable')
 assert.ok(sub.statsError?.includes('主会话'))
})
test('a child with its own session ID keeps its independent aggregate',async()=>{
 const parent={...sampleSnapshot().sessions[0],agent:'claude',session:'main-thread',subagent:''}
 const child={...parent,key:'child',session:'independent-thread',subagent:'worker-1'}
 const get=async(path:string)=>{
  const session=new URL('http://localhost'+path).searchParams.get('q')
  return {total:1,decode_out:session==='main-thread'?100:50,decode_ms:1000,decode_n:1,
   rows:[{agent:'claude',session,t:'2026-11-16T08:00:00Z'}]}
 }
 const cache=new Map([
  [usageKey(parent),await readSessionUsage(get,parent,0)],
  [usageKey(child),await readSessionUsage(get,child,0)],
 ])
 const [main,sub]=attachUsage([parent,child],cache)
 assert.equal(main.averageTPS,100);assert.equal(sub.averageTPS,50)
 assert.equal(sub.statsSource,'magpie')
})
