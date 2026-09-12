import {mkdtempSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import type {ActionResult, ChatRequest, Snapshot} from '../../src/lib/contracts'
import {createBackend} from '../../src/server/app'
import {finalOutput, latestToolResult, readEvents, scriptedModel, toolCall, type ModelStep} from './sdk-fixtures'

type Context = {id:string; snapshot:Snapshot}
describe('Stage 4 Today proposal entry and original user load evidence through the real SDK',()=>{
  let directory:string, backend:ReturnType<typeof createBackend>, snapshot:Snapshot, cookie:string
  beforeEach(()=>{
    backend=undefined!
    directory=mkdtempSync(join(tmpdir(),'wellio-proposal-sdk-'))
    vi.stubGlobal('fetch',vi.fn(()=>Promise.reject(new Error('Unexpected external network request'))))
  })
  afterEach(()=>{backend?.close();rmSync(directory,{recursive:true,force:true});vi.unstubAllGlobals()})
  async function open(steps:ModelStep[]){
    const model=scriptedModel(steps)
    backend=createBackend({databasePath:join(directory,'state.sqlite'),cookieSecure:false,agent:{model}})
    const response=await backend.handleRequest(new Request('http://wellio.test/api/state'))
    snapshot=await response.json() as Snapshot;cookie=response.headers.get('set-cookie')!.split(';')[0]
    return model
  }
  async function action(input:Record<string,unknown>){
    return backend.handleRequest(new Request('http://wellio.test/api/actions',{method:'POST',headers:{cookie,'content-type':'application/json'},body:JSON.stringify({requestId:crypto.randomUUID(),resetEpoch:1,source:'today',...input})}))
  }
  async function chat(message:string){
    const request:ChatRequest={requestId:crypto.randomUUID(),resetEpoch:1,source:'user',conversationId:snapshot.conversationId,locale:'en',attachmentIds:[],message}
    return readEvents(await backend.handleRequest(new Request('http://wellio.test/api/chat',{method:'POST',headers:{cookie,'content-type':'application/json'},body:JSON.stringify(request)})))
  }
  async function state(){return (await backend.handleRequest(new Request('http://wellio.test/api/state',{headers:{cookie}}))).json() as Promise<Snapshot>}
  function proposeCurrent(options:Parameters<ModelStep>[0]){
    const context=latestToolResult<Context>(options,'get_day_context')
    return toolCall('propose_workout',{scope:'workout',contextReadId:context.id,reason:{en:'Keep the verified gym workout.','zh-CN':'保留已核实的场馆训练。'},workout:context.snapshot.workout})
  }

  it('routes Today request_proposal with its gym through the same SDK, persists its proposal, and replays without another model run',async()=>{
    const model=await open([
      options=>{expect(JSON.stringify(options.prompt)).toContain('Verified Today button event: generate a workout proposal for gym-b');return toolCall('get_day_context')},
      proposeCurrent,
      options=>{expect(latestToolResult(options,'propose_workout')).toMatchObject({result:{status:'succeeded'}});return finalOutput()},
    ])
    const request={kind:'request_proposal',requestId:'today-sdk-proposal',gymId:'gym-b'}
    const response=await action(request);expect(response.status).toBe(200)
    const result=await response.json() as ActionResult
    expect(result).toMatchObject({status:'succeeded',proposalId:expect.any(String)})
    const saved=await state()
    expect(saved.proposals).toHaveLength(1)
    expect(saved.proposals[0]).toMatchObject({id:result.proposalId,status:'pending',workout:{gymId:'gym-b'}})
    expect(saved.workout).toEqual(snapshot.workout)
    expect(saved.messages.filter(message=>message.role==='user')).toHaveLength(0)
    expect(saved.messages.filter(message=>message.role==='assistant')).toHaveLength(1)
    expect(saved.messages.at(-1)).toMatchObject({status:'complete',proposalId:result.proposalId})
    expect(await (await action(request)).json()).toEqual(result)
    expect(model.doStreamCalls).toHaveLength(3)
    expect(vi.mocked(fetch)).not.toHaveBeenCalled()
  })

  it('binds Today selected gym before accepting a candidate and never applies a mismatch',async()=>{
    const model=await open([()=>toolCall('get_day_context'),proposeCurrent,options=>{
      expect(latestToolResult(options,'propose_workout')).toMatchObject({status:'failed',errorCode:'UI_GYM_MISMATCH'})
      return finalOutput({markdown:'A workout for the selected gym is still needed.',trainingSummary:'Current workout unchanged.',nutritionSummary:'Meals unchanged.'})
    }])
    const result=await (await action({kind:'request_proposal',gymId:'gym-a'})).json() as ActionResult
    expect(result).toMatchObject({status:'needs_input',errorCode:'PROPOSAL_NOT_CREATED'})
    expect((await state()).proposals).toHaveLength(0)
    expect((await state()).conditions).toEqual(snapshot.conditions)
    expect((await state()).workout).toEqual(snapshot.workout)
    expect(model.doStreamCalls).toHaveLength(3)
  })

  it('rejects an automatic Action source before creating messages or using the SDK',async()=>{
    const model=await open([])
    const response=await action({kind:'request_proposal',source:'app_open'})
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({errorCode:'PROPOSAL_REQUIRES_USER_ACTION'})
    expect((await state()).messages).toHaveLength(0)
    expect(model.doStreamCalls).toHaveLength(0)
  })

  it('accepts a named machine-stack confirmation only with its server-stored original-message citation, including Apply',async()=>{
    let sourceMessageId=''
    const model=await open([()=>toolCall('get_day_context'),options=>{
      const system=options.prompt.filter(message=>message.role==='system').map(message=>message.content).join('\n')
      sourceMessageId=system.match(/sourceMessageId ([0-9a-f-]+):/)?.[1]??''
      expect(sourceMessageId).not.toBe('')
      const context=latestToolResult<Context>(options,'get_day_context')
      const workout=structuredClone(context.snapshot.workout!)
      const row=workout.exercises.find(exercise=>exercise.catalogId==='seated-cable-row')!
      row.suggestedLoad={value:40,unit:'kg',basis:'machine_stack',source:'user',sourceMessageId,reason:{en:'Explicitly confirmed by the user.','zh-CN':'用户明确确认。'}}
      return toolCall('propose_workout',{scope:'workout',contextReadId:context.id,reason:{en:'Use the confirmed cable-row load.','zh-CN':'使用已确认的划船重量。'},workout})
    },options=>{expect(latestToolResult(options,'propose_workout')).toMatchObject({result:{status:'succeeded'}});return finalOutput()}])
    const events=await chat('I confirm 40 kg machine stack for seated cable row')
    expect(events.at(-1)?.type).toBe('done')
    const proposed=await state(), proposal=proposed.proposals.at(-1)!
    expect(proposal).toBeDefined()
    expect(proposed.workout).toEqual(snapshot.workout)
    expect(proposed.messages.find(message=>message.id===sourceMessageId)).toMatchObject({role:'user',content:'I confirm 40 kg machine stack for seated cable row'})
    const applied=await (await action({kind:'apply_proposal',proposalId:proposal.id,startAfterApply:false})).json() as ActionResult
    expect(applied).toMatchObject({status:'succeeded',applyStatus:'succeeded'})
    expect(applied.snapshot!.workout!.exercises.find(exercise=>exercise.catalogId==='seated-cable-row')!.suggestedLoad).toMatchObject({value:40,source:'user',sourceMessageId})
    expect(applied.snapshot!.history.load).toEqual(snapshot.history.load)
    expect(model.doStreamCalls).toHaveLength(3)
  })

  it('rejects a forged source=user load from an ordinary request even when the SDK proposes it',async()=>{
    await open([()=>toolCall('get_day_context'),options=>{
      const context=latestToolResult<Context>(options,'get_day_context'),workout=structuredClone(context.snapshot.workout!)
      workout.exercises[0].suggestedLoad={value:40,unit:'kg',basis:'machine_stack',source:'user',sourceMessageId:crypto.randomUUID(),reason:{en:'Unverified','zh-CN':'未核实'}}
      return toolCall('propose_workout',{scope:'workout',contextReadId:context.id,reason:{en:'Review','zh-CN':'检查'},workout})
    },options=>{expect(latestToolResult(options,'propose_workout')).toMatchObject({result:{status:'needs_input',errorCode:'LOAD_CONFIRMATION_REQUIRED'}});return finalOutput()}])
    const events=await chat('Please suggest a workout.')
    expect(events.at(-1)?.type).toBe('done')
    expect((await state()).proposals).toHaveLength(0)
    expect((await state()).history.load).toEqual(snapshot.history.load)
  })

  it('does not let an older confirmed value override a newer confirmation for the same session and equipment',async()=>{
    let oldSource=''
    await open([
      ()=>toolCall('get_day_context'),options=>{
        oldSource=JSON.stringify(options.prompt).match(/sourceMessageId ([0-9a-f-]+):/)?.[1]??''
        expect(oldSource).not.toBe('');return finalOutput()
      },
      ()=>toolCall('get_day_context'),()=>finalOutput(),
      ()=>toolCall('get_day_context'),options=>{
        const context=latestToolResult<Context>(options,'get_day_context'),workout=structuredClone(context.snapshot.workout!)
        workout.exercises.find(exercise=>exercise.catalogId==='seated-cable-row')!.suggestedLoad={value:40,unit:'kg',basis:'machine_stack',source:'user',sourceMessageId:oldSource,reason:{en:'Old confirmation','zh-CN':'旧确认'}}
        return toolCall('propose_workout',{scope:'workout',contextReadId:context.id,reason:{en:'Review','zh-CN':'检查'},workout})
      },options=>{expect(latestToolResult(options,'propose_workout')).toMatchObject({result:{status:'needs_input',errorCode:'LOAD_CONFIRMATION_REQUIRED'}});return finalOutput()},
    ])
    expect((await chat('I confirm 40 kg machine stack for seated cable row')).at(-1)?.type).toBe('done')
    expect((await chat('I confirm 45 kg machine stack for seated cable row')).at(-1)?.type).toBe('done')
    expect((await chat('Please suggest a workout.')).at(-1)?.type).toBe('done')
    expect((await state()).proposals).toHaveLength(0)
  })
})
