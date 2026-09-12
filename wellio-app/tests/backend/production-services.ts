// Trusted test harness only: no corresponding public write endpoint exists.
export { WellioDatabase } from '../../src/server/database'
export { authorizeUserMutation, recordUserMessage } from '../../src/server/authorization'
export { mutateMealLog } from '../../src/server/meal-service'
export { updateConditions } from '../../src/server/conditions-service'
export { calculateDailyTotals } from '../../src/server/read-services'
export { createBackend } from '../../src/server/app'
// These fixtures use the official MockLanguageModelV4 through the real SDK tool loop.
export { scriptedModel, toolCall, finalOutput, readEvents } from './sdk-fixtures'
