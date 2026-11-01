import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, copyFile, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { test } from 'node:test'

const projectRoot = fileURLToPath(new URL('../', import.meta.url))
const projectRequire = createRequire(import.meta.url)
const nuxtRequire = createRequire(projectRequire.resolve('nuxt/package.json'))
const nitroRequire = createRequire(nuxtRequire.resolve('nitropack/package.json'))
const { createJiti } = nuxtRequire('jiti')
const { nodeFileTrace } = nitroRequire('@vercel/nft')
const { parseNodeModulePath } = nitroRequire('mlly')

async function loadConfig() {
  const previous = globalThis.defineNuxtConfig
  globalThis.defineNuxtConfig = value => value
  try { return await createJiti(import.meta.url, { moduleCache: false }).import('../nuxt.config.ts', { default: true }) }
  finally {
    if (previous === undefined) delete globalThis.defineNuxtConfig
    else globalThis.defineNuxtConfig = previous
  }
}

async function loadVerifier(root) {
  const target = path.join(root, 'verify-runtime-dependencies.mjs')
  await copyFile(new URL('./verify-runtime-dependencies.mjs', import.meta.url), target)
  return import(pathToFileURL(target).href)
}

test('VueUse ESM and CommonJS date/map dependencies resolve together with production options', async () => {
  const config = await loadConfig()
  const builderRequire = createRequire(nuxtRequire.resolve('@nuxt/vite-builder'))
  const { build } = await import(pathToFileURL(builderRequire.resolve('vite')).href)
  const scratch = await mkdtemp(path.join(tmpdir(), 'chronoval-interop-test-'))
  let bundle
  try {
    const entry = path.join(scratch, 'entry.mjs')
    // Absolute entries retain each dependency's real pnpm dependency resolution.
    await writeFile(entry, `
      import { createReusableTemplate, useResizeObserver } from ${JSON.stringify(projectRequire.resolve('@vueuse/core'))};
      import dayjs from ${JSON.stringify(projectRequire.resolve('dayjs'))};
      import maplibre from ${JSON.stringify(projectRequire.resolve('maplibre-gl'))};
      export { createReusableTemplate, useResizeObserver };
      export const date = dayjs('2026-11-01').format('YYYY-MM-DD');
      export const mapAvailable = typeof maplibre.Map === 'function';
    `)
    bundle = await build({
      configFile: false,
      root: scratch,
      logLevel: 'silent',
      build: {
        write: false,
        minify: false,
        lib: { entry, formats: ['es'] },
        commonjsOptions: config.vite.build.commonjsOptions,
        rollupOptions: { external: ['vue'] },
      },
    })
    const outputs = Array.isArray(bundle) ? bundle : [bundle]
    const chunks = outputs.flatMap(output => output.output).filter(item => item.type === 'chunk' && item.isEntry)
    assert.equal(chunks.length, 1)
    for (const name of ['createReusableTemplate', 'useResizeObserver', 'date', 'mapAvailable']) {
      assert.ok(chunks[0].exports.includes(name), `missing dependency export: ${name}`)
    }
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
})

test('isolated traced output supports file detection from a path, including the dynamic tokenizer entry', async () => {
  const config = await loadConfig()
  const extra = config.nitro.externals.traceInclude
  const scratch = await mkdtemp(path.join(tmpdir(), 'chronoval-packaging-test-'))
  try {
    const root = path.join(scratch, 'server')
    await mkdir(root)
    await writeFile(path.join(root, 'package.json'), '{"type":"module"}')
    const trace = await nodeFileTrace([projectRequire.resolve('file-type'), ...extra], { base: path.parse(projectRoot).root, processCwd: projectRoot, conditions: ['node'], exportsOnly: true })
    for (const item of trace.fileList) {
      const source = await realpath(path.resolve(path.parse(projectRoot).root, item))
      if (!(await stat(source)).isFile()) continue
      const parsed = parseNodeModulePath(source)
      if (!parsed.name) continue
      const destination = path.join(root, 'node_modules', parsed.name, parsed.subpath)
      await mkdir(path.dirname(destination), { recursive: true })
      await copyFile(source, destination)
    }
    const { verifyRuntimeDependencies } = await loadVerifier(root)
    assert.deepEqual(await verifyRuntimeDependencies(root, ['file-type']), ['file-type'])
    await stat(path.join(root, 'node_modules/strtok3/lib/index.js'))
    await stat(path.join(root, 'node_modules/strtok3/lib/FileTokenizer.js'))
  } finally { await rm(scratch, { recursive: true, force: true }) }
})

test('runtime verifier rejects project dependencies outside the deployed output', async () => {
  const scratch = await mkdtemp(path.join(projectRoot, '.runtime-packaging-test-'))
  try {
    await writeFile(path.join(scratch, 'package.json'), '{"type":"module"}')
    const { verifyRuntimeDependencies } = await loadVerifier(scratch)
    await assert.rejects(verifyRuntimeDependencies(scratch, ['file-type']), /outside the packaged server/)
  } finally { await rm(scratch, { recursive: true, force: true }) }
})

test('relocated database task finds the same migration directory as startup', async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), 'chronoval-migration-path-'))
  try {
    const target = path.join(scratch, '.output/server/chunks/tasks/db/migrate.mjs')
    const stub = path.join(scratch, 'migrator.mjs')
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(stub, 'export function migrate(db, options) { globalThis.migrationDirectory = options.migrationsFolder }')
    const ts = projectRequire('typescript')
    const source = await readFile(new URL('../server/tasks/db/migrate.ts', import.meta.url), 'utf8')
    const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
    await writeFile(target, compiled.replace(/from (['"])drizzle-orm\/better-sqlite3\/migrator\1/, `from ${JSON.stringify(pathToFileURL(stub).href)}`))
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import path from 'node:path';
      globalThis.defineTask = value => value;
      globalThis.useDB = () => ({});
      globalThis.logger = { dynamic: () => ({ info() {}, success() {} }) };
      const { default: task } = await import(${JSON.stringify(pathToFileURL(target).href)});
      await task.run();
      assert.equal(globalThis.migrationDirectory, path.resolve('server/database/migrations'));
    `], { cwd: scratch, encoding: 'utf8', timeout: 15000 })
    assert.equal(result.status, 0, result.stderr)
  } finally { await rm(scratch, { recursive: true, force: true }) }
})

