/**
 * Create (or reuse) a D1 database named oat-lab and write CLOUDFLARE_D1_DATABASE_ID into .env.
 *
 * Reads credentials from the repo-root .env — never pass the token on the command line.
 *
 *   node lab/provision.mjs
 */
import { readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const envPath = join(root, ".env")

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

const env = parseEnv(await readFile(envPath, "utf8"))
const accountId = env.CLOUDFLARE_ACCOUNT_ID
const token = env.CLOUDFLARE_API_TOKEN
if (!accountId || !token) {
	console.error("provision: CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN must be set in .env")
	process.exit(1)
}

const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" }
const list = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database`, { headers })
const listed = await list.json()
if (!listed.success) {
	console.error("provision: list D1 failed", JSON.stringify(listed.errors ?? listed, null, 2))
	process.exit(1)
}
const existing = (listed.result ?? []).find((db) => db.name === "oat-lab")
let databaseId = existing?.uuid
if (databaseId === undefined) {
	const created = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database`, {
		body: JSON.stringify({ name: "oat-lab" }),
		headers,
		method: "POST",
	})
	const body = await created.json()
	if (!body.success) {
		console.error("provision: create D1 failed", JSON.stringify(body.errors ?? body, null, 2))
		process.exit(1)
	}
	databaseId = body.result.uuid
	console.log(`created D1 oat-lab ${databaseId}`)
} else {
	console.log(`reusing D1 oat-lab ${databaseId}`)
}

let text = await readFile(envPath, "utf8")
if (/^CLOUDFLARE_D1_DATABASE_ID=/m.test(text)) {
	text = text.replace(/^CLOUDFLARE_D1_DATABASE_ID=.*$/m, `CLOUDFLARE_D1_DATABASE_ID=${databaseId}`)
} else {
	text += `\nCLOUDFLARE_D1_DATABASE_ID=${databaseId}\n`
}
await writeFile(envPath, text)
console.log("wrote CLOUDFLARE_D1_DATABASE_ID to .env")
console.log("start with LAB_STORE=d1  node --experimental-sqlite --experimental-strip-types lab/index.ts")
