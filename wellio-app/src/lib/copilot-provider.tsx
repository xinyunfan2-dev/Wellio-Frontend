import {useEffect, type ReactNode} from 'react'
import {CopilotKit, useAgent} from '@copilotkit/react-core/v2'
import {isPreviewMode, registerChatTransport} from './api-client'
import {createCopilotTransport} from './copilot-transport'

function TransportBridge({children}:{children:ReactNode}){
 const {agent,isReady}=useAgent({agentId:'wellio',updates:[]})
 useEffect(()=>{
  if(!isReady)return
  const transport=createCopilotTransport(agent)
  const unregister=registerChatTransport(transport.chat)
  return()=>{unregister();void transport.dispose()}
 },[agent,isReady])
 return children
}

export function WellioCopilotProvider({children}:{children:ReactNode}){
 if(import.meta.env.DEV&&isPreviewMode())return children
 return <CopilotKit runtimeUrl="/api/copilotkit" agent="wellio" credentials="same-origin" useSingleEndpoint={false} enableInspector={false} showDevConsole={false}><TransportBridge>{children}</TransportBridge></CopilotKit>
}
