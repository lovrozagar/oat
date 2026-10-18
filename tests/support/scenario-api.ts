import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import type { OpenApiDocument } from "../../src/spec/types.ts"

/*
 * The notes API the scenario tests drive: notes to write, rename and list, stats that show writes
 * after a lag, and the endpoints an auth flow, a browser checkout and a signing ceremony call.
 */

const json = { "application/json": { schema: { type: "object" } } }
const noteSchema = {
	properties: { id: { type: "string" }, text: { type: "string" } },
	required: ["id", "text"],
	type: "object",
}
const noteJson = { "application/json": { schema: noteSchema } }
const noteList = {
	"application/json": {
		schema: { properties: { items: { items: noteSchema, type: "array" } }, required: ["items"], type: "object" },
	},
}
const noteWrite = {
	content: {
		"application/json": {
			schema: { properties: { text: { type: "string" } }, required: ["text"], type: "object" },
		},
	},
}

function notePaths(): Record<string, unknown> {
	return {
		"/v1/notes": {
			get: { operationId: "notes.list", responses: { "200": { content: noteList, description: "ok" } } },
			post: {
				operationId: "notes.write",
				requestBody: noteWrite,
				responses: { "201": { content: noteJson, description: "ok" } },
			},
		},
		"/v1/notes/{id}": {
			patch: {
				operationId: "notes.rename",
				parameters: [{ in: "path", name: "id", required: true, schema: { type: "string" } }],
				requestBody: noteWrite,
				responses: { "200": { content: noteJson, description: "ok" } },
			},
		},
		"/v1/stats": {
			get: { operationId: "stats.get", responses: { "200": { content: json, description: "ok" } } },
		},
		"/v1/checkout": {
			post: { operationId: "checkout.open", responses: { "200": { content: json, description: "ok" } } },
		},
		"/v1/forms": {
			post: {
				operationId: "form.send",
				requestBody: {
					content: {
						"multipart/form-data": {
							schema: {
								properties: { file: { format: "binary", type: "string" }, text: { type: "string" } },
								type: "object",
							},
						},
						"application/x-www-form-urlencoded": {
							schema: { properties: { text: { type: "string" } }, type: "object" },
						},
					},
				},
				responses: { "200": { content: json, description: "ok" } },
			},
		},
	}
}

function flowPaths(): Record<string, unknown> {
	return {
		"/v1/token": {
			post: { operationId: "token.mint", responses: { "200": { content: json, description: "ok" } } },
		},
		"/v1/users/{user_id}": {
			get: {
				operationId: "user.get",
				parameters: [{ in: "path", name: "user_id", required: true, schema: { type: "string" } }],
				responses: { "200": { content: json, description: "ok" } },
			},
		},
		"/v1/ceremony/options": {
			post: { operationId: "ceremony.options", responses: { "200": { content: json, description: "ok" } } },
		},
		"/v1/ceremony/verify": {
			post: {
				operationId: "ceremony.verify",
				requestBody: { content: { "application/json": { schema: { type: "object" } } } },
				responses: { "200": { content: json, description: "ok" } },
			},
		},
		"/v1/checkout/confirm": {
			post: {
				operationId: "checkout.confirm",
				requestBody: { content: { "application/json": { schema: { type: "object" } } } },
				responses: { "200": { content: json, description: "ok" } },
			},
		},
	}
}

function spec(): OpenApiDocument {
	return {
		components: { securitySchemes: { bearer: { scheme: "bearer", type: "http" } } },
		info: { title: "scenario", version: "1" },
		openapi: "3.1.0",
		paths: { ...notePaths(), ...flowPaths() },
		security: [{ bearer: [] }],
	} as unknown as OpenApiDocument
}

export interface Api {
	close: () => Promise<void>
	url: string
	/** Writes to stats become visible this long after they happen. */
	statsLagMs: number
}

interface Store {
	brokenRename: boolean
	notes: Map<string, { id: string; text: string }>
	statWrites: Array<{ at: number; text: string }>
	statsLagMs: number
}

interface Exchange {
	authorization: unknown
	body: Record<string, unknown>
	method: string
	path: string
	raw: string
	send: (status: number, value: unknown) => void
	type: string
}

interface Route {
	handle: (store: Store, exchange: Exchange, params: string[]) => void
	/** `*` answers any method. */
	method: string
	path: RegExp | string
}

function writeNote(store: Store, exchange: Exchange): void {
	const note = { id: `n${store.notes.size + 1}`, text: String(exchange.body["text"]) }
	store.notes.set(note.id, note)
	store.statWrites.push({ at: Date.now(), text: note.text })
	exchange.send(201, note)
}

