import {assert,test} from 'orca/testing'
import {boundedJSON,MAX_RESPONSE_BYTES,MAX_PANEL_BYTES,panelSnapshot} from './bounds'
import {sampleSnapshot} from './fixtures'
import {parseCards} from './metrics'
test('HTTP bodies are capped before JSON parsing, including chunked responses',async()=>{
 await assert.rejects(boundedJSON(new Response('{}',{headers:{'content-length':String(MAX_RESPONSE_BYTES+1)}})))
 let canceled=false
 const stream=new ReadableStream({pull(c){c.enqueue(new Uint8Array(1024*1024))},cancel(){canceled=true}})
 await assert.rejects(boundedJSON(new Response(stream)));assert.equal(canceled,true)
 assert.deepEqual(await boundedJSON(Response.json({ok:true})),{ok:true})
})
test('large long-running session lists produce a bounded panel snapshot',()=>{
 const data=sampleSnapshot(),seed=data.sessions[0]
 data.sessions=Array.from({length:500},(_,i)=>({...seed,key:String(i),session:String(i),conversation:{...seed.conversation!,prompt:'长'.repeat(4000)}}))
 const next=panelSnapshot(data)
 assert.ok(next.sessions.length<=100)
 assert.ok(new TextEncoder().encode(JSON.stringify(next)).byteLength<=MAX_PANEL_BYTES)
 assert.ok((next.omittedSessions||0)>=400)
})
test('worker snapshots contain only JSON values and omit unselected quota details',()=>{
 const data=sampleSnapshot()
 data.sessions[0].conversation=undefined
 data.cards.push(...parseCards({data:[{provider:'deepseek',balance:'¥42',windows:[{name:'Credits',used:50}]}]}))
 const result=panelSnapshot(data)
 assert.deepEqual(JSON.parse(JSON.stringify(result)),result)
 assert.deepEqual(result.cards.find(c=>c.provider==='deepseek')!.windows,[])
 assert.equal(result.cards[0].windows[0].used,12)
})
