import { readFile, writeFile } from 'node:fs/promises'
import { generateSQLiteDrizzleJson, generateSQLiteMigration } from 'drizzle-kit/api'
import * as schema from '../server/database/schema.ts'

// Run only when deliberately replacing the empty-database baseline. No DB is opened.
const target = await generateSQLiteDrizzleJson(schema)
const empty = await generateSQLiteDrizzleJson({})
target.prevId = '00000000-0000-0000-0000-000000000000'
const statements = await generateSQLiteMigration(empty, target)
const custom = await readFile(new URL('../server/database/baseline-extra.sql', import.meta.url), 'utf8')
await writeFile(new URL('../server/database/migrations/0000_baseline.sql', import.meta.url), statements.join('\n--> statement-breakpoint\n') + '\n--> statement-breakpoint\n' + custom)
await writeFile(new URL('../server/database/migrations/meta/0000_snapshot.json', import.meta.url), JSON.stringify(target, null, 2) + '\n')
console.log(`Generated empty-database baseline: ${Object.keys(target.tables).length} tables`)
