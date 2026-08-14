import { allColumns, type Entity, type World } from "./types.ts"

function sqlType(entity: Entity, column: string): string {
	if (column === "id" || column === "org_id" || column.endsWith("_id")) return "TEXT"
	if (column === "created_at" || column === "updated_at" || column === "deleted_at") return "INTEGER"
	const field = entity.fields.find((f) => f.name === column)
	if (field?.type === "integer" || field?.type === "boolean") return "INTEGER"
	if (field?.type === "number") return "REAL"
	if ((entity.derived ?? []).some((d) => d.name === column)) return "INTEGER"
	return "TEXT"
}

/** One statement per call — D1's HTTP query endpoint does not take a script. */
export function schemaStatements(world: World): string[] {
	const statements = [
		`CREATE TABLE IF NOT EXISTS idempotency (key TEXT PRIMARY KEY, record TEXT NOT NULL)`,
		`CREATE TABLE IF NOT EXISTS invites (grant_id TEXT PRIMARY KEY, token TEXT NOT NULL UNIQUE, entity TEXT NOT NULL, item_id TEXT NOT NULL, owner_org TEXT NOT NULL, grantee_key TEXT NOT NULL, accepted INTEGER NOT NULL DEFAULT 0)`,
	]
	for (const entity of world.entities) {
		const cols = allColumns(entity).map((column) => {
			const extra = column === "id" ? " PRIMARY KEY" : column === "org_id" ? " NOT NULL" : ""
			return `"${column}" ${sqlType(entity, column)}${extra}`
		})
		statements.push(`CREATE TABLE IF NOT EXISTS "${entity.plural}" (${cols.join(", ")})`)
		statements.push(
			`CREATE INDEX IF NOT EXISTS "${entity.plural}_org" ON "${entity.plural}" (org_id, ${
				entity.softDelete === true ? "deleted_at, " : ""
			}id)`,
		)
	}
	return statements
}

export function createSchemaSql(world: World): string {
	return `${schemaStatements(world).join(";\n")};\n`
}
