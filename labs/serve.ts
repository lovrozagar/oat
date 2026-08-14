/**
 * Serve one labs world. Storage is always Cloudflare D1.
 *
 *   node labs/provision.mjs tiny
 *   LAB=tiny LAB_PORT=8790 node --experimental-strip-types labs/serve.ts
 */

import { createServer } from "node:http"
import { serve } from "@hono/node-server"
import { createWorldApp } from "./kit/app.ts"
import { httpDriver } from "./kit/d1.ts"
import { requireD1 } from "./kit/env.ts"
import { WorldStore } from "./kit/store.ts"
import { WORLDS } from "./worlds/catalog.ts"

const worldId = process.env.LAB ?? process.argv[2] ?? "tiny"
const world = WORLDS[worldId]
if (world === undefined) {
	process.stderr.write(`unknown LAB=${worldId}. choose: ${Object.keys(WORLDS).sort().join(", ")}\n`)
	process.exit(2)
}

const creds = requireD1(world.id)
const store = await WorldStore.open(
	httpDriver({
		accountId: creds.accountId,
		apiToken: creds.apiToken,
		databaseId: creds.databaseId,
	}),
	world,
)
const app = createWorldApp(world, store)
const port = Number(process.env.LAB_PORT ?? 8788)
serve({ createServer, fetch: app.fetch, port })
process.stdout.write(
	`labs/${world.id}  http://127.0.0.1:${port}  entities=${world.entities.length}  store=d1 ${creds.databaseId}\n` +
		`  spec    http://127.0.0.1:${port}/v1/openapi/spec\n` +
		`  oat     LAB_URL=http://127.0.0.1:${port} node --experimental-sqlite dist/cli.js run --config labs/oat.config.ts\n`,
)
