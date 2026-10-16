export default eventHandler(async (event) => {
  const actor = await requireAccess(event, 'user')
  return actor.user
})
