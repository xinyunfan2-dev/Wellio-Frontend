import type { Proposal, Snapshot } from '../lib/contracts'
import { z } from 'zod'
import { BackendError } from './errors'

export function buildRestSchedule(snapshot: Snapshot): Pick<Proposal, 'moves' | 'restDate' | 'unassignedSessionIds'> {
  if (snapshot.readiness.quality !== 'valid' || snapshot.readiness.dayKey !== snapshot.dayKey) throw new BackendError('READINESS_UNAVAILABLE', 200)
  if (snapshot.plan.restDates.includes(snapshot.dayKey)) throw new BackendError('WORKOUT_NOT_SCHEDULED', 409)
  const today = snapshot.plan.sessions.filter(session => session.date === snapshot.dayKey)
  if (today.some(session => session.status !== 'pending') || (snapshot.workout && today.some(session => session.id === snapshot.workout!.trainingSessionId) && snapshot.workout.status !== 'planned')) throw new BackendError('WORKOUT_STATE_CONFLICT', 409)
  if (today.length !== 1) throw new BackendError('WORKOUT_NOT_SCHEDULED', 409)
  const ordered = snapshot.plan.pendingSessionIds
  if (new Set(ordered).size !== ordered.length || new Set(snapshot.plan.sessions.map(session => session.id)).size !== snapshot.plan.sessions.length) throw new BackendError('INVALID_SCHEDULE', 409)
  const anchor = ordered.indexOf(today[0].id)
  if (anchor < 0) throw new BackendError('INVALID_SCHEDULE', 409)
  const targets = ordered.slice(anchor).map(id => snapshot.plan.sessions.find(session => session.id === id))
  if (targets.some(session => !session || session.status !== 'pending')) throw new BackendError('WORKOUT_STATE_CONFLICT', 409)
  const targetIds = new Set(targets.map(session => session!.id))
  // Protect every non-target assignment, including pending sessions before the anchor.
  const occupiedDates = new Set(snapshot.plan.sessions.filter(session => !targetIds.has(session.id) && session.date !== null).map(session => session.date!))
  const seenDates = new Set<string>()
  if (new Set(snapshot.plan.availableSlots.map(slot => slot.id)).size !== snapshot.plan.availableSlots.length || snapshot.plan.availableSlots.some(slot => !/^[A-Za-z0-9_-]{1,128}$/.test(slot.id) || !z.iso.date().safeParse(slot.date).success)) throw new BackendError('INVALID_SCHEDULE', 409)
  const slots = [...snapshot.plan.availableSlots].sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id)).filter(slot => {
    if (slot.date <= snapshot.dayKey || occupiedDates.has(slot.date) || snapshot.plan.restDates.includes(slot.date) || seenDates.has(slot.date)) return false
    seenDates.add(slot.date)
    return true
  })
  const moves = targets.map((session, index) => ({ sessionId: session!.id, split: session!.split, from: session!.date, to: slots[index]?.date ?? null }))
  return { restDate: snapshot.dayKey, moves, unassignedSessionIds: moves.filter(move => move.to === null).map(move => move.sessionId) }
}

export function applyRestSchedule(snapshot: Snapshot, proposal: Proposal): void {
  const computed = buildRestSchedule(snapshot)
  if (JSON.stringify(computed.moves) !== JSON.stringify(proposal.moves) || proposal.restDate !== computed.restDate) throw new BackendError('STALE_PROPOSAL', 409)
  snapshot.plan.restDates = [...snapshot.plan.restDates, snapshot.dayKey]
  for (const move of computed.moves!) {
    const session = snapshot.plan.sessions.find(session => session.id === move.sessionId)!
    session.date = move.to
    session.slotId = move.to === null ? null : [...snapshot.plan.availableSlots].sort((a, b) => a.id.localeCompare(b.id)).find(slot => slot.date === move.to)!.id
    if (snapshot.workout?.trainingSessionId === session.id) {
      snapshot.workout.dayKey = move.to
      snapshot.workout.version += 1
    }
  }
  snapshot.plan.version += 1
}
