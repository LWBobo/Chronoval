import { createRequire, register } from 'node:module'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'
import { createServer } from 'node:http'
import { DatabaseSync } from 'node:sqlite'
import { eq, and, or, inArray } from 'drizzle-orm'
import { BaseSQLiteDatabase, SQLiteSyncDialect } from 'drizzle-orm/sqlite-core'
import { BetterSQLiteSession } from 'drizzle-orm/better-sqlite3/session'
import * as schema from '../../server/database/schema.ts'

// pnpm does not hoist Nuxt's h3 dependency. Resolve it from its owning package.
let h3URL
try {
  h3URL = pathToFileURL(createRequire(import.meta.url).resolve('h3')).href
} catch {
  const requireFromNuxt = createRequire(
    import.meta.resolve('nuxt/package.json'),
  )
  h3URL = pathToFileURL(requireFromNuxt.resolve('h3')).href
}
const h3 = await import(h3URL)

export const projectRoot = fileURLToPath(new URL('../../', import.meta.url))
const fixtures = new URL('./security-fixtures.mjs', import.meta.url).href
const mockedBoundaries = new Set([
  'server/utils/db',
  'server/utils/logger',
  'server/services/settings/settingsManager',
  'server/services/scan-library/manager',
  'server/plugins/3.storage',
  'server/services/ml/photo-image',
  'server/services/storage/events',
])

function sqliteClient(sqlite) {
  let depth = 0, serial = 0
  return {
    exec: text => sqlite.exec(text),
    transaction(callback) {
      const run = (mode = 'deferred') => (...args) => {
        const savepoint = `test_tx_${++serial}`, nested = depth > 0
        sqlite.exec(nested ? `SAVEPOINT ${savepoint}` : `BEGIN ${mode}`)
        depth++
        try { const result = callback(...args); sqlite.exec(nested ? `RELEASE SAVEPOINT ${savepoint}` : 'COMMIT'); return result }
        catch (error) { sqlite.exec(nested ? `ROLLBACK TO SAVEPOINT ${savepoint}` : 'ROLLBACK'); if (nested) sqlite.exec(`RELEASE SAVEPOINT ${savepoint}`); throw error }
        finally { depth-- }
      }
      const transaction = run()
      for (const mode of ['deferred','immediate','exclusive']) transaction[mode] = run(mode)
      return transaction
    },
    prepare(text) {
      // Older Node SQLite returns objects only. A derived SELECT assigns unique
      // names to duplicate expressions, retaining every positional Drizzle field.
      const statement = sqlite.prepare(/^\s*(SELECT|WITH)\b/i.test(text) ? `SELECT * FROM (${text})` : text)
      let arrays = false
      const convert = row => arrays && row ? Object.values(row) : row
      const wrapped = {
        run: (...params) => statement.run(...params),
        get: (...params) => convert(statement.get(...params)),
        all: (...params) => statement.all(...params).map(convert),
        raw(value = true) {
          arrays = value
          return wrapped
        },
      }
      return wrapped
    },
  }
}

