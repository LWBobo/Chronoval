import { settingsManager } from '~~/server/services/settings/settingsManager'

export default eventHandler(async () => {
  const settingsSchema = settingsManager.getSchema()
  return settingsSchema
})
