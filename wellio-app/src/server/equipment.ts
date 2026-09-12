import { z } from 'zod'
import type { LoadBasis, LocalizedText } from '../lib/contracts'
import { BackendError } from './errors'

export type GymId = 'gym-a' | 'gym-b'
export type EquipmentStatus = 'available' | 'temporarily_occupied' | 'unavailable'
export type EquipmentStatusMap = Partial<Record<EquipmentId, EquipmentStatus>>
export type EquipmentId = typeof equipmentIds[number]

const equipmentIds = ['gym-a-dumbbells', 'gym-a-bench', 'gym-a-cable', 'gym-a-pullup-bar', 'gym-b-dumbbells', 'gym-b-bench', 'gym-b-cable'] as const
const statusSchema = z.partialRecord(z.enum(equipmentIds), z.enum(['available', 'temporarily_occupied', 'unavailable']))
const gymSchema = z.enum(['gym-a', 'gym-b'])

interface EquipmentBase { equipmentId: EquipmentId; gymId: GymId; name: LocalizedText }
export interface WeightedLoad {
  basis: Extract<LoadBasis, 'per_hand' | 'machine_stack'>
  unit: 'kg'
  minKg: number
  maxKg: number
  stepKg: number
  allowedKg: number[]
}
export type EquipmentCatalogEntry = EquipmentBase & (
  | { kind: 'dumbbells' | 'cable'; load: WeightedLoad }
  | { kind: 'pullup_bar'; load: { basis: 'bodyweight'; allowsAdditionalLoad: false } }
  | { kind: 'bench'; load?: never }
)
export type EquipmentWithStatus = EquipmentCatalogEntry & { status: EquipmentStatus }
export interface GymEquipment { gymId: GymId; equipment: EquipmentWithStatus[] }

const label = (en: string, zh: string): LocalizedText => ({ en, 'zh-CN': zh })
function weighted(basis: WeightedLoad['basis'], maxKg: number, stepKg: number): WeightedLoad {
  return { basis, unit: 'kg', minKg: 5, maxKg, stepKg, allowedKg: Array.from({ length: (maxKg - 5) / stepKg + 1 }, (_, index) => 5 + index * stepKg) }
}

/** DEMO_DATA §5. Machine-stack values are meaningful only on their own machine. */
const catalog: EquipmentCatalogEntry[] = [
  { equipmentId: 'gym-a-dumbbells', gymId: 'gym-a', kind: 'dumbbells', name: label('Dumbbells', '哑铃'), load: weighted('per_hand', 30, 2.5) },
  { equipmentId: 'gym-a-bench', gymId: 'gym-a', kind: 'bench', name: label('Training bench', '训练凳') },
  { equipmentId: 'gym-a-cable', gymId: 'gym-a', kind: 'cable', name: label('Cable machine', '拉力器'), load: weighted('machine_stack', 60, 5) },
  { equipmentId: 'gym-a-pullup-bar', gymId: 'gym-a', kind: 'pullup_bar', name: label('Pull-up bar', '单杠'), load: { basis: 'bodyweight', allowsAdditionalLoad: false } },
  { equipmentId: 'gym-b-dumbbells', gymId: 'gym-b', kind: 'dumbbells', name: label('Dumbbells', '哑铃'), load: weighted('per_hand', 25, 2.5) },
  { equipmentId: 'gym-b-bench', gymId: 'gym-b', kind: 'bench', name: label('Training bench', '训练凳') },
  { equipmentId: 'gym-b-cable', gymId: 'gym-b', kind: 'cable', name: label('Cable machine', '拉力器'), load: weighted('machine_stack', 50, 5) },
]

/** Return a copy so callers cannot change the authoritative catalog or its load steps. */
export function lookupEquipment(equipmentId: string): EquipmentCatalogEntry | undefined {
  const equipment = catalog.find(entry => entry.equipmentId === equipmentId)
  return equipment && structuredClone(equipment)
}

/** Conditions can override availability, never the equipment's existence or load range. */
export function getGymEquipment(gymId: unknown, equipmentStatus: unknown = {}): GymEquipment {
  const gym = gymSchema.safeParse(gymId)
  if (!gym.success) throw new BackendError(typeof gymId === 'string' ? 'GYM_NOT_FOUND' : 'INVALID_INPUT', typeof gymId === 'string' ? 404 : 400)
  const statuses = statusSchema.safeParse(equipmentStatus)
  if (!statuses.success) throw new BackendError('INVALID_INPUT', 400)
  return {
    gymId: gym.data,
    equipment: catalog.filter(entry => entry.gymId === gym.data).map(entry => ({ ...structuredClone(entry), status: statuses.data[entry.equipmentId] ?? 'available' })),
  }
}
