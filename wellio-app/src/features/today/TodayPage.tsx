import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { Icon } from '../../components/Icon'
import { Mascot } from '../../components/Mascot'
import { useWellio } from '../../lib/wellio-context'
import { useI18n } from '../../lib/i18n'
import { errorText } from '../../lib/errors'
import { dailyTotals, mealTotals } from '../../lib/format'
import type { ActionInput, Exercise, Meal, Nutrients, Proposal, Snapshot } from '../../lib/contracts'
import './today.css'

type Panel = 'basis' | 'schedule' | 'gym' | 'meal' | null
type MealGroup = { period: Meal['period']; meals: Meal[]; totals: Nutrients }
const bandColors = ['#bd9573', '#9a7eaa', '#7b9fb2', '#809c60']
const bandInk = ['#845f41', '#745483', '#456b82', '#526f37']
const poses = ['recover', 'pace', 'ready', 'energized'] as const
const macroColors = ['#47774a', '#ba7a2a', '#6e7fb2']

/** Equal bands are a presentation scale only; actions use actual proposals. */
function validReadiness(snapshot: Snapshot) {
  const r = snapshot.readiness
  return r.quality === 'valid' && r.dayKey === snapshot.dayKey && r.score !== null && Number.isFinite(r.score) && r.scoreScale > 0 && r.score >= 0 && r.score <= r.scoreScale
}
function currentProposal(proposal: Proposal, snapshot: Snapshot) {
  return proposal.status === 'pending' && proposal.readinessSnapshotId === snapshot.readiness.id
    && proposal.expected.readiness === snapshot.readiness.version
    && proposal.expected.plan === snapshot.plan.version
    && proposal.expected.workout === (snapshot.workout?.version ?? 0)
    && proposal.expected.conditions === snapshot.conditions.version
    && proposal.expected.meal === snapshot.mealRevision
}
function groupedMeals(meals: Meal[]): MealGroup[] {
  const periods: Meal['period'][] = ['lunch', 'breakfast', 'dinner', 'snack']
  return periods.map(period => {
    const group = meals.filter(meal => meal.period === period)
    return { period, meals: group, totals: dailyTotals(group) }
  }).filter(group => group.meals.length)
}

