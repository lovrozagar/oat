import type { Principal } from "../../../config/types/principals.ts"
import type { OpenApiDocument } from "../../../spec/types.ts"
import type { RequestOptions } from "../../client.ts"
import { NetworkError } from "../../network.ts"
import type { Record_ } from "../../world.ts"
import type { Answer, Responder } from "../../checks/__fixtures__/harness.ts"
import { connect } from "../client-setup.ts"
import type { Connected, Loaded, Planned, RunContext } from "../context.ts"
import { createExclusion } from "../exclusion.ts"
import { load } from "../load.ts"
import { adoptPrincipals, resolvePrincipals } from "../principals.ts"
import { planScope } from "../scope-plan.ts"
import type { RunOptions } from "../types.ts"
import type { EntityRun } from "../entity/state.ts"
import { entityRun } from "../entity/test-entity.ts"

/*
 * A socket-free API for the run's stages: requests go through a scripted transport, and a small
 * notes API answers them from memory. The document is served by the same transport, so a run
 * loads it the way it loads any served document.
 */

export const BASE = "http://api.test"
export const SPEC = `${BASE}/openapi.json`

/** One request as the transport saw it. */
export interface Seen {
	host: string
	method: string
	path: string
	query: Record<string, string>
	body: unknown
	headers: Record<string, string>
}

/** A transport over `respond`, recording every request. An unknown route answers 404. */
export function transport(respond: Responder): { fetch: typeof fetch; seen: Seen[] } {
	const seen: Seen[] = []
	const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const url = new URL(String(input))
		const headers = Object.fromEntries(new Headers(init?.headers).entries())
		const text = typeof init?.body === "string" ? init.body : undefined
		const body = text === undefined ? init?.body : parsed(text)
		const query = Object.fromEntries(url.searchParams.entries())
		const method = init?.method ?? "GET"
		seen.push({ body, headers, host: url.host, method, path: url.pathname, query })
		const options: RequestOptions = { body, headers, query }
		const answer = respond(method, url.pathname, options) ?? { status: 404 }
		return responseOf(answer)
	}
	return { fetch: fetch as typeof globalThis.fetch, seen }
}

/** A transport to a host that refuses every connection. */
export const unreachable: typeof fetch = () =>
	Promise.reject(
		new Error("fetch failed", { cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }) }),
	)

function parsed(text: string): unknown {
	try {
		return JSON.parse(text)
	} catch {
		return text
	}
}

function responseOf(answer: Answer): Response {
	const empty = answer.body === undefined || answer.status === 204
	return new Response(empty ? null : JSON.stringify(answer.body), {
		headers: { ...(empty ? {} : { "content-type": "application/json" }), ...answer.headers },
		status: answer.status,
	})
}

const note = {
	properties: { id: { readOnly: true, type: "string" }, title: { maxLength: 40, type: "string" } },
	required: ["title"],
	type: "object",
}

const json = (schema: unknown) => ({ content: { "application/json": { schema } } })
const problem = { properties: { error: { type: "string" } }, type: "object" }
/* What a correct notes API also answers, documented: an invalid body, and a note that is not there. */
const refusals = { "404": { description: "no such note" }, "422": { description: "invalid note", ...json(problem) } }
const itemParam = { in: "path", name: "note_id", required: true, schema: { type: "string" } }

/** The notes document: a list, create, read, update and delete of notes. */
export function notesDoc(extra: Record<string, unknown> = {}): OpenApiDocument {
	return {
		info: { title: "notes", version: "1" },
		openapi: "3.1.0",
		paths: {
			"/notes": {
				get: {
					operationId: "notes.list",
					responses: { "200": { description: "ok", ...json({ items: note, type: "array" }) }, ...refusals },
				},
				post: {
					operationId: "notes.create",
					requestBody: { required: true, ...json(note) },
					responses: { "201": { description: "made", ...json(note) }, ...refusals },
				},
			},
			"/notes/{note_id}": {
				delete: {
					operationId: "notes.delete",
					parameters: [itemParam],
					responses: { "204": { description: "gone" }, ...refusals },
				},
				get: {
					operationId: "notes.get",
					parameters: [itemParam],
					responses: { "200": { description: "ok", ...json(note) }, ...refusals },
				},
				patch: {
					operationId: "notes.update",
					parameters: [itemParam],
					requestBody: json(note),
					responses: { "200": { description: "ok", ...json(note) }, ...refusals },
				},
			},
			...extra,
		},
	} as unknown as OpenApiDocument
}

