import {HttpAgent, type AbstractAgent, type AgentSubscriber} from '@ag-ui/client'
import {ApiError, validateChatEvent, type ChatTransport} from './api-client'

const abortError=()=>new DOMException('Aborted','AbortError')
const errorCode=(value:unknown)=>typeof value==='string'&&/^[A-Z][A-Z0-9_]{0,127}$/.test(value)?value:undefined
type ActiveRun={cancel:()=>void;settled:Promise<void>}
// React can replace a bridge while its previous instance is still finalizing.
const agentRuns=new WeakMap<AbstractAgent,ActiveRun>()

function transportError(error:unknown):ApiError{
 if(error instanceof ApiError)return error
 const detail=error!==null&&typeof error==='object'?error as {status?:unknown;payload?:unknown}:{}
 const payload=detail.payload!==null&&typeof detail.payload==='object'?detail.payload as {errorCode?:unknown}:{}
 return new ApiError(errorCode(payload.errorCode)||'PROVIDER_ERROR',typeof detail.status==='number'?detail.status:0)
}

/** Uses the runtime-discovered SDK instance; no second chat HTTP implementation. */
export function createCopilotTransport(agent:AbstractAgent){
 let disposed=false
 let active:ActiveRun|undefined
 const chat:ChatTransport=async(request,onEvent,signal)=>{
  signal.throwIfAborted()
  if(disposed)throw abortError()
  if(agentRuns.has(agent))throw new ApiError('RUN_IN_PROGRESS',409)
  let release!:()=>void
  const settled=new Promise<void>(resolve=>{release=resolve})
  let cancelled=false,stopped=false,initialized=false,started=false,finished=false,terminal=false,count=0
  let failure:ApiError|undefined,checkKey:string|undefined
  let finalizationComplete!:()=>void
  const finalized=new Promise<void>(resolve=>{finalizationComplete=resolve})
  const stop=()=>{
   if(stopped)return
   stopped=true
   agent.abortRun()
   // The CopilotKit proxy sends /stop but does not abort its inherited HTTP reader.
   // Abort that public SDK controller too, so disconnect and local cleanup agree.
   if(agent instanceof HttpAgent)agent.abortController.abort()
  }
  const cancel=()=>{cancelled=true;stop()}
  const fail=(error:ApiError)=>{failure??=error;stop()}
  const reservation={cancel,settled}
  active=reservation
  agentRuns.set(agent,reservation)
  const subscriber:AgentSubscriber={
   onRunInitialized:()=>{initialized=true},
   // AG-UI 0.0.59 does not await onFinalize. This is the last subscriber;
   // the next task also lets its queued state mutations finish before reuse.
   onRunFinalized:()=>{setTimeout(finalizationComplete,0)},
   onRunStartedEvent:({event})=>{
    if(event.runId!==request.requestId||event.threadId!==request.conversationId){fail(new ApiError('STREAM_PROTOCOL_ERROR'));return}
    started=true
   },
   onCustomEvent:({event})=>{
    if(event.name!=='wellio'||cancelled||failure)return
    try{
     const value=validateChatEvent(event.value)
     if(!started||terminal||value.requestId!==request.requestId||value.resetEpoch!==request.resetEpoch)throw new ApiError('STREAM_PROTOCOL_ERROR')
     if(value.type==='snapshot'){
      if(value.snapshot.resetEpoch!==request.resetEpoch||value.snapshot.conversationId!==request.conversationId)throw new ApiError('STREAM_PROTOCOL_ERROR')
      checkKey=value.snapshot.readinessCheck?.key
     }
     if(value.type==='check_result'&&(request.source!=='app_open'||!checkKey||value.checkKey!==checkKey))throw new ApiError('STREAM_PROTOCOL_ERROR')
     count++
     terminal=value.type==='done'||value.type==='check_result'||value.type==='error'
     onEvent(value)
     if(value.type==='error')failure=new ApiError(value.errorCode)
    }catch(error){fail(error instanceof ApiError?error:new ApiError('STREAM_PROTOCOL_ERROR'))}
   },
   onRunFinishedEvent:({event})=>{
    if(event.runId!==request.requestId||event.threadId!==request.conversationId){fail(new ApiError('STREAM_PROTOCOL_ERROR'));return}
    finished=true
   },
   // Preflight failures may be RUN_ERROR without RUN_STARTED or a CUSTOM event.
   onRunErrorEvent:({event})=>{failure??=new ApiError(errorCode(event.code)||'PROVIDER_ERROR')},
   onRunFailed:({error})=>{if(!cancelled)failure??=transportError(error)},
  }
  try{
   agent.threadId=request.conversationId
   // Persisted history/context come from the server session, never browser state.
   agent.setMessages([])
   agent.setState({})
   const running=agent.runAgent({runId:request.requestId,forwardedProps:{wellio:request},tools:[],context:[]},subscriber)
   signal.addEventListener('abort',cancel,{once:true})
   if(signal.aborted||disposed)cancel()
   try{await running}catch(error){if(!cancelled)failure??=transportError(error)}
   if(initialized)await finalized
   if(cancelled||signal.aborted)throw abortError()
   if(failure)throw failure
   if(!terminal)throw new ApiError(count?'INCOMPLETE_RESPONSE':'EMPTY_RESPONSE')
   if(!started||!finished)throw new ApiError('INCOMPLETE_RESPONSE')
  }finally{
   signal.removeEventListener('abort',cancel)
   if(agentRuns.get(agent)===reservation)agentRuns.delete(agent)
   active=undefined
   release()
  }
 }
 return {chat,dispose:async()=>{disposed=true;const running=active;if(running){running.cancel();await running.settled}}}
}
