/**
 * Deploy each provisioned labs world as a Worker bound to its D1 database.
 *
 *   node labs/provision.mjs tiny shop
 *   node labs/deploy.mjs tiny shop
 *
 * Uses wrangler (labs/node_modules). Auth is CLOUDFLARE_API_TOKEN from .env.
 * Prints the https URL oat should hit next.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { spawn } from "node:child_process"
import { loadDotEnv, d1EnvKey } from "./kit/env.ts"

const here = dirname(fileURLToPath(import.meta.url))
const env = loadDotEnv()
const accountId = env.CLOUDFLARE_ACCOUNT_ID
const token = env.CLOUDFLARE_API_TOKEN
if (!accountId || !token) {
	console.error("deploy: CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN must be set in .env")
	process.exit(1)
}

const requested = process.argv.slice(2)
if (requested.length === 0) {
	console.error("deploy: pass world ids, e.g. node labs/deploy.mjs tiny shop")
	process.exit(2)
}

const wrangler = join(here, "node_modules", ".bin", "wrangler")
const urls = {}

function run(cmd, args, cwd) {
	return new Promise((resolve, reject) => {
		const child = spawn(cmd, args, {
			cwd,
			env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: accountId, CLOUDFLARE_API_TOKEN: token },
			stdio: ["ignore", "pipe", "pipe"],
		})
		let out = ""
		let err = ""
		child.stdout.on("data", (chunk) => {
			out += chunk
			process.stdout.write(chunk)
		})
		child.stderr.on("data", (chunk) => {
			err += chunk
			process.stderr.write(chunk)
		})
		child.on("close", (code) => {
			if (code === 0) resolve(out)
			else reject(new Error(`${cmd} ${args.join(" ")} exited ${code}\n${err}`))
		})
	})
}

for (const id of requested) {
	const key = d1EnvKey(id)
	const databaseId = env[key] ?? process.env[key]
	if (!databaseId) {
		console.error(`deploy: missing ${key}. Run node labs/provision.mjs ${id}`)
		process.exit(1)
	}
	const dir = join(here, ".deploy", id)
	await mkdir(dir, { recursive: true })
	const name = `oat-labs-${id}`
	const toml = `name = "${name}"
main = "../../worker.ts"
compatibility_date = "2026-01-15"
compatibility_flags = ["nodejs_compat"]

[vars]
LAB = "${id}"

[[d1_databases]]
binding = "DB"
database_name = "${name}"
database_id = "${databaseId}"
`
	await writeFile(join(dir, "wrangler.toml"), toml)
	console.log(`── deploy ${name}`)
	const out = await run(wrangler, ["deploy"], dir)
	const match = out.match(/https:\/\/[^\s]+workers\.dev[^\s]*/)
	if (match) urls[id] = match[0].replace(/\/$/, "")
}

const urlPath = join(here, ".deploy", "urls.json")
let previous = {}
try {
	previous = JSON.parse(await readFile(urlPath, "utf8"))
} catch {
	previous = {}
}
const merged = { ...previous, ...urls }
await writeFile(urlPath, `${JSON.stringify(merged, null, 2)}\n`)
console.log("deployed")
for (const [id, url] of Object.entries(urls)) {
	console.log(`  ${id}  ${url}`)
	console.log(
		`    LAB_URL=${url} node --experimental-sqlite dist/cli.js run --config labs/oat.config.ts --out oat-out/labs/https-${id}`,
	)
}
