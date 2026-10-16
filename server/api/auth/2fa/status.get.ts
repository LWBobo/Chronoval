export default eventHandler(async (event) => {
  const actor = await requireAccess(event, 'user')
  const db = useDB()
  const user = db
    .select()
    .from(tables.users)
    .where(eq(tables.users.id, actor.user!.id))
    .get()
  return { enabled: Boolean(user?.totpEnabled) }
})