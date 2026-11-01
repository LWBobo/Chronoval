import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
let root, h3URL, fixtures, boundaries, moduleFixtures
export function initialize(data) { ({ root, h3URL, fixtures, boundaries, moduleFixtures = [] } = data) }
export function resolve(specifier, context, nextResolve) {
  const mock = moduleFixtures.find(rule => rule.parentURL === context.parentURL && Object.hasOwn(rule.specifiers, specifier))
  if (mock) return { url: `data:text/javascript,${encodeURIComponent(mock.specifiers[specifier])}`, shortCircuit: true }
  if (specifier === 'h3') return { url: h3URL, shortCircuit: true }
  let filename
  if (specifier.startsWith('~~/')) filename = path.join(root, specifier.slice(3))
  else if (specifier.startsWith('.') && context.parentURL?.startsWith('file:')) filename = fileURLToPath(new URL(specifier, context.parentURL))
  if (filename) {
    const relative = path.relative(root, filename).replaceAll(path.sep, '/').replace(/\.ts$/, '')
    if (boundaries.includes(relative)) return { url: fixtures, shortCircuit: true }
    for (const candidate of [filename, `${filename}.ts`, path.join(filename, 'index.ts')]) {
      if (candidate.endsWith('.ts') && existsSync(candidate)) return { url: pathToFileURL(candidate).href, shortCircuit: true }
    }
  }
  return nextResolve(specifier, context)
}
