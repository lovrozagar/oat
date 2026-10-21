/**
 * The feature-gate suite's backend, as a `Handle`: webhooks whose create or update may answer a
 * feature-gate 403, and invites that never do.
 */

import type { Handle } from "../../reference/http/node.ts"
import type { ReferenceRequest, ReferenceResponse } from "../../reference/http/wire.ts"
import { bearerGuarded } from "../harness/security.ts"
import { answer, guarded, readJson } from "../harness/serve.ts"
import { webhookSpec } from "./spec.ts"

export type CreateMode = "gate-match" | "gate-mismatch" | "plain-403" | "created"
export type UpdateMode = "ok" | "gate-match"

export interface HarnessOptions {
	create: CreateMode
	listSeeded?: boolean
	specTag: string | null
	update?: UpdateMode
}

interface Webhook {
	id: string
	url: string
}

/** What one backend holds between requests. */
interface Rows {
	webhooks: Map<string, Webhook>
	invites: Map<string, { email: string; id: string }>
	seq: number
}

/** A route's answer, given the request, the item id the path carries (encoded), and the rows. */
type Answer = (request: ReferenceRequest, id: string, rows: Rows) => Promise<ReferenceResponse>

const COLLECTION = /^\/v1\/orgs\/org_1\/(webhooks|invites)$/
const ITEM = /^\/v1\/orgs\/org_1\/webhooks\/([^/]+)$/

/** The 403 a plan without `feature` answers. */
export function gateBody(feature: string): Record<string, unknown> {
	return {
		error_key: "forbidden",
		status: 403,
		status_key: "forbidden",
		success: false,
		vars: {
			current_plan: "free",
			feature,
			feature_name: feature === "webhooks" ? "Webhooks" : feature,
			required_plan: "pro",
			type: "feature_gate",
		},
	}
}

/** The 403 webhook create answers in `mode`, or null when it creates. */
function createDenial(mode: CreateMode): ReferenceResponse | null {
	if (mode === "gate-match") return answer(403, gateBody("webhooks"))
	if (mode === "gate-mismatch") return answer(403, gateBody("custom_domain"))
	if (mode === "plain-403") return answer(403, { error_key: "forbidden" })
	return null
}

/** The next id with `prefix`, counted across both tables. */
function nextId(rows: Rows, prefix: string): string {
	rows.seq += 1
	return `${prefix}_${String(rows.seq)}`
}

function routes(options: HarnessOptions): Record<string, Answer> {
	return {
		"GET invites": async (_request, _id, rows) => answer(200, { invites: [...rows.invites.values()] }),
		"GET webhook": async (_request, id, rows) => {
			const row = rows.webhooks.get(decodeURIComponent(id))
			return row === undefined ? answer(404, { error_key: "not_found" }) : answer(200, row)
		},
		"GET webhooks": async (_request, _id, rows) => answer(200, { webhooks: [...rows.webhooks.values()] }),
		"PATCH webhook": async (request, id, rows) => {
			if (options.update === "gate-match") return answer(403, gateBody("webhooks"))
			const row = rows.webhooks.get(decodeURIComponent(id))
			if (row === undefined) return answer(404, { error_key: "not_found" })
			const body = (await readJson(request)) as { url?: unknown } | undefined
			if (typeof body?.url === "string") row.url = body.url
			return answer(200, row)
		},
		"POST invites": async (request, _id, rows) => {
			const body = (await readJson(request)) as { email?: unknown } | undefined
			if (typeof body?.email !== "string") return answer(400, { error_key: "required", vars: { field: "email" } })
			const row = { email: body.email, id: nextId(rows, "inv") }
			rows.invites.set(row.id, row)
			return answer(201, row)
		},
		"POST webhooks": async (request, _id, rows) => {
			const denial = createDenial(options.create)
			if (denial !== null) return denial
			const body = (await readJson(request)) as { url?: unknown } | undefined
			if (typeof body?.url !== "string") return answer(400, { error_key: "required", vars: { field: "url" } })
			const row = { id: nextId(rows, "wh"), url: body.url }
			rows.webhooks.set(row.id, row)
			return answer(201, row)
		},
	}
}

/** The route a path names, as `<method> <name>`, and the id an item path carries, still encoded. */
function routeOf(method: string, pathname: string): { key: string; id: string } {
	const collection = COLLECTION.exec(pathname)
	if (collection !== null) return { id: "", key: `${method} ${collection[1]}` }
	const item = ITEM.exec(pathname)
	if (item !== null) return { id: item[1] as string, key: `${method} webhook` }
	return { id: "", key: "" }
}

/** The bearer token the harness issues, and the only one it accepts. */
export const GATE_TOKEN = "tok_alpha"

/** A fresh backend: the document is public, every other route wants the token it issued. */
export function featureGateHarness(options: HarnessOptions): Handle {
	const spec = webhookSpec(options.specTag)
	const rows: Rows = { invites: new Map(), seq: 0, webhooks: new Map() }
	if (options.listSeeded === true)
		rows.webhooks.set("wh_existing", { id: "wh_existing", url: "https://example.test/hook" })
	const table = routes(options)
	return guarded(
		bearerGuarded(async (request) => {
			const { pathname } = request.url
			if (pathname === "/v1/openapi/spec" && request.method === "GET") return answer(200, spec)
			const { id, key } = routeOf(request.method, pathname)
			const route = table[key]
			return route === undefined ? answer(404, { error_key: "not_found" }) : route(request, id, rows)
		}, GATE_TOKEN),
		answer(500, { error_key: "internal" }),
	)
}
