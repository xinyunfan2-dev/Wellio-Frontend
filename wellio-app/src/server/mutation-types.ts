import type { Meal } from '../lib/contracts'
import type { ConditionsChanges } from './conditions-service'
import type { MealChanges } from './meal-validation'

export interface UserInputRecord {
  id: string; sessionId: string; requestId: string; resetEpoch: number; conversationId: string;
  content: string; createdAt: string; targetMealId?: string; targetMealItemId?: string;
  versions: { meal: number; conditions: number; workout?: number; plan?: number };
  attachmentIds?: string[]; purpose?: 'food' | 'menu'; targetWorkoutId?: string; targetExerciseId?: string; targetOperationId?: string;
  workoutContext?: { workoutId: string; trainingSessionId: string; gymId: 'gym-a' | 'gym-b' };
}
export type MutationConstraint =
  | { scope: 'meal_add' }
  | { scope: 'meal_update'; mealId: string; mealItemId: string; changes: MealChanges }
  | { scope: 'meal_delete'; mealId: string; mealItemId?: string }
  | { scope: 'conditions_update'; changes: ConditionsChanges }
export interface AuthorizationRecord {
  id: string; sessionId: string; sourceMessageId: string; resetEpoch: number; runId: string;
  scope: MutationConstraint['scope']; constraint: MutationConstraint; createdAt: string;
  expectedMealRevision?: number; expectedMealVersion?: number; expectedConditionsVersion?: number;
}
export interface MealEntity { mealId: string; version: number; headOperationId: string | null }
export interface MealOperation {
  id: string; sessionId: string; resetEpoch: number; mealId: string; action: 'add' | 'update' | 'delete';
  sourceMessageId: string; requestId: string; before: Meal | null; after: Meal | null; beforeIndex: number;
  afterVersion: number; parentOperationId: string | null; status: 'applied' | 'undone'; undoneByRequestId?: string;
}