/** A correct notes backend over `rows`, serving `doc` as its document. */
export function notesApi(doc: OpenApiDocument = notesDoc(), rows: Record_[] = []): Responder {
	let next = rows.length
	return (method, path, options) => {
		if (path === "/openapi.json") return { body: doc, status: 200 }
		if (path === "/notes" && method === "GET") return { body: rows, status: 200 }
		if (path === "/notes" && method === "POST") {
			if (!valid(options.body, true)) return { body: { error: "invalid note" }, status: 422 }
			next += 1
			const made = { ...(options.body as Record_), id: `n${next}` }
			rows.push(made)
			return { body: made, status: 201 }
		}
		const id = /^\/notes\/([^/]+)$/.exec(path)?.[1]
		const at = rows.findIndex((row) => row.id === id)
		if (at < 0) return undefined
		if (method === "GET") return { body: rows[at], status: 200 }
		if (method === "DELETE") {
			rows.splice(at, 1)
			return { status: 204 }
		}
		if (!valid(options.body, false)) return { body: { error: "invalid note" }, status: 422 }
		rows[at] = { ...rows[at], ...(options.body as Record_), id: rows[at]?.id }
		return { body: rows[at], status: 200 }
	}
}

/** A note body as the document allows it: a title of at most 40 characters, required on create. */
function valid(body: unknown, create: boolean): boolean {
	if (typeof body !== "object" || body === null || Array.isArray(body)) return false
	const { title, ...rest } = body as Record_
	if (Object.keys(rest).some((key) => key !== "id")) return false
	if (title === undefined) return !create
	return typeof title === "string" && title.length <= 40
}

export const ALPHA: Principal = { headers: { authorization: "Bearer alpha-key" }, id: "alpha" }

export const loginDoc = notesDoc({
	"/login": { post: { operationId: "auth.login", responses: { "200": { description: "ok" } }, security: [] } },
})

/** The notes API with a login that issues `token-<n>` for tenant t1, until `failing` says otherwise. */
export function withLogin(state = { failing: false, issued: 0 }): Responder {
	const notes = notesApi(loginDoc)
	return (method, path, request) => {
		if (path !== "/login") return notes(method, path, request)
		if (state.failing) return { status: 500 }
		state.issued += 1
		return { body: { email: "a@x.test", expires_in: 1, tenant: "t1", token: `token-${state.issued}` }, status: 200 }
	}
}

export const flow: Principal = {
	auth: {
		credentialFrom: "$.token",
		expiresInFrom: "$.expires_in",
		refreshBufferMs: 30_000,
		steps: [{ operationId: "auth.login", saveAs: { email: "$.email", tenant: "$.tenant" } } as never],
	},
	headers: { "x-client": "oat" },
	id: "flow",
	roots: { org_id: "o1" },
	rootsFromFlow: { tenant_id: "tenant", unknown_id: "missing" },
}

/** Run options against `respond` through the fake transport: no retries, no waiting. */
export function optionsFor(respond: Responder, extra: Partial<RunOptions> = {}): RunOptions & { seen: Seen[] } {
	const { fetch, seen } = transport(respond)
	return {
		baseUrl: BASE,
		nonce: "n0nce",
		principals: [ALPHA],
		spec: SPEC,
		...extra,
		network: { fetch, retries: 0, waitMs: 0, ...extra.network },
		seen,
	}
}

/** The run, loaded. */
export function loaded(options: RunOptions): Promise<Loaded> {
	return load(options)
}

/** The run, loaded and connected. */
export async function connected(options: RunOptions): Promise<Connected> {
	return connect(await load(options))
}

/** The run, planned. */
export async function planned(options: RunOptions): Promise<Planned> {
	return planScope(await connected(options))
}

/** The run, ready for the stages after authentication. */
export async function contextOf(options: RunOptions): Promise<RunContext> {
	const plan = await planned(options)
	const resolved = await resolvePrincipals(plan)
	if (resolved === null) throw new Error("the test principals could not be resolved")
	const authed = adoptPrincipals(plan, resolved)
	return { ...authed, exclusion: createExclusion(authed), targetVersion: undefined }
}

/** The transport `options` were made with. */
export function fetchOf(options: RunOptions): typeof fetch {
	const given = options.network?.fetch
	if (given === undefined) throw new Error("these options have no transport")
	return given
}

/** A network failure of `kind`, as the client throws it. */
export function outage(kind: "dns" | "timeout" | "refused" = "dns"): NetworkError {
	return new NetworkError({
		attempts: 1,
		cause: new Error(kind),
		kind,
		message: `GET u failed (${kind})`,
		method: "GET",
		url: "http://api.test/notes",
	})
}

/** One operation of a document's paths, for a test to tag; throws when the document lacks it. */
export function operationAt(doc: unknown, path: string, method: string): Record<string, unknown> {
	const found = (doc as { paths: Record<string, Record<string, Record<string, unknown>> | undefined> }).paths[path]?.[
		method
	]
	if (found === undefined) throw new Error(`the test document has no ${method} ${path}`)
	return found
}

/** `respond`, with `override` answering first wherever it returns an answer. */
export function overriding(respond: Responder, override: Responder): Responder {
	return (method, path, request) => override(method, path, request) ?? respond(method, path, request)
}

/** The run's state for testing entity `name`, as testEntity would begin it. */
export function entityRunOf(ctx: RunContext, name = "note"): EntityRun {
	const entity = ctx.model.entities.get(name)
	const listOp = ctx.model.byOperationId.get(entity?.list ?? "")
	if (entity === undefined || listOp === undefined) throw new Error(`the test document has no listed ${name}`)
	return entityRun(ctx, entity, listOp)
}
