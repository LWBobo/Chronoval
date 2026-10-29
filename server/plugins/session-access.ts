import { getActor } from '../utils/access'

/** 会话自查询也以数据库角色为准，已删除的账号不再返回过期身份。 */
export default defineNitroPlugin(() => {
  sessionHooks.hook('fetch', async (session, event) => {
    const actor = await getActor(event)
    if (actor.user) session.user = actor.user
    else delete session.user
  })
})
