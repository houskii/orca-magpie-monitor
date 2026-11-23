import type { Snapshot } from './protocol'
import { quotaSelection } from './metrics'
export const MAX_SESSIONS=100, MAX_RESPONSE_BYTES=2*1024*1024, MAX_PANEL_BYTES=192*1024
export async function boundedJSON(response:Response):Promise<unknown>{
  const length=Number(response.headers.get('content-length'))
  if(length>MAX_RESPONSE_BYTES){await response.body?.cancel();throw new Error('Magpie response too large')}
  const reader=response.body?.getReader()
  if(!reader)throw new Error('Magpie response has no body')
  const chunks:Uint8Array[]=[];let size=0
  try{while(true){const {value,done}=await reader.read();if(done)break;size+=value.byteLength
    if(size>MAX_RESPONSE_BYTES)throw new Error('Magpie response too large');chunks.push(value)}}
  catch(error){await reader.cancel().catch(()=>{});throw error}
  const bytes=new Uint8Array(size);let at=0
  for(const chunk of chunks){bytes.set(chunk,at);at+=chunk.byteLength}
  return JSON.parse(new TextDecoder().decode(bytes))
}
export function panelSnapshot(state:Snapshot):Snapshot{
  const provider = quotaSelection(state.cards, state.quotaProvider).provider
  let result:Snapshot={...state,
    cards:state.showQuota?state.cards.map(c=>c.provider===provider?c:{...c,windows:[],balance:''}):[],
    sessions:state.sessions.slice(0,MAX_SESSIONS),omittedSessions:(state.omittedSessions||0)+Math.max(0,state.sessions.length-MAX_SESSIONS)}
  const size=()=>new TextEncoder().encode(JSON.stringify(result)).byteLength
  if(size()>MAX_PANEL_BYTES)result={...result,sessions:result.sessions.map(s=>({...s,conversation:s.conversation?{...s.conversation,prompt:s.conversation.prompt.slice(0,160)}:undefined}))}
  while(size()>MAX_PANEL_BYTES&&result.sessions.length){result={...result,sessions:result.sessions.slice(0,-1),omittedSessions:(result.omittedSessions||0)+1}}
  // Orca's worker bridge rejects undefined properties, including absent conversation metadata.
  return JSON.parse(JSON.stringify(result)) as Snapshot
}