export async function createSecurityRuntime({ moduleFixtures = [] } = {}) {
  register(new URL('./security-loader.mjs', import.meta.url), { parentURL: import.meta.url, data: { root: projectRoot, h3URL, fixtures, boundaries: [...mockedBoundaries], moduleFixtures } })
  const scratch = await mkdtemp(path.join(tmpdir(), 'chronoval-auth-test-'))
  const sqlite = new DatabaseSync(':memory:')
  sqlite.exec('PRAGMA foreign_keys=ON')
  sqlite.exec(
    (await readFile(
      path.join(projectRoot, 'server/database/migrations/0000_baseline.sql'),
      'utf8',
    )).replace('CREATE VIRTUAL TABLE IF NOT EXISTS photo_ocr_fts USING fts5(photo_id UNINDEXED, text);',
      // Node 22's bundled SQLite lacks FTS5. OCR ranking is outside this suite;
      // all domain tables, CHECKs, foreign keys and triggers stay unchanged.
      'CREATE TABLE photo_ocr_fts(photo_id TEXT, text TEXT);'),
  )
  const dialect = new SQLiteSyncDialect()
  const db = new BaseSQLiteDatabase(
    'sync',
    dialect,
    new BetterSQLiteSession(sqliteClient(sqlite), dialect),
  )
  const state = {
    db,
    sqlite,
    settings: new Map([['system:firstLaunch', false]]),
    mounts: [],
    libraries: [],
    sessionFetchHooks: [],
    sessions: new Map(),
    scanAuth: new Map(),
    scanVisibility: new Map(),
    scanRoots: [],
    scanDetail: null,
    loginAttempts: [],
  }
  globalThis.__chronovalSecurityTest = state
  Object.assign(globalThis, h3, {
    tables: schema,
    useDB: () => db,
    eq,
    and,
    or,
    inArray,
    useRuntimeConfig: () => ({
      public: { oauth: { github: { enabled: true } } },
    }),
    getUserSession: async (event) => {
      const key = h3.getCookie(event, 'test_session') || 'guest'
      if (!state.sessions.has(key)) {
        const row = Number(key) > 0 ? db.select().from(schema.users).where(eq(schema.users.id, Number(key))).get() : null
        state.sessions.set(key, { ...(row ? { user: { id: row.id, isAdmin: row.role === 'admin', role: row.role, authVersion: row.authVersion, mustChangePassword: row.mustChangePassword } } : {}), csrfToken: 'test-csrf-token' })
      }
      return state.sessions.get(key)
    },
    clearUserSession: async (event) => {
      const key = h3.getCookie(event, 'test_session') || 'guest'
      state.sessions.delete(key); h3.deleteCookie(event, 'test_session', { path: '/' })
    },
    setUserSession: async (event, session) => {
      const previous = h3.getCookie(event, 'test_session') || 'guest'
      const key = String(session.user?.id || previous)
      state.sessions.set(key, { ...state.sessions.get(previous), ...session })
      h3.setCookie(event, 'test_session', key, { path: '/' })
    },
    hashPassword: async value => `hashed:${value}`,
    markChallengeAsSucceeded: () => {},
    verifyPassword: async (stored, supplied) => stored === supplied || stored === `hashed:${supplied}`,
    defineNitroPlugin: (callback) => callback,
    sessionHooks: {
      hook: (_name, callback) => state.sessionFetchHooks.push(callback),
    },
    recordLoginAttempt: (_event, attempt) => state.loginAttempts.push(attempt),
    defineOAuthGitHubEventHandler: (options) => (event) =>
      options.onSuccess(event, { user: state.oauthIdentity }),
    logger: {
      chrono: { info() {}, warn() {}, error() {} },
      dynamic: () => ({ info() {}, warn() {}, error() {} }),
    },
  })
  globalThis.replaceUserSession = globalThis.setUserSession
  process.env.NUXT_SESSION_PASSWORD =
    'test-secret-only-not-for-production-1234567890'
  process.env.NUXT_COOKIE_SECURE = 'false'
  const access = await import('../../server/utils/access.ts')
  const photoAccess = await import('../../server/utils/photo-access.ts')
  const mediaAccess = await import('../../server/utils/media-access.ts')
  const dto = await import('../../server/utils/photo-dto.ts')
  const auth = await import('../../server/utils/auth.ts')
  const rate = await import('../../server/utils/rate-limit.ts')
  const cookie = await import('../../server/utils/cookie-security.ts')
  const totp = await import('../../server/utils/totp.ts')
  Object.assign(
    globalThis,
    access,
    photoAccess,
    mediaAccess,
    dto,
    auth,
    rate,
    cookie,
    totp,
  )
  ;(await import('../../server/plugins/session-access.ts')).default()
  state.actualManager = await import(
    new URL('../../server/services/scan-library/manager.ts', import.meta.url)
      .href
  )
  const app = h3.createApp()
  app.use((event) => {
    event.context.securityTest = state
  })
  const middleware = (await import('../../server/middleware/access.ts')).default
  app.use(middleware)
  const router = h3.createRouter()
  app.use(router)
  const server = createServer(h3.toNodeListener(app))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  return {
    state,
    db,
    sqlite,
    scratch,
    router,
    origin,
    async mount(route, filename, method = 'get') {
      const handler = (
        await import(pathToFileURL(path.join(projectRoot, filename)).href)
      ).default
      router[method](
        route,
        h3.eventHandler(async (event) => {
          const catchAll = filename.match(/\[\.\.\.([^\]]+)\]/)?.[1]
          if (catchAll) event.context.params[catchAll] = event.context.params._
          return handler(event)
        }),
      )
    },
    async write(relative, bytes) {
      const target = path.join(scratch, relative)
      await mkdir(path.dirname(target), { recursive: true })
      await writeFile(target, bytes)
      return target
    },
    async close() {
      await new Promise((resolve) => {
        server.close(resolve)
        server.closeAllConnections()
      })
      sqlite.close()
      await rm(scratch, { recursive: true, force: true })
    },
  }
}
