/**
 * Write the SQL each world applies to D1 into labs/schema/<world>.sql
 * so the schema is visible on disk. Same statements provision.mjs runs.
 *
 *   node --experimental-strip-types labs/dump-schema.mjs
 */
import { mkdir, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { schemaStatements } from "./kit/schema.ts"
import { WORLDS } from "./worlds/catalog.ts"

const dir = join(dirname(fileURLToPath(import.meta.url)), "schema")
await mkdir(dir, { recursive: true })
for (const [id, world] of Object.entries(WORLDS).sort(([a], [b]) => a.localeCompare(b))) {
	const sql = `-- labs/${id} — ${world.entities.length} entities. Applied to D1 oat-labs-${id}.\n${schemaStatements(world).join(";\n")};\n`
	await writeFile(join(dir, `${id}.sql`), sql)
	process.stdout.write(`wrote schema/${id}.sql  ${world.entities.length} entities\n`)
}