function renameNote(store: Store, exchange: Exchange, params: string[]): void {
	const note = store.notes.get(params[0] ?? "")
	if (note === undefined) return exchange.send(404, { error: "not_found" })
	if (!store.brokenRename) note.text = String(exchange.body["text"])
	exchange.send(200, note)
}

function readStats(store: Store, exchange: Exchange): void {
	const visible = store.statWrites.filter((write) => Date.now() - write.at >= store.statsLagMs)
	exchange.send(200, { texts: visible.map((write) => write.text) })
}

function mintToken(_store: Store, exchange: Exchange): void {
	const claims = Buffer.from(JSON.stringify({ sub: "usr_42" })).toString("base64url")
	exchange.send(200, { token: `h.${claims}.s` })
}

function verifyCeremony(_store: Store, exchange: Exchange): void {
	const credential = exchange.body["credential"] as { signed?: unknown } | undefined
	exchange.send(200, { verified: credential?.signed === "ch_1" })
}

const ROUTES: readonly Route[] = [
	{ handle: writeNote, method: "POST", path: "/v1/notes" },
	{
		handle: (store, exchange) => exchange.send(200, { items: [...store.notes.values()] }),
		method: "GET",
		path: "/v1/notes",
	},
	{ handle: renameNote, method: "PATCH", path: /^\/v1\/notes\/([^/]+)$/ },
	{ handle: readStats, method: "*", path: "/v1/stats" },
	{
		handle: (_store, exchange) => exchange.send(200, { url: "https://pay.example/session/cs_1" }),
		method: "POST",
		path: "/v1/checkout",
	},
	{
		handle: (_store, exchange) => exchange.send(200, { type: exchange.type, body: exchange.raw }),
		method: "POST",
		path: "/v1/forms",
	},
	{ handle: mintToken, method: "POST", path: "/v1/token" },
	{ handle: (_store, exchange) => exchange.send(200, { id: "usr_42" }), method: "GET", path: "/v1/users/usr_42" },
	{
		handle: (_store, exchange) => exchange.send(200, { options: { challenge: "ch_1", rp: { id: "example.test" } } }),
		method: "POST",
		path: "/v1/ceremony/options",
	},
	{ handle: verifyCeremony, method: "POST", path: "/v1/ceremony/verify" },
	{
		handle: (_store, exchange) => exchange.send(200, { confirmed: exchange.body["session"] === "cs_1-paid" }),
		method: "POST",
		path: "/v1/checkout/confirm",
	},
]

/** The captured path parameters when `route` answers `exchange`, else undefined. */
function matchRoute(route: Route, exchange: Exchange): string[] | undefined {
	if (route.method !== "*" && route.method !== exchange.method) return undefined
	if (typeof route.path === "string") return route.path === exchange.path ? [] : undefined
	return route.path.exec(exchange.path)?.slice(1)
}

async function readExchange(req: IncomingMessage, res: ServerResponse): Promise<Exchange> {
	const url = new URL(req.url ?? "/", "http://127.0.0.1")
	let raw = ""
	for await (const chunk of req) raw += chunk
	const type = String(req.headers["content-type"] ?? "")
	const body = raw === "" || !type.includes("json") ? {} : (JSON.parse(raw) as Record<string, unknown>)
	const send = (status: number, value: unknown) => {
		res.writeHead(status, { "content-type": "application/json" })
		res.end(JSON.stringify(value))
	}
	const method = (req.method ?? "GET").toUpperCase()
	return { authorization: req.headers.authorization, body, method, path: url.pathname, raw, send, type }
}

function respond(store: Store, document: OpenApiDocument, exchange: Exchange): void {
	if (exchange.path === "/openapi.json") return exchange.send(200, document)
	if (exchange.authorization !== "Bearer alpha") return exchange.send(401, { error: "unauthorized" })
	const writes = exchange.method === "POST" || exchange.method === "PATCH"
	if (writes && exchange.path.startsWith("/v1/notes") && typeof exchange.body["text"] !== "string") {
		return exchange.send(400, { error: "text_required" })
	}
	for (const route of ROUTES) {
		const params = matchRoute(route, exchange)
		if (params !== undefined) return route.handle(store, exchange, params)
	}
	exchange.send(404, { error: "not_found" })
}

/** Starts the notes API on a free local port; `close` stops it. */
export async function serveNotes(options: { brokenRename?: boolean; statsLagMs?: number } = {}): Promise<Api> {
	const store: Store = {
		brokenRename: options.brokenRename === true,
		notes: new Map(),
		statWrites: [],
		statsLagMs: options.statsLagMs ?? 0,
	}
	const document = spec()
	const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
		respond(store, document, await readExchange(req, res))
	})
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
	const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
	const close = () => new Promise<void>((resolve) => server.close(() => resolve()))
	return { close, statsLagMs: store.statsLagMs, url }
}
