import type { SQL } from 'drizzle-orm'
import type { PersonViewer } from '~~/server/services/ml/person.service'
import { photoVisibleSql } from '~~/server/utils/photo-visibility'

/**
 * 首页瀑布流。档位、密码和「不进首页」都由集合授权决定，人物相册只参与档位。
 * 有密码且不免密的照片不进首页，解锁 cookie 也不能把它们送回来。
 */
export const homepageGalleryVisibilitySql = (
  loggedIn: boolean,
  peopleViewer?: PersonViewer,
  userId?: number | null,
): SQL => {
  const viewer = peopleViewer ?? (loggedIn ? 'user' : 'public')
  const viewerRank = viewer === 'admin' ? 2 : loggedIn ? 1 : 0
  return photoVisibleSql({
    viewerRank,
    userId: userId ?? null,
    surface: 'gallery',
    unlockedIds: [],
  })
}
