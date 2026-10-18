import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import type { OpenApiDocument } from "../../src/spec/types.ts"

/*
 * Backends for the `identity: self` integration tests: each serves its spec at /openapi.json and
 * answers the caller routes for the token `Bearer alpha`. A server is returned with its own close,
 * so the test that started it owns its teardown.
 */

export type Served = { close: () => Promise<void>; url: string }

type Call = { method: string; req: IncomingMessage; res: ServerResponse; url: URL }

type Route = (call: Call) => boolean | Promise<boolean>

type Schema = Record<string, unknown>

const UNAUTHORIZED = { error: "unauthorized" }

const ALPHA = "Bearer alpha"

export const booleanSchema = {
	properties: { dismissed: { type: "boolean" } },
	required: ["dismissed"],
	type: "object",
}

async function readBody(req: IncomingMessage): Promise<unknown> {
	const chunks: Buffer[] = []
	for await (const chunk of req) chunks.push(chunk as Buffer)
	const text = Buffer.concat(chunks).toString("utf8")
	if (text === "") return undefined
	return JSON.parse(text) as unknown
}

/* A JSON answer, or a bare status when there is no body. */
function send(res: ServerResponse, status: number, body?: unknown): void {
	if (body === undefined) {
		res.writeHead(status)
		res.end()
		return
	}
	res.writeHead(status, { "content-type": "application/json" })
	res.end(JSON.stringify(body))
}

/* Serves the spec, hands every other request to the route, and answers 404 when it declines. */
async function serveRoutes(spec: OpenApiDocument, route: Route): Promise<Served> {
	const server = createServer((req: IncomingMessage, res: ServerResponse) => {
		void (async () => {
			const url = new URL(req.url ?? "/", "http://127.0.0.1")
			const method = (req.method ?? "GET").toUpperCase()
			if (url.pathname === "/openapi.json" && method === "GET") {
				send(res, 200, spec)
				return
			}
			if (!(await route({ method, req, res, url }))) send(res, 404)
		})()
	})
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
	return {
		close: () => new Promise<void>((resolve) => server.close(() => resolve())),
		url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
	}
}

function selfSpec(paths: OpenApiDocument["paths"], title = "self-boolean"): OpenApiDocument {
	return { info: { title, version: "1" }, openapi: "3.1.0", paths } as OpenApiDocument
}

function ok(schema: Schema, description = "ok") {
	return { content: { "application/json": { schema } }, description }
}

const unauthorized = { description: "unauthorized" }

const missing = { description: "missing" }

/* What one operation answers, and the body it takes when it takes one. */
interface OpShape {
	responses: Record<string, unknown>
	body?: Schema
}

/* One `identity: self` operation on the profile entity. */
function selfOp(operationId: string, action: string, { body, responses }: OpShape) {
	return {
		operationId,
		...(body === undefined
			? {}
			: { requestBody: { content: { "application/json": { schema: body } }, required: true } }),
		responses,
		"x-entity": { action, identity: "self", name: "profile" },
	}
}

/* A caller profile one read and one update share. */
function readUpdateSpec(schema: Schema, title?: string): OpenApiDocument {
	const responses = { "200": ok(schema), "401": unauthorized }
	return selfSpec(
		{
			"/v1/me": {
				get: selfOp("profile.read", "read", { responses }),
				patch: selfOp("profile.update", "update", { body: schema, responses }),
			},
		},
		title,
	)
}

export type ProfileMode = "hold" | "open" | "forget" | "throttle"

function profileSpec(): OpenApiDocument {
	const profile = {
		properties: {
			first_name: { anyOf: [{ maxLength: 50, type: "string" }, { type: "null" }] },
		},
		type: "object",
	}
	return readUpdateSpec(profile, "self")
}

/*
 * A profile whose caller route holds an update (`hold`), answers with no token (`open`), forgets
 * the update (`forget`), or throttles every read once the update lands (`throttle`).
 */
export function serveProfile(mode: ProfileMode): Promise<Served> {
	const state = { first: "Ada", patched: false }
	return serveRoutes(profileSpec(), async ({ method, req, res, url }) => {
		if (url.pathname !== "/v1/me") return false
		if (req.headers.authorization !== ALPHA && mode !== "open") {
			send(res, 401, UNAUTHORIZED)
			return true
		}
		if (method === "GET") {
			if (mode === "throttle" && state.patched) {
				res.setHeader("retry-after", "0")
				send(res, 429, { error: "too_many_requests" })
			} else send(res, 200, { first_name: state.first })
			return true
		}
		if (method !== "PATCH") return false
		const body = (await readBody(req)) as { first_name?: unknown }
		if (mode !== "forget" && typeof body.first_name === "string") state.first = body.first_name
		state.patched = true
		send(res, 200, { first_name: mode === "forget" ? "Ada" : state.first })
		return true
	})
}