export function TodayPage() {
  const { snapshot, loading, error, busy, chatBusy, readinessBusy, readinessError, checkReadiness, runAction, refresh, setDraft, setChatTarget } = useWellio()
  const { locale, t, text, date, duration } = useI18n()
  const navigate = useNavigate()
  const [panel, setPanel] = useState<Panel>(null)
  const [mealPeriod, setMealPeriod] = useState<Meal['period']>('lunch')
  const [actionKind, setActionKind] = useState<ActionInput['kind'] | null>(null)
  const [feedback, setFeedback] = useState<'saved-not-started' | 'needs-input' | null>(null)
  const dialog = useRef<HTMLDialogElement>(null)
  const number = (value: number, digits = 0) => new Intl.NumberFormat(locale, { maximumFractionDigits: digits }).format(value)
  const disabled = busy || chatBusy
  useEffect(() => {
    if (panel && !dialog.current?.open) dialog.current?.showModal()
    if (!panel && dialog.current?.open) dialog.current.close()
  }, [panel])
  useEffect(() => { setFeedback(null); setPanel(null) }, [snapshot?.sessionId, snapshot?.resetEpoch])

  async function act(input: ActionInput) {
    if (disabled) return
    setFeedback(null); setActionKind(input.kind)
    try {
      const result = await runAction(input, 'today')
      if (result?.applyStatus === 'succeeded' && result.startStatus === 'failed') setFeedback('saved-not-started')
      if (result?.status === 'needs_input') setFeedback('needs-input')
      const startsWorkout = input.kind === 'start_workout' || (input.kind === 'apply_proposal' && input.startAfterApply)
      if (startsWorkout && result?.status === 'succeeded' && result.startStatus !== 'failed' && result.snapshot?.workout?.status === 'in_progress') {
        await navigate({ to: '/workout' })
      }
      return result
    } finally { setActionKind(null) }
  }
  function askAgent(message: string, target: { mealId?: string; workoutId?: string } = {}) {
    setDraft(message); setChatTarget(target); setPanel(null); void navigate({ to: '/agent' })
  }
  function retryReadiness() { void checkReadiness({ mode: 'retry' }).catch(() => {}) }
  const button = (label: string, onClick: () => void, secondary = false, extraDisabled = false) => <button type="button" className={`today-button ${secondary ? 'today-button-secondary' : 'today-button-primary'}`} disabled={disabled || extraDisabled} onClick={onClick}>{label}{!secondary && <Icon name="arrow-right" size={18} />}</button>

  if (!snapshot) return <section className="today-page"><header className="today-header"><h1>{t('Today', '今天')}</h1></header><div className="today-loading" role="status"><p>{loading ? t('Loading your day…', '正在读取今天的安排…') : t('Your day could not be loaded.', '暂时无法读取今日安排。')}</p>{loading && <div className="today-skeleton" aria-hidden="true" />}{error && <><p>{errorText(error, locale)}</p>{button(t('Try again', '重试'), () => { void refresh() })}</>}</div></section>

  const s = snapshot
  const readinessAvailable = validReadiness(s)
  const score = readinessAvailable ? s.readiness.score! / s.readiness.scoreScale * 10 : null
  const band = score === null ? null : Math.min(3, Math.floor(score / 2.5))
  const bandLabels = [t('Prioritize recovery', '优先恢复'), t('Take it easy', '放慢节奏'), t('Ready to train', '准备好了'), t('Feeling energized', '状态充沛')]
  const savedWorkout = s.workout
  const inProgress = savedWorkout?.status === 'in_progress'
  const completed = savedWorkout?.status === 'completed'
  const restToday = s.plan.restDates.includes(s.dayKey)
  const candidates = s.proposals.filter(proposal => currentProposal(proposal, s))
  const proposal = [...candidates].reverse().find(p => p.scope === 'workout' ? !completed && Boolean(p.workout) : !inProgress && !completed && !restToday && p.restDate === s.dayKey)
  const scheduleProposal = proposal?.scope === 'schedule' ? proposal : null
  const workoutProposal = proposal?.scope === 'workout' ? proposal : null
  const workout = workoutProposal?.workout ?? savedWorkout
  const expiredProposal = [...s.proposals].reverse().find(p => p.status === 'stale' || (p.status === 'pending' && !currentProposal(p, s)))
  const dismissed = [...s.proposals].reverse().find(p => p.status === 'dismissed' && p.readinessSnapshotId === s.readiness.id && p.expected.readiness === s.readiness.version)
  const consideringRest = readinessAvailable && s.readiness.guidanceHint === 'consider_rest' && !proposal && !restToday && !inProgress && !completed && !dismissed
  const planSession = s.plan.sessions.find(session => session.date === s.dayKey)
  const nextSessions = s.plan.sessions.filter(session => session.status === 'pending' && session.date !== s.dayKey)
  const nextSession = [...nextSessions].sort((a, b) => (a.date ?? '9999').localeCompare(b.date ?? '9999'))[0]
  const totals = dailyTotals(s.meals)
  const targets = s.profile.targets
  const groups = groupedMeals(s.meals)
  const areaGroups = groups.filter(group => totals.kcal > 0 && group.totals.kcal > 0 && group.totals.kcal / totals.kcal >= 0.2)
  const smallGroups = groups.filter(group => !areaGroups.includes(group))
  const selectedGroup = groups.find(group => group.period === mealPeriod)
  const splitName = (split: 'Pull' | 'Legs' | 'Push') => ({ Pull: t('Pull', '拉类训练'), Legs: t('Legs', '腿部训练'), Push: t('Push', '推类训练') })[split]
  const periodName = (period: Meal['period']) => ({ breakfast: t('Breakfast', '早餐'), lunch: t('Lunch', '午餐'), dinner: t('Dinner', '晚餐'), snack: t('Snacks', '加餐') })[period]
  const gymName = (gymId: string) => gymId === 'gym-a' ? 'Gym A' : 'Gym B'
  const dateOrPending = (value: string | null) => value ? date(value) : t('Unscheduled', '待安排')
  const readableTime = (value: string) => /^[0-9]{2}:[0-9]{2}$/.test(value) ? value : Number.isNaN(Date.parse(value)) ? value : new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', timeZone: s.timeZone }).format(new Date(value))
  const compactSleep = s.sleep ? (() => { const hours = Math.floor(s.sleep.minutes / 60), minutes = Math.round(s.sleep.minutes % 60); return t(`${hours ? `${hours}h` : ''}${minutes || !hours ? `${minutes}m` : ''}`, `${hours ? `${hours}时` : ''}${minutes || !hours ? `${minutes}分` : ''}`) })() : ''
  const readinessIssue = s.readiness.quality === 'failed' ? t('Readiness could not be read.', '准备度读取失败。') : s.readiness.quality === 'stale' || s.readiness.dayKey !== s.dayKey ? t('Today’s readiness has not been updated.', '今天的准备度尚未更新。') : t('No readiness data is available.', '当前没有可用准备度。')
  const checkingRecovery = readinessBusy || s.readinessCheck?.status === 'pending'
  const activeWork = busy || chatBusy || checkingRecovery || s.advice.status === 'pending'
  const requestLabel = activeWork ? t('Preparing your plan…', '正在准备方案…') : t('Generate workout', '生成训练')
  const mainError = feedback === 'saved-not-started' ? t('Your plan is saved. The workout has not started; try starting it again.', '方案已保存，训练尚未开始。请重试开始。') : error ? errorText(error, locale) : feedback === 'needs-input' ? t('A little more information is needed to finish this plan.', '还需要补充一些信息才能完成方案。') : null

  function loadText(exercise: Exercise) {
    const load = exercise.suggestedLoad
    if (load.basis === 'bodyweight') return t('Bodyweight', '自重')
    if (load.value === null) return t('Load to confirm', '重量待确认')
    return `${t('Suggested', '建议')} ${number(load.value, 1)} kg · ${load.basis === 'per_hand' ? t('per hand', '每只') : t('machine stack', '机器配重')}`
  }
  function exerciseList(exercises: Exercise[], showChanges = false) {
    return <ol className="today-exercises" aria-label={t('All exercises', '全部训练动作')}>{exercises.map((exercise, index) => {
      const oldIndex = savedWorkout?.exercises.findIndex(item => item.id === exercise.id) ?? -1
      const oldExercise = savedWorkout?.exercises[oldIndex]
      const changedValues = oldExercise && (oldExercise.sets !== exercise.sets || oldExercise.reps !== exercise.reps || oldExercise.suggestedLoad.value !== exercise.suggestedLoad.value)
      const change = showChanges && !exercise.completed ? oldIndex < 0 ? t('New', '新增') : oldIndex !== index ? t('Reordered', '已重排') : changedValues ? t('Updated', '已调整') : null : null
      return <li key={exercise.id} className={exercise.completed ? 'today-exercise-done' : ''}><span className="today-exercise-number" aria-label={exercise.completed ? t('Completed', '已完成') : undefined}>{exercise.completed ? <Icon name="check" size={19} /> : String(index + 1).padStart(2, '0')}</span><div className="today-exercise-copy"><details className="today-exercise-details"><summary><strong>{text(exercise.name)}{change && <small className="today-change">{change}</small>}</strong><span>{exercise.sets} × {exercise.reps} · {loadText(exercise)}</span><Icon name="chevron-right" size={15} /></summary><p>{text(exercise.equipment)} · {t('Rest', '组间休息')} {exercise.restSeconds} {t('sec', '秒')}</p><p>{text(exercise.instructions)}</p><p>{text(exercise.suggestedLoad.reason)}</p></details></div></li>
    })}</ol>
  }
  function dateMoves(p: Proposal) {
    return <div className="today-date-moves">{p.moves?.map(move => <div key={move.sessionId}><strong>{splitName(move.split)}</strong><span><span className="today-date-before">{dateOrPending(move.from)}</span><Icon name="arrow-right" size={15} /><b>{dateOrPending(move.to)}</b></span></div>)}</div>
  }
  function startButton() {
    if (!savedWorkout) return null
    if (completed) return button(t('View workout record', '查看训练记录'), () => { void navigate({ to: '/workout' }) })
    if (inProgress) return button(t('Continue workout', '继续训练'), () => { void navigate({ to: '/workout' }) })
    return button(actionKind === 'start_workout' ? t('Starting…', '正在开始…') : readinessAvailable && !dismissed ? t('Start workout', '开始训练') : t('Start current plan', '按现有计划开始'), () => { void act({ kind: 'start_workout', workoutId: savedWorkout.id, expectedWorkoutVersion: savedWorkout.version }) })
  }
  function reviewButton() {
    return button(!s.capabilities.agent ? t('Suggestions unavailable', '建议暂不可用') : activeWork ? t('Preparing a suggestion…', '正在准备建议…') : t('Prepare a suggestion', '生成调整建议'), () => { void act({ kind: 'request_proposal' }) }, false, activeWork || !s.capabilities.agent)
  }
  function workoutBody(): ReactNode {
    if (restToday && !inProgress && !completed) return <section className="today-plan today-rest"><div className="today-coach"><Icon name="check" size={17} />{t('Schedule updated', '安排已更新')}</div><h2>{t('Rest today', '今天休息')}</h2><p>{nextSession ? t(`Next: ${splitName(nextSession.split)} · ${dateOrPending(nextSession.date)}${nextSession.date ? ' (tentative)' : ''}`, `下一场：${splitName(nextSession.split)} · ${dateOrPending(nextSession.date)}${nextSession.date ? '（暂定）' : ''}`) : t('Your next workout is not scheduled yet.', '下一场训练尚未排定。')}</p>{button(t('Upcoming schedule', '后续安排'), () => setPanel('schedule'), true)}</section>
    if (scheduleProposal) return <section className="today-plan today-rest"><div className="today-coach"><Icon name="sparkles" size={17} />Wellio · {t('Recommendation', '建议')}</div><h2>{t('I recommend resting today', '建议今天不训练')}</h2><p>{text(scheduleProposal.reason)}</p><span className="today-status">{t('Suggested schedule · Not applied', '建议安排 · 尚未应用')}</span>{dateMoves(scheduleProposal)}<p className="today-note">{t('Workout order and content are kept. Future dates are tentative; your current schedule is unchanged until you confirm.', '保留训练内容与顺序，未来日期暂定。确认前，当前安排保持不变。')}</p>{button(actionKind === 'apply_proposal' ? t('Saving your schedule…', '正在保存安排…') : t('Confirm rest and reschedule', '确认休息并顺延'), () => { void act({ kind: 'apply_proposal', proposalId: scheduleProposal.id, startAfterApply: false }) })}{button(t('Keep current plan', '保留原计划'), () => { void act({ kind: 'dismiss_proposal', proposalId: scheduleProposal.id }) }, true)}</section>
    return <section className="today-plan">{(workoutProposal || consideringRest) && <span className="today-eyebrow">{workoutProposal ? t('Proposed workout', '建议训练方案') : savedWorkout ? t('Saved workout · Awaiting review', '原已保存计划 · 等待评估') : t("Today's workout", '今日训练')}</span>}<div className="today-plan-heading"><h2><button type="button" className="today-gym" disabled={disabled || completed} onClick={() => setPanel('gym')}><span>{workout ? text(workout.name) : planSession ? splitName(planSession.split) : t('Your workout', '今日训练')}</span><small>{gymName(workout?.gymId ?? s.conditions.gymId)} · {workout ? t(`About ${workout.estimatedMinutes} min`, `预计 ${workout.estimatedMinutes} 分钟`) : t(`${s.conditions.availableMinutes} min available`, `可用 ${s.conditions.availableMinutes} 分钟`)}{!completed && <Icon name="chevron-down" size={14} />}</small></button></h2>{!workoutProposal && <div className="today-plan-main-action">{consideringRest ? reviewButton() : savedWorkout ? startButton() : button(requestLabel, () => { void act({ kind: 'request_proposal' }) }, false, activeWork)}</div>}</div>
      {workoutProposal && <><p className="today-reason"><strong>Wellio</strong> {text(workoutProposal.reason)}</p><span className="today-status">{t('Suggested changes · Not applied', '建议方案 · 尚未应用')}</span></>}
      {!proposal && completed && <p className="today-reason">{t('Workout finished', '本次训练已结束')} · {savedWorkout!.exercises.filter(ex => ex.completed).length}/{savedWorkout!.exercises.length} {t('exercises completed', '个动作已完成')}{savedWorkout!.actualMinutes !== undefined && <> · {duration(savedWorkout!.actualMinutes)}</>}</p>}
      {!proposal && inProgress && <p className="today-reason">{t('In progress', '进行中')} · {savedWorkout!.exercises.filter(ex => ex.completed).length}/{savedWorkout!.exercises.length} {t('exercises completed', '个动作已完成')}</p>}
      {consideringRest && <div className="today-inline-state" role="status"><p>{!s.capabilities.agent ? t('Training advice is unavailable right now. Your current plan is unchanged.', '训练建议暂不可用，当前计划保持不变。') : activeWork ? t('Reviewing recovery and your schedule. Your current plan is unchanged.', '正在查看恢复与安排，当前计划保持不变。') : t('A recommendation is not ready yet. Your current plan is unchanged.', '建议尚未生成，当前计划保持不变。')}</p></div>}
      {!proposal && !consideringRest && !completed && !inProgress && (dismissed ? <p className="today-reason">{t('You kept the current plan. Your readiness is unchanged.', '已保留原计划，准备度状态没有改变。')}</p> : s.advice.status === 'valid' && s.advice.training ? <p className="today-reason"><strong>Wellio</strong> {text(s.advice.training)}</p> : !readinessAvailable ? <p className="today-reason">{t('Readiness is unavailable. Your saved plan remains available.', '准备度暂不可用，已保存的计划仍可查看。')}</p> : null)}
      {workoutProposal && savedWorkout && savedWorkout.exercises.some(old => !workout?.exercises.some(item => item.id === old.id)) && <p className="today-note">{t('Removed from this proposal: ', '此方案移除：')}{savedWorkout.exercises.filter(old => !workout?.exercises.some(item => item.id === old.id)).map(old => text(old.name)).join(' · ')}</p>}
      {workout ? exerciseList(workout.exercises, Boolean(workoutProposal)) : <p className="today-empty">{activeWork ? t('Preparing the exercises for today…', '正在准备今日动作方案…') : t('Your exercises will appear here after the plan is generated.', '方案生成后，所有动作会直接显示在这里。')}</p>}
      {workoutProposal && <>{button(actionKind === 'apply_proposal' ? t('Saving and starting…', '正在保存并开始…') : inProgress ? t('Apply changes and continue', '确认调整并继续') : savedWorkout ? t('Apply changes and start', '确认调整并开始') : t('Confirm and start', '确认并开始'), () => { void act({ kind: 'apply_proposal', proposalId: workoutProposal.id, startAfterApply: true }) })}{button(t('Keep current plan', '保留原计划'), () => { void act({ kind: 'dismiss_proposal', proposalId: workoutProposal.id }) }, true)}</>}
      {expiredProposal && !proposal && <div className="today-inline-state"><p>{t('An earlier suggestion is out of date.', '此前建议已过期。')}</p>{button(t('Request updated changes', '获取最新调整'), () => { void act({ kind: 'request_proposal' }) }, true)}</div>}
    </section>
  }
  function mealCard(group: MealGroup, compact = false) {
    const meals = group.meals
    return <button type="button" key={group.period} className={compact ? 'today-meal-row' : 'today-meal-card'} onClick={() => { setMealPeriod(group.period); setPanel('meal') }}><span>{periodName(group.period)}<small>{meals.length === 1 ? readableTime(meals[0].time) : t(`${meals.length} entries`, `${meals.length} 条记录`)}</small></span><strong>{number(group.totals.kcal)} <small>kcal</small></strong><span className="today-meal-name">{meals.flatMap(meal => meal.items.map(item => text(item.name))).join(' · ')}</span>{compact && <small>{t('Not in the area comparison', '未纳入面积比较')}</small>}</button>
  }
  let panelContent: ReactNode = null
  let panelTitle = ''
  if (panel === 'basis') {
    panelTitle = t('Readiness details', '准备度依据')
    const recentTraining = [...s.history.training].filter(item => item.minutes > 0 && item.date < s.dayKey).sort((a, b) => b.date.localeCompare(a.date))[0]
    panelContent = <><p className="today-note">{s.readiness.observedAt && !Number.isNaN(Date.parse(s.readiness.observedAt)) ? date(s.readiness.observedAt, { hour: '2-digit', minute: '2-digit' }) : t('No observation time', '暂无数据时间')}</p><dl className="today-facts"><dt>{t('Readiness', '准备度')}</dt><dd>{score === null ? t('Unavailable', '暂不可用') : `${number(score, 1)} / 10`}</dd><dt>{t('Last night’s sleep', '昨晚睡眠')}</dt><dd>{s.sleep ? duration(s.sleep.minutes) : t('No sleep record', '暂无睡眠记录')}{s.sleep && <small>{readableTime(s.sleep.bedtime)} — {readableTime(s.sleep.wakeTime)}</small>}<small>{t('Baseline', '基线')} {duration(s.readiness.baselineSleepMinutes)}</small></dd><dt>{t('Resting heart rate', '静息心率')}</dt><dd>{s.readiness.restingHeartRate === null ? '—' : `${s.readiness.restingHeartRate} bpm`}<small>{t('Baseline', '基线')} {s.readiness.baselineHeartRate} bpm</small></dd>{recentTraining && <><dt>{t('Recent workout', '最近一场训练')}</dt><dd>{date(recentTraining.date)} · {['Pull', 'Legs', 'Push'].includes(recentTraining.type) ? splitName(recentTraining.type as 'Pull' | 'Legs' | 'Push') : recentTraining.type}<small>{duration(recentTraining.minutes)}</small></dd></>}</dl><p className="today-note">{t('Synthetic watch input demonstrates how recovery information informs training. The score is supplied by the data source. Display bands are not exercise safety thresholds.', '模拟手表输入，用于演示恢复信息如何影响训练安排。分数由数据源提供，四段展示区间不是运动安全阈值。')}</p></>
  } else if (panel === 'schedule') {
    panelTitle = t('Upcoming schedule', '后续安排')
    const days = Array.from({ length: 7 }, (_, index) => new Date(Date.parse(`${s.dayKey}T00:00:00Z`) + index * 86400000).toISOString().slice(0, 10))
    const overflow = s.plan.sessions.filter(session => !session.date || session.date > days[6])
    panelContent = <><p className="today-note">{t('Saved schedule · Future dates are tentative', '已保存安排 · 未来日期暂定')}</p><div className="today-saved-schedule">{days.map(day => {
      const sessions = s.plan.sessions.filter(session => session.date === day)
      return <div key={day}><span>{date(day)}{day === s.dayKey && <small>{t('Today', '今天')}</small>}</span><strong>{s.plan.restDates.includes(day) ? t('Rest', '休息') : sessions.length ? sessions.map(session => <span key={session.id}>{splitName(session.split)}<small>{session.status === 'completed' ? t('Completed', '已完成') : session.status === 'in_progress' ? t('In progress', '进行中') : t('Planned', '待练')}</small></span>) : t('No workout scheduled', '未安排训练')}</strong></div>
    })}</div>{overflow.length > 0 && <><h3>{t('Beyond the next seven days', '七天窗口以外')}</h3><div className="today-saved-schedule">{overflow.map(session => <div key={session.id}><span>{splitName(session.split)}</span><strong>{dateOrPending(session.date)}</strong></div>)}</div></>}</>
  } else if (panel === 'gym') {
    panelTitle = t('Today’s gym', '今日训练场地')
    panelContent = <><p>{t('Choose a gym to prepare a proposal. Your saved plan changes only after you confirm it on Today.', '选择场地后会生成候选方案，回到今日确认后才更新当前计划。')}</p>{(['gym-b', 'gym-a'] as const).map(gymId => <button className="today-gym-choice" type="button" key={gymId} disabled={disabled} onClick={() => { void act({ kind: 'request_proposal', gymId }).then(result => { if (result?.status === 'succeeded') setPanel(null) }) }}><strong>{gymName(gymId)}{(savedWorkout?.gymId ?? s.conditions.gymId) === gymId && <small>{t('Current', '当前')}</small>}</strong><span>{gymId === 'gym-a' ? t('Dumbbells, bench, cable machine, pull-up bar', '哑铃、训练凳、拉力器、单杠') : t('Dumbbells, bench, cable machine', '哑铃、训练凳、拉力器')}</span></button>)}</>
  } else if (panel === 'meal' && selectedGroup) {
    panelTitle = periodName(selectedGroup.period)
    panelContent = <>{selectedGroup.meals.map(meal => <section key={meal.id} className="today-meal-detail"><p className="today-note">{readableTime(meal.time)}</p>{meal.items.map(item => <div key={item.id}><strong>{text(item.name)}</strong><span>{text(item.portion)}{item.consumedFraction !== 1 && <> · {t(`${number(item.consumedFraction * 100)}% eaten`, `已吃 ${number(item.consumedFraction * 100)}%`)}</>} · {number(item.base.kcal * item.consumedFraction)} kcal {item.estimated && t('(estimate)', '（估算）')}</span></div>)}<p>{t('Protein', '蛋白质')} {number(mealTotals(meal).protein, 1)} g · {t('Carbs', '碳水')} {number(mealTotals(meal).carbs, 1)} g · {t('Fat', '脂肪')} {number(mealTotals(meal).fat, 1)} g</p>{button(t('Edit with Wellio', '用 Wellio 修改'), () => askAgent(t(`I’d like to correct my ${periodName(meal.period).toLowerCase()}: `, `我想修改${periodName(meal.period)}：`), { mealId: meal.id }), true)}</section>)}</>
  }

  return <section className="today-page"><header className="today-header"><h1>{t('Today', '今天')}</h1><div className="today-header-actions"><button type="button" className="today-date-button" aria-label={t('Upcoming schedule', '后续安排')} onClick={() => setPanel('schedule')}><Icon name="calendar" size={16} /><span>{date(s.dayKey, { weekday: 'short' })}</span></button><button type="button" className="today-log-button" aria-label={t('Log a meal', '记录一餐')} title={t('Log a meal', '记录一餐')} onClick={() => askAgent(t('Help me log a meal: ', '帮我记录一餐：'))}><Icon name="plus" size={21} /></button></div></header><div className="today-content">
    <section className="today-readiness"><div className="today-section-line"><h2>{t("Today's readiness", '今日准备度')}</h2><span>{s.readiness.observedAt && !Number.isNaN(Date.parse(s.readiness.observedAt)) ? <>{t('Data time', '数据时间')} {readableTime(s.readiness.observedAt)}</> : t('No data time', '暂无数据时间')}</span></div><div className="today-readiness-stage"><button type="button" className="today-gauge-button" onClick={() => setPanel('basis')} aria-label={score === null ? t('Readiness unavailable. View details.', '准备度暂不可用，查看依据。') : t(`Readiness ${score.toFixed(1)} out of 10. ${bandLabels[band!]}. View details.`, `准备度 ${score.toFixed(1)} 分，满分10分，${bandLabels[band!]}，查看依据。`)}><svg viewBox="0 0 182 123" aria-hidden="true"><g fill="none" strokeWidth="9" strokeLinecap="round">{bandColors.map((color, index) => {
      const point = (fraction: number) => ({ x: 91 + 78 * Math.cos(Math.PI * (1 - fraction)), y: 90 - 78 * Math.sin(Math.PI * (1 - fraction)) })
      const from = point(index / 4 + .018), to = point((index + 1) / 4 - .018)
      return <path key={color} d={`M ${from.x} ${from.y} A 78 78 0 0 1 ${to.x} ${to.y}`} stroke={band === null ? '#cbd3c1' : color} opacity={band === index ? 1 : .35} />
    })}</g>{score !== null && <><circle cx={91 + 78 * Math.cos(Math.PI * (1 - score / 10))} cy={90 - 78 * Math.sin(Math.PI * (1 - score / 10))} r="9" fill="#faf9f2" /><circle cx={91 + 78 * Math.cos(Math.PI * (1 - score / 10))} cy={90 - 78 * Math.sin(Math.PI * (1 - score / 10))} r="5.5" fill={bandInk[band!]} /></>}<text x="12" y="112" textAnchor="middle">0</text><text x="169" y="112" textAnchor="middle">10</text></svg><span className="today-gauge-value"><strong>{score === null ? '—' : score.toFixed(1)}<small>/10</small></strong><span style={{ color: band === null ? '#62705c' : bandInk[band] }}>{band === null ? t('Unavailable', '暂不可用') : bandLabels[band]}</span></span></button><div className="today-pet"><Mascot pose={band === null ? 'welcome' : poses[band]} alt="Wellio" /><span><Icon name="moon" size={16} />{s.sleep ? <span>{t('Last night', '昨晚')} <span className="today-sleep-duration">{compactSleep}</span></span> : t('No sleep record', '暂无睡眠记录')}</span></div></div>{!readinessAvailable && <div className="today-readiness-unavailable"><p>{readinessIssue}</p><button type="button" className="today-link" disabled={disabled} onClick={retryReadiness}>{t('Retry readiness', '重试读取')}</button></div>}</section>
    {mainError && <div className="today-error" role="status"><p>{mainError}</p>{feedback === 'needs-input' && button(t('Add details in Agent', '向助手补充信息'), () => askAgent(t('Help me finish the workout plan. What else do you need?', '帮我完成今天的训练方案，还需要哪些信息？'), savedWorkout ? { workoutId: savedWorkout.id } : {}), true)}{error && <details><summary>{t('Details', '查看详情')}</summary><p>{t('Refresh saved data to check the latest result before retrying.', '请先刷新已保存数据，核对最新结果后再重试。')}</p><button type="button" className="today-link" onClick={() => { void refresh() }}>{t('Refresh saved data', '刷新已保存数据')}</button></details>}</div>}
    {(checkingRecovery || readinessError || s.readinessCheck?.status === 'failed' || s.readinessCheck?.status === 'stopped') && <div className="today-inline-state" role={readinessError ? 'alert' : 'status'}><p>{readinessError ? errorText(readinessError, locale) : checkingRecovery ? t('Checking recovery and today’s saved plan…', '正在检查恢复与今日已保存安排…') : s.readinessCheck?.status === 'stopped' ? t('Recovery check stopped.', '恢复检查已停止。') : errorText(s.readinessCheck?.errorCode || 'PROVIDER_ERROR', locale)}</p>{!readinessBusy && <button type="button" className="today-link" disabled={disabled} onClick={readinessError || !checkingRecovery ? retryReadiness : () => { void refresh() }}>{readinessError || !checkingRecovery ? t('Retry recovery check', '重试恢复检查') : t('Refresh', '刷新')}</button>}</div>}
    {workoutBody()}
    <div className="today-fuel"><section className="today-nutrition"><div className="today-section-line"><h2>{t('Nutrition & meals', '营养与饮食')}</h2><span>{targets.kcal > 0 ? <>{t('Daily target', '今日目标')} {number(targets.kcal)} kcal</> : t('Target not set', '目标未设置')}</span></div><div className="today-nutrition-data"><div className="today-nutrition-dial" role="img" aria-label={t(`Consumed ${number(totals.kcal)} kcal. Protein ${number(totals.protein)} of ${number(targets.protein)} grams; carbs ${number(totals.carbs)} of ${number(targets.carbs)}; fat ${number(totals.fat)} of ${number(targets.fat)}.`, `已摄入${number(totals.kcal)}千卡。蛋白质${number(totals.protein)}/${number(targets.protein)}克，碳水${number(totals.carbs)}/${number(targets.carbs)}克，脂肪${number(totals.fat)}/${number(targets.fat)}克。`)}><svg viewBox="0 0 112 112" aria-hidden="true"><g fill="none" strokeWidth="4.5" strokeLinecap="round" transform="rotate(135 56 56)">{(['protein', 'carbs', 'fat'] as const).map((key, index) => <g key={key}><circle cx="56" cy="56" r={46 - index * 7} stroke={macroColors[index]} opacity=".15" pathLength="100" strokeDasharray="75 25" /><circle cx="56" cy="56" r={46 - index * 7} stroke={macroColors[index]} pathLength="100" strokeDasharray={`${targets[key] > 0 ? Math.min(1, totals[key] / targets[key]) * 75 : 0} 100`} /></g>)}</g></svg><span><strong>{number(totals.kcal)}</strong><small>kcal</small></span></div><div className="today-macros">{(['protein', 'carbs', 'fat'] as const).map((key, index) => <div key={key}><span><i style={{ background: macroColors[index] }} />{[t('Protein', '蛋白质'), t('Carbs', '碳水'), t('Fat', '脂肪')][index]}</span><strong>{number(totals[key], 1)}<small>{targets[key] > 0 ? ` / ${number(targets[key])} g` : t(' g · No target', '克 · 目标未设')}</small></strong>{targets[key] > 0 && totals[key] > targets[key] && <small className="today-over-target">{number(totals[key] / targets[key] * 100)}%</small>}</div>)}</div></div><div className="today-remaining"><span>{targets.kcal <= 0 ? t('Target not set', '目标未设置') : totals.kcal > targets.kcal ? t('Above daily target', '超出今日目标') : t('Remaining today', '距摄入目标还差')}</span><strong>{targets.kcal > 0 ? `${number(Math.abs(targets.kcal - totals.kcal))} kcal` : '—'}</strong></div></section>
    <section className="today-food"><h2 className="sr-only">{t('Meals', '饮食')}</h2>{groups.length ? <>{areaGroups.length > 0 && <div className="today-meal-tiles" style={{ gridTemplateColumns: areaGroups.map(group => `minmax(0,${group.totals.kcal}fr)`).join(' ') }}>{areaGroups.map(group => mealCard(group))}</div>}{smallGroups.map(group => mealCard(group, true))}</> : <p className="today-empty">{t('No meals recorded yet.', '今天还没有餐食记录。')}</p>}{s.advice.status === 'valid' && s.advice.nutrition ? <button type="button" className="today-meal-advice" onClick={() => askAgent(t('Tell me more about your dinner suggestion for today.', '详细说说今天的晚餐建议。'))}><Icon name="sparkles" size={18} /><span><small>{t('Dinner suggestion', '晚餐建议')}</small><strong>{text(s.advice.nutrition)}</strong></span><Icon name="chevron-right" size={16} /></button> : (s.advice.status === 'pending' || s.advice.status === 'stale') && <p className="today-note">{s.advice.status === 'pending' ? t('Preparing your food suggestion…', '正在准备饮食建议…') : t('Food suggestion needs updating.', '饮食建议待更新。')}</p>}</section></div>
  </div><dialog ref={dialog} className="today-dialog" onClose={() => setPanel(null)} onClick={event => { if (event.target === event.currentTarget) setPanel(null) }} aria-labelledby="today-panel-title"><button type="button" className="today-close" aria-label={t('Close', '关闭')} onClick={() => setPanel(null)}><Icon name="x" size={22} /></button><h2 id="today-panel-title">{panelTitle}</h2>{panelContent}{panel === 'gym' && mainError && <p className="today-error" role="status">{mainError}</p>}</dialog></section>
}

export default TodayPage
