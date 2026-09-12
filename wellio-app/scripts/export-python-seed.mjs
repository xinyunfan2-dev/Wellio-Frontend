// Offline data export only. Runtime Python does not import or execute TypeScript.
import {build} from 'rolldown'
import {mkdtemp, mkdir, writeFile, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join, resolve} from 'node:path'
import {pathToFileURL} from 'node:url'
const temporary=await mkdtemp(join(tmpdir(),'wellio-seed-export-'))
try {
  const output=join(temporary,'seed.mjs')
  await build({input:resolve('src/server/seed.ts'),platform:'node',output:{file:output,format:'esm'}})
  const {createSeed}=await import(pathToFileURL(output).href)
  const directory=resolve(process.env.WELLIO_BACKEND_DIR || '../wellio-backend', 'wellio/data')
  await mkdir(directory,{recursive:true})
  for(const scenario of ['normal','low_recovery']) {
    const snapshot=createSeed('seed-session',scenario)
    snapshot.conversationId='seed-conversation'
    await writeFile(join(directory,`${scenario}.json`),JSON.stringify(snapshot,null,2)+'\n')
  }
} finally {await rm(temporary,{recursive:true,force:true})}