/* Answers GET with `read()` and PATCH /v1/me through `write`, on every listed caller path. */
function serveDismissed(spec: OpenApiDocument, paths: readonly string[], read: () => unknown): Promise<Served> {
	const state = { dismissed: false }
	return serveRoutes(spec, async ({ method, req, res, url }) => {
		if (!paths.includes(url.pathname)) return false
		if (req.headers.authorization !== ALPHA) {
			send(res, 401, UNAUTHORIZED)
			return true
		}
		if (method === "PATCH" && url.pathname === "/v1/me") {
			const body = (await readBody(req)) as { dismissed?: unknown }
			if (typeof body.dismissed === "boolean") state.dismissed = body.dismissed
		} else if (method !== "GET") return false
		send(res, 200, { ...(read() as object), dismissed: state.dismissed })
		return true
	})
}

export function serveBoolean(): Promise<Served> {
	return serveDismissed(readUpdateSpec(booleanSchema), ["/v1/me"], () => ({}))
}

export function serveEnumAndBoolean(): Promise<Served> {
	const schema = {
		properties: {
			channel: { enum: ["app", "email"], type: "string" },
			dismissed: { type: "boolean" },
		},
		required: ["channel", "dismissed"],
		type: "object",
	}
	return serveDismissed(readUpdateSpec(schema), ["/v1/me"], () => ({ channel: "app" }))
}

export function serveTwoReads(): Promise<Served> {
	const responses = { "200": ok(booleanSchema), "401": unauthorized }
	const spec = selfSpec({
		"/v1/me": {
			get: selfOp("profile.read", "read", { responses }),
			patch: selfOp("profile.update", "update", { body: booleanSchema, responses }),
		},
		"/v1/me/flags": {
			get: selfOp("profile.flags", "read", { responses }),
		},
	})
	return serveDismissed(spec, ["/v1/me", "/v1/me/flags"], () => ({}))
}

function createFirstSpec(): OpenApiDocument {
	const schema = {
		properties: {
			display_name: { maxLength: 50, minLength: 1, type: "string" },
			link_label: { maxLength: 20, type: "string" },
		},
		required: ["display_name"],
		type: "object",
	}
	const responses = { "200": ok(schema), "401": unauthorized, "404": missing }
	return selfSpec({
		"/v1/me": {
			get: selfOp("profile.read", "read", { responses }),
			patch: selfOp("profile.update", "update", { body: schema, responses }),
			post: selfOp("profile.create", "create", {
				body: schema,
				responses: { "201": ok(schema, "created"), "401": unauthorized },
			}),
		},
	})
}

type CreateFirstState = { stored: { display_name: string } | undefined }

/* The create refuses an optional `link_label` sent without its url, and any empty display name. */
async function createFirstPost(state: CreateFirstState, req: IncomingMessage, res: ServerResponse): Promise<void> {
	const body = (await readBody(req)) as { display_name?: unknown; link_label?: unknown }
	if ("link_label" in body) send(res, 400, { error: "label without url" })
	else if (typeof body.display_name !== "string" || body.display_name === "") send(res, 400, { error: "invalid" })
	else {
		state.stored = { display_name: body.display_name }
		send(res, 201, state.stored)
	}
}

/* A caller who does not exist until the spec create makes them: every read before it is a 404. */
export function serveCreateFirst(): Promise<Served> {
	const state: CreateFirstState = { stored: undefined }
	return serveRoutes(createFirstSpec(), async ({ method, req, res, url }) => {
		if (url.pathname !== "/v1/me") return false
		if (req.headers.authorization !== ALPHA) send(res, 401, UNAUTHORIZED)
		else if (method === "POST") await createFirstPost(state, req, res)
		else if (state.stored === undefined) send(res, 404, { error: "missing" })
		else if (method === "GET") send(res, 200, state.stored)
		else if (method === "PATCH") {
			const body = (await readBody(req)) as { display_name?: unknown }
			if (typeof body.display_name === "string") state.stored = { display_name: body.display_name }
			send(res, 200, state.stored)
		} else return false
		return true
	})
}

