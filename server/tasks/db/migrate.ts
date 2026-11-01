import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { resolve } from 'node:path'

export default defineTask({
  meta: {
    name: 'db:migrate',
    description: 'Migrate the database',
  },
  async run() {
    const log = logger.dynamic('db')
    const db = useDB()

    log.info('Migrating database...')

    migrate(db, {
      // Match startup migration paths after Nitro moves this task into chunks.
      migrationsFolder: resolve('./server/database/migrations'),
    })

    log.success('Database migrated successfully.')

    return {
      result: 'success',
    }
  },
})
