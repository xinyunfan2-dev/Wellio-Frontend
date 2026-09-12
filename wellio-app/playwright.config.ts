import {defineConfig} from '@playwright/test'
import {existsSync,readdirSync} from 'node:fs'
import {homedir} from 'node:os'
import {join} from 'node:path'
function localChromium(){
 if(process.env.PLAYWRIGHT_EXECUTABLE_PATH)return process.env.PLAYWRIGHT_EXECUTABLE_PATH
 const cache=join(homedir(),'Library/Caches/ms-playwright');if(!existsSync(cache))return undefined
 for(const dir of readdirSync(cache).filter(x=>/^chromium-\d+$/.test(x)).sort((a,b)=>Number(b.split('-')[1])-Number(a.split('-')[1])))for(const file of ['chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing','chrome-mac/Chromium.app/Contents/MacOS/Chromium','chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium']){const p=join(cache,dir,file);if(existsSync(p))return p}
}
export default defineConfig({testDir:'./tests/e2e',fullyParallel:true,workers:2,use:{baseURL:'http://127.0.0.1:3101',launchOptions:{executablePath:localChromium()},trace:'retain-on-failure'},webServer:{command:'npm start',url:'http://127.0.0.1:3101/today',env:{PORT:'3101',HOST:'127.0.0.1',WELLIO_DATABASE_PATH:join(process.cwd(),'.data','e2e.sqlite')},reuseExistingServer:false,timeout:30000},reporter:[['list']]})
