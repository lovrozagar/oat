/**
 * Create (or reuse) one Cloudflare D1 database per labs world, apply that
 * world's schema, and write CLOUDFLARE_D1_<WORLD>=<uuid> into the repo-root .env.
 *
 *   node labs/provision.mjs              # tiny, shop, campus, platform, probe cases
 *   node labs/provision.mjs tiny shop    # subset
 *   LAB_SCALE=1 node labs/provision.mjs  # also huge + vast (schema only)
 *
 * Reads CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN from .env. Never prints them.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { schemaStatements } from "./kit/schema.ts"
import { WORLDS } from "./worlds/catalog.ts"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const envPath = join(root, ".env")
const mapPath = join(root, "labs", ".d1.json")

const DEFAULT = [
	"tiny",
	"shop",
	"campus",
	"platform",
	"ok-pair",
	"ok-classic",
	"ok-jobs",
	"bug-stale",
	"bug-nofilter",
	"bug-leak",
	"bug-overclaim",
	"bug-pagefilter",
	"bug-cursor",
	"bug-lostupdate",
	"bug-invite",
	"bug-tombstone",
	"bug-rank",
	"bug-filterleak",
	"bug-hasmore",
	"bug-maxlimit",
	"bug-search",
	"bug-select",
	"bug-sort",
	"bug-idem",
	"bug-immutable",
	"bug-enum",
	"bug-maxlen",
	"bug-required",
	"bug-revoke",
	"bug-offset",
	"bug-oracle",
	"bug-like",
	"bug-async",
	"bug-effect",
	"bug-oversort",
	"bug-overselect",
	"bug-receipt",
	"bug-count",
	"bug-widen",
	"bug-unknown",
	"bug-neq",
	"bug-and",
	"bug-or",
	"bug-numeric",
	"bug-limit",
	"bug-dropfield",
	"bug-status",
	"bug-del404",
	"bug-ctype",
	"bug-500",
	"bug-errschema",
]
const SCALE = ["huge", "vast"]

function parseEnv(text) {
	const out = {}
	for (const line of text.split("\n")) {
		const trimmed = line.trim()
		if (trimmed === "" || trimmed.startsWith("#")) continue
		const eq = trimmed.indexOf("=")
		if (eq === -1) continue
		out[trimmed.slice(0, eq)] = trimmed.slice(eq + 1)
	}
	return out
}

function d1EnvKey(worldId) {
	return `CLOUDFLARE_D1_${worldId.toUpperCase().replaceAll("-", "_")}`
}

function dbName(worldId) {
	return `oat-labs-${worldId}`
}

let envText = ""
try {
	envText = await readFile(envPath, "utf8")
} catch {
	console.error("provision: repo-root .env is missing")
	process.exit(1)
}
const env = parseEnv(envText)
const accountId = env.CLOUDFLARE_ACCOUNT_ID
const token = env.CLOUDFLARE_API_TOKEN
if (!accountId || !token) {
	console.error("provision: CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN must be set in .env")
	process.exit(1)
}

const requested = process.argv.slice(2)
const ids =
	requested.length > 0
		? requested
		: process.env.LAB_SCALE === "1"
			? [...DEFAULT, ...SCALE]
			: DEFAULT

for (const id of ids) {
	if (WORLDS[id] === undefined) {
		console.error(`provision: unknown world ${id}`)
		process.exit(2)
	}
}

const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" }
const listed = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database`, { headers })
const listBody = await listed.json()
if (!listBody.success) {
	console.error("provision: list D1 failed", JSON.stringify(listBody.errors ?? listBody, null, 2))
	process.exit(1)
}
const existing = new Map((listBody.result ?? []).map((db) => [db.name, db.uuid]))

let map = {}
try {
	map = JSON.parse(await readFile(mapPath, "utf8"))
} catch {
	map = {}
}

async function query(databaseId, sql, params = []) {
	const response = await fetch(
		`https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}/query`,
		{
			body: JSON.stringify({ params, sql }),
			headers,
			method: "POST",
		},
	)
	const body = await response.json()
	if (!response.ok || !body.success) {
		const detail = body.errors?.map((e) => `${e.code}: ${e.message}`).join("; ") ?? `HTTP ${response.status}`
		throw new Error(`${detail} for ${sql.slice(0, 120)}`)
	}
	return body.result?.[0]?.results ?? []
}

for (const id of ids) {
	const name = dbName(id)
	let databaseId = existing.get(name)
	if (databaseId === undefined) {
		const created = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database`, {
			body: JSON.stringify({ name }),
			headers,
			method: "POST",
		})
		const body = await created.json()
		if (!body.success) {
			console.error(`provision: create ${name} failed`, JSON.stringify(body.errors ?? body, null, 2))
			process.exit(1)
		}
		databaseId = body.result.uuid
		console.log(`created  ${name}  ${databaseId}`)
	} else {
		console.log(`reusing  ${name}  ${databaseId}`)
	}

	const world = WORLDS[id]
	const statements = schemaStatements(world)
	for (const sql of statements) {
		await query(databaseId, sql)
	}
	const tables = await query(databaseId, "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
	console.log(`  schema  ${world.entities.length} entities  ${tables.length} tables`)

	const key = d1EnvKey(id)
	if (new RegExp(`^${key}=`, "m").test(envText)) {
		envText = envText.replace(new RegExp(`^${key}=.*$`, "m"), `${key}=${databaseId}`)
	} else {
		if (!envText.endsWith("\n")) envText += "\n"
		envText += `${key}=${databaseId}\n`
	}
	map[id] = { id: databaseId, name, entities: world.entities.length }
}

await writeFile(envPath, envText)
await mkdir(dirname(mapPath), { recursive: true })
await writeFile(mapPath, `${JSON.stringify(map, null, 2)}\n`)
console.log(`wrote ${ids.length} D1 id(s) to .env and labs/.d1.json`)
