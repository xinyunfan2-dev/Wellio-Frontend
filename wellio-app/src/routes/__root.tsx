import {createRootRoute,HeadContent,Outlet,Scripts} from '@tanstack/react-router'
import {I18nProvider} from '../lib/i18n'
import {WellioProvider} from '../lib/wellio-context'
import {WellioCopilotProvider} from '../lib/copilot-provider'
import {AppShell} from '../components/AppShell'
import appCss from '../app.css?url'
export const Route=createRootRoute({head:()=>({meta:[{charSet:'utf-8'},{name:'viewport',content:'width=device-width, initial-scale=1, viewport-fit=cover'},{title:'Wellio — A healthier day'},{name:'theme-color',content:'#faf9f2'}],links:[{rel:'stylesheet',href:appCss},{rel:'icon',type:'image/png',href:'/assets/wellio-logo.png'}]}),component:Root})
function Root(){return <html lang="en"><head><HeadContent/></head><body><I18nProvider><WellioCopilotProvider><WellioProvider><AppShell><Outlet/></AppShell></WellioProvider></WellioCopilotProvider></I18nProvider><Scripts/></body></html>}
