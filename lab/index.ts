/**
 * Lab API — lives entirely under lab/, not oat's src/.
 *
 *   bun --cwd lab install
 *   node --experimental-sqlite --experimental-strip-types lab/index.ts
 *
 * LAB_STORE=sqlite (default) writes lab/.data/lab.sqlite.
 * LAB_STORE=d1 uses CLOUDFLARE_* from the repo-root .env (after `node lab/provision.mjs`).
 */

import { readFileSync } from "node:fs"
import { mkdir } from "node:fs/promises"
import { createServer } from "node:http"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { serve } from "@hono/node-server"
import { createApp } from "./app.ts"
import { d1Driver } from "./d1.ts"
import { Store, type Driver } from "./store.ts"

const here = dirname(fileURLToPath(import.meta.url))

function loadDotEnv(): void {
	const path = join(here, "..", ".env")
	try {
		const text = readFileSync(path, "utf8")
		for (const line of text.split("\n")) {
			const trimmed = line.trim()
			if (trimmed === "" || trimmed.startsWith("#")) continue
			const eq = trimmed.indexOf("=")
			if (eq === -1) continue
			const key = trimmed.slice(0, eq)
			const value = trimmed.slice(eq + 1)
			if (process.env[key] === undefined) process.env[key] = value
		}
	} catch {
		/* .env is optional for the sqlite store. */
	}
}

loadDotEnv()

async function openDriver(): Promise<Driver> {
	const mode = process.env.LAB_STORE ?? "sqlite"
	if (mode === "d1") {
		const accountId = process.env.CLOUDFLARE_ACCOUNT_ID
		const databaseId = process.env.CLOUDFLARE_D1_DATABASE_ID
		const apiToken = process.env.CLOUDFLARE_API_TOKEN
		if (!accountId || !databaseId || !apiToken) {
			throw new Error("LAB_STORE=d1 needs CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_D1_DATABASE_ID, CLOUDFLARE_API_TOKEN")
		}
		return d1Driver({ accountId, apiToken, databaseId })
	}

	const dir = join(here, ".data")
	await mkdir(dir, { recursive: true })
	const { DatabaseSync } = await import("node:sqlite")
	const db = new DatabaseSync(join(dir, "lab.sqlite"))
	db.exec("PRAGMA journal_mode = WAL")
	return {
		async all(sql, args) {
			return db.prepare(sql).all(...(args as never[])) as Record<string, unknown>[]
		},
		async exec(sql) {
			db.exec(sql)
		},
		async run(sql, args) {
			db.prepare(sql).run(...(args as never[]))
		},
	}
}

const driver = await openDriver()
const store = await Store.open(driver)
const app = createApp(store)
const port = Number(process.env.LAB_PORT ?? 8788)

serve({ createServer, fetch: app.fetch, port })
process.stdout.write(
	`oat-lab  http://127.0.0.1:${port}  store=${process.env.LAB_STORE ?? "sqlite"}\n` +
		`  spec    http://127.0.0.1:${port}/v1/openapi/spec\n` +
		`  oat     node --experimental-sqlite dist/cli.js run --config lab/oat.config.ts\n`,
)