function nestedSpec(): OpenApiDocument {
	const readSchema = {
		additionalProperties: booleanSchema,
		type: "object",
	}
	const updateSchema = {
		properties: {
			channel: { enum: ["app", "email"], type: "string" },
			dismissed: { type: "boolean" },
		},
		type: "object",
	}
	const responses = { "200": ok(readSchema), "401": unauthorized }
	return selfSpec({
		"/v1/me": {
			get: selfOp("profile.read", "read", { responses }),
			patch: selfOp("profile.update", "update", { body: updateSchema, responses }),
		},
	})
}

/* A read that nests the boolean under each channel; an update flips the email channel's. */
export function serveNested(): Promise<Served> {
	const channels = { app: { dismissed: true }, email: { dismissed: true } }
	return serveRoutes(nestedSpec(), async ({ method, req, res, url }) => {
		if (url.pathname !== "/v1/me") return false
		if (req.headers.authorization !== ALPHA) send(res, 401, UNAUTHORIZED)
		else if (method === "GET") send(res, 200, channels)
		else if (method === "PATCH") {
			const body = (await readBody(req)) as { dismissed?: unknown }
			if (typeof body.dismissed === "boolean") channels.email.dismissed = body.dismissed
			send(res, 200, channels)
		} else return false
		return true
	})
}

function handleSpec(): OpenApiDocument {
	const bodySchema = {
		properties: {
			display_name: { maxLength: 80, minLength: 1, type: "string" },
			handle: { maxLength: 32, minLength: 3, type: "string" },
		},
		required: ["display_name", "handle"],
		type: "object",
	}
	const answer = {
		properties: { available: { type: "boolean" } },
		required: ["available"],
		type: "object",
	}
	const available = selfOp("profile.available", "action", { responses: { "200": ok(answer), "401": unauthorized } })
	const parameters = [{ in: "query", name: "handle", required: true, schema: { minLength: 1, type: "string" } }]
	return selfSpec({
		"/v1/handle-available": { get: { ...available, parameters } },
		"/v1/me": {
			get: selfOp("profile.read", "read", {
				responses: { "200": ok(bodySchema), "401": unauthorized, "404": missing },
			}),
			patch: selfOp("profile.update", "update", {
				body: bodySchema,
				responses: { "200": ok(bodySchema), "401": unauthorized },
			}),
			post: selfOp("profile.create", "create", {
				body: bodySchema,
				responses: { "201": ok(bodySchema, "created"), "401": unauthorized },
			}),
		},
	})
}

export type HandleState = { seen: string; stored: { display_name: string; handle: string } | undefined }

async function handlePost(state: HandleState, req: IncomingMessage, res: ServerResponse): Promise<void> {
	const body = (await readBody(req)) as { display_name?: unknown; handle?: unknown }
	if (typeof body.display_name !== "string" || typeof body.handle !== "string") {
		send(res, 400)
		return
	}
	state.stored = { display_name: body.display_name, handle: body.handle }
	send(res, 201, state.stored)
}

async function handleMe(state: HandleState, { method, req, res }: Call): Promise<boolean> {
	if (method === "POST") await handlePost(state, req, res)
	else if (state.stored === undefined) return false
	else if (method === "GET") send(res, 200, state.stored)
	else if (method === "PATCH") {
		const body = (await readBody(req)) as { display_name?: unknown }
		if (typeof body.display_name === "string") state.stored = { ...state.stored, display_name: body.display_name }
		send(res, 200, state.stored)
	} else return false
	return true
}

/*
 * A caller query that answers `available` only for the handle the create stored. The state is
 * returned so the test can read the handle the query was asked with.
 */
export async function serveHandleQuery(): Promise<{ served: Served; state: HandleState }> {
	const state: HandleState = { seen: "", stored: undefined }
	const served = await serveRoutes(handleSpec(), (call) => {
		const { method, req, res, url } = call
		if (req.headers.authorization !== ALPHA && url.pathname !== "/openapi.json") {
			send(res, 401, UNAUTHORIZED)
			return true
		}
		if (url.pathname === "/v1/handle-available" && method === "GET") {
			state.seen = url.searchParams.get("handle") ?? ""
			send(res, 200, { available: state.stored !== undefined && state.seen === state.stored.handle })
			return true
		}
		return url.pathname === "/v1/me" && handleMe(state, call)
	})
	return { served, state }
}
