/**
 * Cloudflare Worker entry. One deploy per world: LAB + D1 binding in wrangler.toml.
 * Invites live in D1 so they survive isolate hops.
 */
import { createWorldApp } from "./kit/app.ts"
import { bindingDriver, type D1Binding } from "./kit/d1.ts"
import { WorldStore } from "./kit/store.ts"
import { WORLDS } from "./worlds/catalog.ts"

export interface Env {
	DB: D1Binding
	LAB: string
}

let cached: { app: { fetch: (request: Request) => Response | Promise<Response> }; worldId: string } | null = null

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const world = WORLDS[env.LAB]
		if (world === undefined) {
			return Response.json({ error_key: "unknown_lab", message: `unknown LAB=${env.LAB}` }, { status: 500 })
		}
		if (cached === null || cached.worldId !== world.id) {
			const store = WorldStore.attach(bindingDriver(env.DB), world)
			cached = { app: createWorldApp(world, store), worldId: world.id }
		}
		return cached.app.fetch(request)
	},
}
