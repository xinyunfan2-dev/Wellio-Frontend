// Run after npm run build. Uses a temporary real DB and fresh production processes.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { build } from 'rolldown'
import sharp from 'sharp'

const appDirectory = resolve(import.meta.dirname, '../..')
const directory = await mkdtemp(join(tmpdir(), 'wellio-production-smoke-'))
const databasePath = join(directory, 'wellio.sqlite')
let child
let output = ''
let baseUrl
let serviceDatabase
let sdkBackend

// Explicitly isolate every production child from inherited provider/search credentials.
const offlineEnvironment = {
  WELLIO_AI_MODEL: '', LOVABLE_API_KEY: '', WELLIO_AI_PROTOCOL: '', WELLIO_AI_BASE_URL: '',
  WELLIO_LOVABLE_FIRECRAWL_ENDPOINT: '', WELLIO_LOVABLE_FIRECRAWL_TOKEN: '',
  OPENAI_API_KEY: '', FIRECRAWL_API_KEY: '',
}

async function start() {
  const listener = createServer()
  listener.listen(0, '127.0.0.1')
  await once(listener, 'listening')
  const port = listener.address().port
  await new Promise((resolveClose, reject) => listener.close(error => error ? reject(error) : resolveClose()))
  baseUrl = `http://127.0.0.1:${port}`
  output = ''
  child = spawn(process.execPath, ['.output/server/index.mjs'], {
    cwd: appDirectory,
    env: { ...process.env, ...offlineEnvironment, NODE_ENV: 'production', HOST: '127.0.0.1', PORT: String(port), NITRO_PORT: String(port), WELLIO_DATABASE_PATH: databasePath, WELLIO_COOKIE_SECURE: '0', VITE_WELLIO_PREVIEW: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', chunk => { output += chunk })
  child.stderr.on('data', chunk => { output += chunk })
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error(`Production server exited: ${output}`)
    try {
      const response = await fetch(`${baseUrl}/api/state`, { signal: AbortSignal.timeout(500) })
      assert.equal(response.status, 200)
      return { cookie: response.headers.get('set-cookie').split(';')[0], snapshot: await response.json() }
    } catch (error) {
      if (attempt === 99) throw new Error(`Production server did not become ready: ${output}`, { cause: error })
      await delay(100)
    }
  }
}

async function stop() {
  if (!child || child.exitCode !== null) return
  const exited = once(child, 'exit')
  child.kill('SIGTERM')
  const timeout = setTimeout(() => child.kill('SIGKILL'), 5000)
  try { await exited } finally { clearTimeout(timeout); child = undefined }
}

async function state(cookie) {
  const response = await fetch(`${baseUrl}/api/state?preview=1`, { headers: { cookie } })
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  return response.json()
}

async function action(cookie, body, status = 200) {
  const response = await fetch(`${baseUrl}/api/actions`, {
    method: 'POST', headers: { cookie, origin: baseUrl, 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
  assert.equal(response.status, status)
  return response.json()
}

async function upload(cookie, bytes, purpose) {
  const body = new FormData()
  body.set('file', new File([bytes], 'production.png', { type: 'image/png' }))
  body.set('purpose', purpose)
  const response = await fetch(`${baseUrl}/api/attachments`, { method: 'POST', headers: { cookie, origin: baseUrl }, body })
  assert.equal(response.status, 200, await response.clone().text())
  const attachment = await response.json()
  assert.match(attachment.id, /^[0-9a-f-]{36}$/)
  assert.equal(attachment.url, `/api/attachments/${attachment.id}`)
  assert.equal(attachment.mediaType, 'image/png')
  assert.equal(attachment.purpose, purpose)
  return attachment
}

async function readAttachment(cookie, attachment, bytes, status = 200) {
  const response = await fetch(`${baseUrl}${attachment.url}`, { headers: { cookie } })
  assert.equal(response.status, status)
  if (status !== 200) {
    assert.equal((await response.json()).errorCode, 'ATTACHMENT_NOT_FOUND')
    return
  }
  assert.equal(response.headers.get('content-type'), 'image/png')
  assert.equal(response.headers.get('cache-control'), 'private, no-store')
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes)
}

// Reading through the unconfigured production process updates capabilities and, for
// an idle check only, makes its unavailability explicit. All durable content must match.
function normalizedSdkSnapshot(snapshot) {
  const normalized = structuredClone(snapshot)
  delete normalized.revision
  normalized.capabilities = { ...normalized.capabilities, agent: false, menuSearch: false }
  if (normalized.readinessCheck?.status === 'idle') normalized.readinessCheck = { ...normalized.readinessCheck, status: 'unavailable', errorCode: 'PROVIDER_NOT_CONFIGURED' }
  return normalized
}

function withoutRevision(snapshot) {
  const saved = structuredClone(snapshot)
  delete saved.revision
  return saved
}

try {
  // Neither preview code nor any server database/key module may reach browser assets.
  const assets = join(appDirectory, '.output/public/assets')
  for (const name of await readdir(assets)) {
    if (!name.endsWith('.js')) continue
    const contents = await readFile(join(assets, name), 'utf8')
    assert.doesNotMatch(contents, /preview-session|session_signing_key_v1|node:sqlite/)
  }

  const first = await start()
  const secondResponse = await fetch(`${baseUrl}/api/state`)
  const secondCookie = secondResponse.headers.get('set-cookie').split(';')[0]
  const second = await secondResponse.json()
  assert.notEqual(first.snapshot.sessionId, second.sessionId)
  assert.equal(first.snapshot.capabilities.persistence, 'server')
  assert.equal(first.snapshot.workout.source, 'demo_preset')
  const locale = await action(first.cookie, { kind: 'set_locale', locale: 'zh-CN', requestId: 'production-locale', resetEpoch: 1, source: 'profile' })
  assert.equal(locale.snapshot.locale, 'zh-CN')
  assert.deepEqual(await state(secondCookie), second)
  const resetRequest = { kind: 'reset_demo', scenario: 'low_recovery', requestId: 'production-reset', resetEpoch: 1, source: 'profile' }
  const reset = await action(first.cookie, resetRequest)
  assert.equal(reset.snapshot.resetEpoch, 2)
  assert.equal(reset.snapshot.locale, 'zh-CN')
  assert.equal(reset.snapshot.readiness.score, 42)
  assert.equal(reset.snapshot.sleep.minutes, 240)
  assert.deepEqual(await action(first.cookie, resetRequest), reset)
  assert.equal((await action(first.cookie, { kind: 'set_locale', locale: 'en', requestId: 'production-old', resetEpoch: 1, source: 'profile' }, 409)).errorCode, 'STALE_EPOCH')
  const startRequest = { kind: 'start_workout', workoutId: second.workout.id, expectedWorkoutVersion: second.workout.version, requestId: 'production-start', resetEpoch: 1, source: 'today' }
  const started = await action(secondCookie, startRequest)
  assert.equal(started.snapshot.workout.status, 'in_progress')
  assert.deepEqual(await action(secondCookie, startRequest), started)
  const completed = await action(secondCookie, { kind: 'complete_exercise', workoutId: second.workout.id, exerciseId: second.workout.exercises[0].id, expectedWorkoutVersion: started.snapshot.workout.version, requestId: 'production-complete', resetEpoch: 1, source: 'workout' })
  const finishRequest = { kind: 'finish_workout', workoutId: second.workout.id, actualMinutes: 12, confirmIncomplete: true, expectedWorkoutVersion: completed.snapshot.workout.version, requestId: 'production-finish', resetEpoch: 1, source: 'workout' }
  const finished = await action(secondCookie, finishRequest)
  assert.equal(finished.snapshot.workout.status, 'completed')
  assert.equal(finished.snapshot.workout.exercises.filter(exercise => exercise.completed).length, 1)
  assert.equal(finished.snapshot.history.training.length, second.history.training.length + 1)
  assert.deepEqual(finished.snapshot.history.load, second.history.load)
  assert.equal(finished.snapshot.profile.expenditure, second.profile.expenditure)
  // Exercise server-only meal/condition services against the same disk as the production HTTP server.
  // Bundle the harness into the temporary folder; do not add a test-only production API.
  const harnessPath = join(directory, 'trusted-services.mjs')
  await build({
    input: join(appDirectory, 'tests/backend/production-services.ts'), platform: 'node',
    // Keep installed packages (including Sharp's native decoder) outside the temporary bundle.
    external: id => !id.startsWith('.') && !id.startsWith('/') && !id.startsWith('\0'),
    output: { file: harnessPath, format: 'esm', paths: id => id.startsWith('node:') ? id : import.meta.resolve(id) },
  })
  const { WellioDatabase, recordUserMessage, authorizeUserMutation, mutateMealLog, updateConditions, calculateDailyTotals, createBackend, scriptedModel, toolCall, finalOutput, readEvents } = await import(pathToFileURL(harnessPath).href)
  serviceDatabase = new WellioDatabase(databasePath)
  let sequence = 0
  const authorize = (content, targets = {}) => {
    const snapshot = serviceDatabase.getSnapshot(second.sessionId)
    const source = recordUserMessage(serviceDatabase, second.sessionId, { content, ...targets, requestId: `production-input-${++sequence}`, resetEpoch: snapshot.resetEpoch, conversationId: snapshot.conversationId })
    const runId = `production-run-${sequence}`
    const grant = authorizeUserMutation(serviceDatabase, second.sessionId, { sourceMessageId: source.result.messageId, resetEpoch: snapshot.resetEpoch, runId })
    return { authorizationId: grant.id, runId, requestId: `production-mutation-${sequence}`, resetEpoch: snapshot.resetEpoch }
  }
  const portion = { en: '100 g', 'zh-CN': '100 g' }
  const addRequest = { ...authorize('Log this meal.'), kind: 'mutate_meal_log', action: 'add', expectedMealRevision: finished.snapshot.mealRevision,
    meal: { period: 'dinner', time: '18:45', items: [{ name: { en: 'Fries', 'zh-CN': '薯条' }, portion, originalPortion: { quantity: 100, unit: 'g' }, nutrientUnits: { energy: 'kcal', mass: 'g' }, base: { kcal: 300, protein: 4, carbs: 35, fat: 16 }, consumedFraction: 1, estimated: true }] } }
  const added = mutateMealLog(serviceDatabase, second.sessionId, addRequest)
  const meal = added.result.snapshot.meals.at(-1)
  const halfRequest = { ...authorize('I only ate half of the fries.', { targetMealId: meal.id, targetMealItemId: meal.items[0].id }), kind: 'mutate_meal_log', action: 'update', expectedMealRevision: added.result.snapshot.mealRevision, expectedMealVersion: meal.version, mealId: meal.id, mealItemId: meal.items[0].id, changes: { consumedFraction: 0.5 } }
  const half = mutateMealLog(serviceDatabase, second.sessionId, halfRequest)
  const conditionRequest = { ...authorize('Set dinner budget to HK$70.; Set available time to 15 minutes.'), kind: 'update_conditions', expectedConditionsVersion: half.result.snapshot.conditions.version, changes: { dinnerBudget: 70, availableMinutes: 15 } }
  const condition = updateConditions(serviceDatabase, second.sessionId, conditionRequest)
  const persisted = condition.result.snapshot
  assert.equal(persisted.meals.at(-1).items[0].consumedFraction, .5)
  assert.equal(calculateDailyTotals(persisted).consumed.kcal, calculateDailyTotals(finished.snapshot).consumed.kcal + 150)
  assert.deepEqual(await state(secondCookie), persisted)
  assert.deepEqual(persisted.history, finished.snapshot.history)
  serviceDatabase.close()
  serviceDatabase = undefined
  await stop()

  await start()
  assert.deepEqual(await state(first.cookie), reset.snapshot)
  assert.deepEqual(await state(secondCookie), persisted)
  assert.deepEqual(await action(secondCookie, finishRequest), finished)
  serviceDatabase = new WellioDatabase(databasePath)
  assert.deepEqual(mutateMealLog(serviceDatabase, second.sessionId, halfRequest), half)
  assert.deepEqual(updateConditions(serviceDatabase, second.sessionId, conditionRequest), condition)
  assert.deepEqual(await state(secondCookie), persisted)
  serviceDatabase.close()
  serviceDatabase = undefined
  const undoHalfRequest = { kind: 'undo_meal', operationId: half.result.operationId, requestId: 'production-undo-half', resetEpoch: 1, source: 'agent' }
  assert.equal((await action(first.cookie, { ...undoHalfRequest, resetEpoch: 2 }, 404)).errorCode, 'NOT_FOUND')
  const restored = await action(secondCookie, undoHalfRequest)
  assert.equal(restored.snapshot.meals.at(-1).items[0].consumedFraction, 1)
  assert.ok(restored.snapshot.meals.at(-1).version > persisted.meals.at(-1).version)
  assert.deepEqual(await action(secondCookie, undoHalfRequest), restored)
  assert.deepEqual(restored.snapshot.conditions, persisted.conditions)
  await stop()
  await start()
  assert.deepEqual(await state(secondCookie), restored.snapshot)
  assert.deepEqual(await action(secondCookie, undoHalfRequest), restored)
  const undoneAdd = await action(secondCookie, { kind: 'undo_meal', operationId: added.result.operationId, requestId: 'production-undo-add', resetEpoch: 1, source: 'agent' })
  assert.deepEqual(undoneAdd.snapshot.meals, finished.snapshot.meals)
  assert.deepEqual(undoneAdd.snapshot.history, finished.snapshot.history)
  assert.deepEqual(await action(first.cookie, resetRequest), reset)

  // Stage 4: the actual production upload route stores decodable private image bytes.
  const png = await sharp({ create: { width: 4, height: 3, channels: 3, background: { r: 20, g: 130, b: 75 } } }).png().toBuffer()
  const firstAttachment = await upload(first.cookie, png, 'food')
  const secondAttachment = await upload(secondCookie, png, 'menu')
  await readAttachment(first.cookie, firstAttachment, png)
  await readAttachment(secondCookie, firstAttachment, png, 404)
  const attachmentRoot = join(directory, 'attachments', first.snapshot.sessionId, '2', firstAttachment.id)
  assert.equal((await stat(attachmentRoot)).mode & 0o777, 0o700)
  assert.equal((await stat(join(attachmentRoot, 'image.bin'))).mode & 0o777, 0o600)
  assert.equal((await stat(join(attachmentRoot, 'metadata.json'))).mode & 0o777, 0o600)

  // The harness shares the production DB and cookie, but injects an official mock
  // provider into the real SDK. No additional production route or remote provider exists.
  const userAnswer = { markdown: 'Your recorded workout is completed. Review the current gym equipment and keep the recorded meals.', trainingSummary: 'The recorded workout is completed.', nutritionSummary: 'Use the recorded meals and HK$70 dinner budget.' }
  const readinessAnswer = { markdown: 'Recovery is 42/100 after four hours of sleep. Review recovery before choosing another session.', trainingSummary: 'Recovery is 42/100; review recovery before another session.', nutritionSummary: 'Keep the recorded meals unchanged while planning dinner.' }
  const model = scriptedModel([
    () => toolCall('get_day_context', {}, 'production-user-context'),
    () => toolCall('get_gym_equipment', { gymId: undoneAdd.snapshot.conditions.gymId }, 'production-user-equipment'),
    () => finalOutput(userAnswer),
    () => toolCall('get_day_context', {}, 'production-auto-context'),
    () => finalOutput(readinessAnswer),
  ])
  sdkBackend = createBackend({ databasePath, cookieSecure: false, agent: { model }, menuSearch: {} })
  let userSdkSnapshot, readinessSdkSnapshot
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => { throw new Error('External fetch is forbidden in the production SDK harness') }
  try {
    const sdkState = async cookie => {
      const response = await sdkBackend.handleRequest(new Request('http://production-harness.test/api/state', { headers: { cookie } }))
      assert.equal(response.status, 200)
      assert.equal(response.headers.get('set-cookie'), null)
      return response.json()
    }
    const run = async (cookie, body) => {
      const response = await sdkBackend.handleRequest(new Request('http://production-harness.test/api/chat', { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) }))
      assert.equal(response.status, 200)
      assert.match(response.headers.get('content-type'), /application\/x-ndjson/)
      const events = await readEvents(response)
      assert.ok(events.every(event => event.requestId === body.requestId && event.resetEpoch === body.resetEpoch))
      return events
    }
    const beforeUser = await sdkState(secondCookie)
    const userRequest = { requestId: 'production-sdk-user', resetEpoch: beforeUser.resetEpoch, conversationId: beforeUser.conversationId, message: 'Review my recorded workout, meals, and gym equipment.', locale: 'en', attachmentIds: [], source: 'user' }
    const userEvents = await run(secondCookie, userRequest)
    assert.deepEqual(userEvents.slice(-2).map(event => event.type), ['snapshot', 'done'])
    userSdkSnapshot = await sdkState(secondCookie)
    const userMessage = userSdkSnapshot.messages.at(-1)
    assert.equal(userMessage.status, 'complete')
    assert.equal(userMessage.content, userAnswer.markdown)
    assert.deepEqual(userMessage.steps.map(step => [step.toolCallId, step.operation, step.status]), [['production-user-context', 'context', 'succeeded'], ['production-user-equipment', 'equipment', 'succeeded']])
    assert.deepEqual(userSdkSnapshot.advice.training, { en: userAnswer.trainingSummary, 'zh-CN': userAnswer.trainingSummary })
    assert.deepEqual(userSdkSnapshot.advice.nutrition, { en: userAnswer.nutritionSummary, 'zh-CN': userAnswer.nutritionSummary })
    assert.equal(userSdkSnapshot.advice.messageId, userMessage.id)
    assert.equal(userSdkSnapshot.advice.status, 'valid')
    assert.deepEqual(userSdkSnapshot.history, beforeUser.history)
    assert.deepEqual(userSdkSnapshot.meals, beforeUser.meals)
    assert.deepEqual(userSdkSnapshot.workout, beforeUser.workout)
    assert.equal(model.doStreamCalls.length, 3)

    const beforeReadiness = await sdkState(first.cookie)
    const autoRequest = { requestId: 'production-sdk-auto', resetEpoch: beforeReadiness.resetEpoch, conversationId: beforeReadiness.conversationId, message: '', locale: 'zh-CN', attachmentIds: [], source: 'app_open', checkMode: 'auto' }
    const autoEvents = await run(first.cookie, autoRequest)
    assert.deepEqual(autoEvents.slice(-2).map(event => event.type), ['snapshot', 'done'])
    readinessSdkSnapshot = await sdkState(first.cookie)
    assert.equal(readinessSdkSnapshot.messages.length, beforeReadiness.messages.length + 1)
    assert.deepEqual(readinessSdkSnapshot.messages.filter(message => message.role === 'user'), beforeReadiness.messages.filter(message => message.role === 'user'))
    const autoMessage = readinessSdkSnapshot.messages.at(-1)
    assert.equal(autoMessage.source, 'app_open')
    assert.equal(autoMessage.status, 'complete')
    assert.equal(autoMessage.content, readinessAnswer.markdown)
    assert.deepEqual(autoMessage.steps.map(step => [step.toolCallId, step.operation, step.status]), [['production-auto-context', 'context', 'succeeded']])
    assert.equal(readinessSdkSnapshot.readinessCheck.status, 'completed')
    assert.equal(readinessSdkSnapshot.readinessCheck.messageId, autoMessage.id)
    assert.equal(readinessSdkSnapshot.advice.messageId, autoMessage.id)
    assert.deepEqual(readinessSdkSnapshot.advice.training, { en: readinessAnswer.trainingSummary, 'zh-CN': readinessAnswer.trainingSummary })
    assert.deepEqual(readinessSdkSnapshot.advice.nutrition, { en: readinessAnswer.nutritionSummary, 'zh-CN': readinessAnswer.nutritionSummary })
    assert.deepEqual(readinessSdkSnapshot.proposals, beforeReadiness.proposals)
    assert.deepEqual(readinessSdkSnapshot.plan, beforeReadiness.plan)
    const cachedEvents = await run(first.cookie, { ...autoRequest, requestId: 'production-sdk-auto-again' })
    assert.deepEqual(cachedEvents.map(event => event.type), ['snapshot', 'check_result'])
    assert.equal(cachedEvents.at(-1).outcome, 'reused')
    assert.deepEqual(await sdkState(first.cookie), readinessSdkSnapshot)
    assert.equal(model.doStreamCalls.length, 5)
  } finally {
    globalThis.fetch = originalFetch
    sdkBackend.close()
    sdkBackend = undefined
  }
  const productionUser = await state(secondCookie)
  const productionReadiness = await state(first.cookie)
  assert.equal(productionUser.capabilities.agent, false)
  assert.equal(productionReadiness.capabilities.agent, false)
  assert.deepEqual(withoutRevision(productionUser), normalizedSdkSnapshot(userSdkSnapshot))
  assert.deepEqual(withoutRevision(productionReadiness), normalizedSdkSnapshot(readinessSdkSnapshot))
  await stop()
  await start()
  assert.deepEqual(await state(secondCookie), productionUser)
  assert.deepEqual(await state(first.cookie), productionReadiness)
  await readAttachment(first.cookie, firstAttachment, png)
  await readAttachment(secondCookie, secondAttachment, png)
  await readAttachment(secondCookie, firstAttachment, png, 404)
  const finalResetRequest = { kind: 'reset_demo', scenario: 'normal', requestId: 'production-stage4-reset', resetEpoch: 2, source: 'profile' }
  const finalReset = await action(first.cookie, finalResetRequest)
  assert.equal(finalReset.snapshot.resetEpoch, 3)
  await readAttachment(first.cookie, firstAttachment, png, 404)
  await readAttachment(secondCookie, secondAttachment, png)
  assert.deepEqual(await state(secondCookie), productionUser)
  const newEpochAttachment = await upload(first.cookie, png, 'food')
  assert.deepEqual(await action(first.cookie, finalResetRequest), finalReset)
  await readAttachment(first.cookie, newEpochAttachment, png)
  await stop()
  await start()
  await readAttachment(first.cookie, firstAttachment, png, 404)
  await readAttachment(first.cookie, newEpochAttachment, png)
  await readAttachment(secondCookie, secondAttachment, png)
  assert.deepEqual(await state(secondCookie), productionUser)
  assert.equal((await stat(databasePath)).mode & 0o777, 0o600)
  const raw = await readFile(databasePath)
  assert.equal(raw.subarray(0, 16).toString(), 'SQLite format 3\0')
  const unavailable = await fetch(`${baseUrl}/api/chat`, { method: 'POST', headers: { cookie: first.cookie, origin: baseUrl, 'content-type': 'application/json' }, body: '{}' })
  assert.equal(unavailable.status, 503)
  assert.equal((await unavailable.json()).errorCode, 'PROVIDER_NOT_CONFIGURED')
  const page = await fetch(`${baseUrl}/today?preview=1`)
  assert.equal(page.status, 200)
  console.log('PASS: production routes; locale/reset/workout/meal/condition persistence and receipt replay; monotonic meal undo and unchanged history; real SDK user/app-open tool steps, summaries and readiness deduplication persisted through production HTTP and process restarts; PNG upload/original-byte restore, private modes, cross-session/epoch isolation and reset replay; SQLite mode 0600; no provider credentials or external calls; unavailable chat; preview excluded from browser assets.')
} finally {
  sdkBackend?.close()
  serviceDatabase?.close()
  await stop()
  await rm(directory, { recursive: true, force: true })
}
