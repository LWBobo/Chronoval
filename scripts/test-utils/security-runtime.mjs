import { createRequire, registerHooks } from 'node:module'
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
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'h3') return { url: h3URL, shortCircuit: true }
    let filename
    if (specifier.startsWith('~~/'))
      filename = path.join(projectRoot, specifier.slice(3))
    else if (
      specifier.startsWith('.') &&
      context.parentURL?.startsWith('file:')
    )
      filename = fileURLToPath(new URL(specifier, context.parentURL))
    if (filename) {
      const relative = path
        .relative(projectRoot, filename)
        .replaceAll(path.sep, '/')
        .replace(/\.ts$/, '')
      if (mockedBoundaries.has(relative))
        return { url: fixtures, shortCircuit: true }
      for (const candidate of [
        filename,
        `${filename}.ts`,
        path.join(filename, 'index.ts'),
      ]) {
        if (candidate.endsWith('.ts') && existsSync(candidate))
          return { url: pathToFileURL(candidate).href, shortCircuit: true }
      }
    }
    return nextResolve(specifier, context)
  },
})

function sqliteClient(sqlite) {
  return {
    prepare(text) {
      const statement = sqlite.prepare(text)
      const wrapped = {
        run: (...params) => statement.run(...params),
        get: (...params) => statement.get(...params),
        all: (...params) => statement.all(...params),
        raw(value = true) {
          statement.setReturnArrays(value)
          return wrapped
        },
      }
      return wrapped
    },
  }
}

export async function createSecurityRuntime() {
  const scratch = await mkdtemp(path.join(tmpdir(), 'chronoval-auth-test-'))
  const sqlite = new DatabaseSync(':memory:')
  sqlite.exec(
    await readFile(
      path.join(projectRoot, 'server/database/migrations/0000_baseline.sql'),
      'utf8',
    ),
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
      const id = Number(h3.getCookie(event, 'test_session'))
      return Number.isInteger(id) && id > 0
        ? { user: { id, isAdmin: true, role: 'admin' } }
        : {}
    },
    clearUserSession: async (event) =>
      h3.deleteCookie(event, 'test_session', { path: '/' }),
    setUserSession: async (event, session) =>
      h3.setCookie(event, 'test_session', String(session.user.id), {
        path: '/',
      }),
    markChallengeAsSucceeded: () => {},
    verifyPassword: async (stored, supplied) => stored === supplied,
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
  const { LocalStorageProvider } =
    await import('../../server/services/storage/providers/local.ts')
  state.provider = new LocalStorageProvider({
    provider: 'local',
    basePath: path.join(scratch, 'storage'),
    prefix: '',
    baseUrl: '/storage',
  })
  globalThis.useStorageProvider = () => ({ storageProvider: state.provider })
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
