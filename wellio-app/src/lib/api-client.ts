import type {WellioClient,Snapshot,ActionResult,Attachment,ChatEvent} from './contracts'
export class ApiError extends Error { constructor(public code:string,public status=0){super(code)} }
async function json<T>(url:string,init?:RequestInit):Promise<T>{
 const response=await fetch(url,{credentials:'same-origin',...init})
 if(!response.ok){const body=await response.json().catch(()=>({}));throw new ApiError(body.errorCode||'NETWORK_ERROR',response.status)}
 return response.json() as Promise<T>
}
const httpClient:WellioClient={
 getSnapshot:signal=>json<Snapshot>('/api/state',{signal}),
 action:(request,signal)=>json<ActionResult>('/api/actions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(request),signal}),
 upload:(file,purpose,signal)=>{const body=new FormData();body.append('file',file);body.append('purpose',purpose);return json<Attachment>('/api/attachments',{method:'POST',body,signal})},
 async chat(request,onEvent,signal){
  const response=await fetch('/api/chat',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify(request),signal})
  if(!response.ok){const body=await response.json().catch(()=>({}));throw new ApiError(body.errorCode||'PROVIDER_ERROR',response.status)}
  if(!response.body)throw new ApiError('EMPTY_RESPONSE')
  const reader=response.body.getReader(), decoder=new TextDecoder();let buffer='', completed=false, events=0, snapshotCheckKey:string|undefined
  const emit=(event:ChatEvent)=>{
   if(completed||event.requestId!==request.requestId||event.resetEpoch!==request.resetEpoch)throw new ApiError('STREAM_PROTOCOL_ERROR')
   if(event.type==='snapshot')snapshotCheckKey=event.snapshot.readinessCheck?.key
   if(event.type==='check_result'&&(request.source!=='app_open'||!event.checkKey||event.checkKey!==snapshotCheckKey||!['reused','in_progress','not_needed','not_available'].includes(event.outcome)))throw new ApiError('STREAM_PROTOCOL_ERROR')
   if(event.type==='done'&&!event.messageId)throw new ApiError('STREAM_PROTOCOL_ERROR')
   events++;onEvent(event)
   if(event.type==='error')throw new ApiError(event.errorCode)
   if(event.type==='done'||event.type==='check_result')completed=true
  }
  const lineEvent=(line:string)=>{const payload=line.startsWith('data:')?line.slice(5).trim():line.trim();if(payload&&payload!=='[DONE]')emit(JSON.parse(payload) as ChatEvent)}
  try {
   while(true){const {done,value}=await reader.read();if(done)break;buffer+=decoder.decode(value,{stream:true});const lines=buffer.split('\n');buffer=lines.pop()||'';for(const line of lines)lineEvent(line)}
   buffer+=decoder.decode();if(buffer.trim())lineEvent(buffer)
   if(!completed)throw new ApiError(events?'INCOMPLETE_RESPONSE':'EMPTY_RESPONSE')
  } catch(error){await reader.cancel().catch(()=>{});throw error} finally {reader.releaseLock()}
 }
}
async function client():Promise<WellioClient>{
 // This isolated visual adapter is unreachable in production builds.
 if(import.meta.env.DEV && typeof window!=='undefined' && (import.meta.env.VITE_WELLIO_PREVIEW==='1'||new URLSearchParams(location.search).get('preview')==='1'))return (await import('./preview-client')).previewClient
 return httpClient
}
export const api:WellioClient={getSnapshot:async s=>(await client()).getSnapshot(s),action:async(r,s)=>(await client()).action(r,s),upload:async(f,p,s)=>(await client()).upload(f,p,s),chat:async(r,e,s)=>(await client()).chat(r,e,s)}
