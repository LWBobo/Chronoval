import { settingsManager } from '../../services/settings/settingsManager'
import { managedUploadLimits } from '../../services/uploads/limits'
export default defineEventHandler(async (event) => {
  const { user } = await requireAccess(event, 'user')
  const usage = useDB().select().from(tables.userStorageUsage).where(eq(tables.userStorageUsage.userId, user!.id)).get()
  const row = useDB().select({ quotaBytes: tables.users.storageQuotaBytes, canUpload: tables.users.canUpload }).from(tables.users).where(eq(tables.users.id, user!.id)).get()
  const provider = await settingsManager.storage.getActiveProvider()
  const limits = await managedUploadLimits()
  const retention = await settingsManager.get<string>('app', 'trash.retention')
  const trashRetentionDays = retention === 'never' ? null : Number(retention ?? 30)
  return { ...user, ...row, ...limits, usage, trashRetentionDays, managedUploadsSupported: !!provider && ['local', 's3'].includes(provider.provider) }
})
