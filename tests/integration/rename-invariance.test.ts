import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { afterEach, describe, expect, it } from "vitest"
import type { OpenApiDocument } from "../../src/spec/types.ts"
import { run } from "../../src/runtime/run/index.ts"
import { jsonBody } from "../support/json-body.ts"

/*
 * oat grades what the document declares, never what a route happens to be called. The same API
 * served twice — once with familiar names, once with every path segment and operationId
 * renamed — must earn the same grade for every operation. A word-matching shortcut anywhere in
 * the runtime (`logout`, `register`, `me`, `passkey`) breaks this.
 */

let open: Array<{ close: () => Promise<void> }> = []
afterEach(async () => {
	for (const server of open) await server.close()
	open = []
})

/** What each operation does, whatever the document calls it. */
type Role = "create" | "delete" | "get" | "list" | "logout" | "me" | "register" | "version"

interface Names {
	session: string
	signUp: string
	self: string
	notes: string
	version: string
	ops: Record<Role, string>
}

const FAMILIAR: Names = {
	notes: "notes",
	ops: {
		create: "notes.create",
		delete: "notes.delete",
		get: "notes.get",
		list: "notes.list",
		logout: "auth.logout",
		me: "auth.me",
		register: "auth.register",
		version: "meta.version",
	},
	self: "me",
	session: "logout",
	signUp: "register",
	version: "version",
}

const RENAMED: Names = {
	notes: "quills",
	ops: {
		create: "quill.inscribe",
		delete: "quill.erase",
		get: "quill.fetch",
		list: "quill.survey",
		logout: "door.close",
		me: "mirror.look",
		register: "door.open",
		version: "almanac.edition",
	},
	self: "mirror",
	session: "farewell",
	signUp: "hello",
	version: "edition",
}

const noteSchema = {
	properties: { id: { type: "string" }, text: { type: "string" } },
	required: ["id", "text"],
	type: "object",
}

const json = (schema: unknown) => ({ "application/json": { schema } })

function ok(schema: unknown, code = "200"): Record<string, unknown> {
	return {
		[code]: { content: json(schema), description: "ok" },
		"401": { description: "unauthorized" },
		"404": { description: "missing" },
	}
}

const textBody = {
	content: json({ properties: { text: { type: "string" } }, required: ["text"], type: "object" }),
	required: true,
}
const idParam = [{ in: "path", name: "note_id", required: true, schema: { type: "string" } }]

function notePaths(names: Names): Record<string, unknown> {
	return {
		[`/v1/${names.notes}`]: {
			get: {
				operationId: names.ops.list,
				responses: ok({
					properties: { items: { items: noteSchema, type: "array" } },
					required: ["items"],
					type: "object",
				}),
			},
			post: { operationId: names.ops.create, requestBody: textBody, responses: ok(noteSchema, "201") },
		},
		[`/v1/${names.notes}/{note_id}`]: {
			delete: {
				operationId: names.ops.delete,
				parameters: idParam,
				responses: {
					"204": { description: "gone" },
					"401": { description: "unauthorized" },
					"404": { description: "missing" },
				},
			},
			get: { operationId: names.ops.get, parameters: idParam, responses: ok(noteSchema) },
		},
	}
}

function accountPaths(names: Names): Record<string, unknown> {
	return {
		[`/v1/${names.self}`]: {
			get: {
				operationId: names.ops.me,
				responses: ok({ properties: { email: { type: "string" } }, required: ["email"], type: "object" }),
				"x-entity": { action: "read", identity: "self", name: "caller" },
			},
		},
		[`/v1/${names.session}`]: {
			post: {
				operationId: names.ops.logout,
				responses: ok({ properties: { ok: { type: "boolean" } }, required: ["ok"], type: "object" }),
				"x-destructive": true,
				"x-invalidate": [`GET /v1/${names.self}`],
			},
		},
		[`/v1/${names.signUp}`]: {
			post: {
				operationId: names.ops.register,
				requestBody: {
					content: json({
						properties: { email: { format: "email", type: "string" } },
						required: ["email"],
						type: "object",
					}),
					required: true,
				},
				responses: ok(
					{ properties: { access_token: { type: "string" } }, required: ["access_token"], type: "object" },
					"201",
				),
				security: [],
				"x-fresh-principal": true,
			},
		},
		[`/v1/${names.version}`]: {
			get: {
				operationId: names.ops.version,
				responses: ok({ properties: { version: { type: "string" } }, required: ["version"], type: "object" }),
			},
		},
	}
}

function document(names: Names): OpenApiDocument {
	return {
		components: { securitySchemes: { bearer: { scheme: "bearer", type: "http" } } },
		info: { title: "invariance", version: "1" },
		openapi: "3.1.0",
		paths: { ...notePaths(names), ...accountPaths(names) },
		security: [{ bearer: [] }],
	} as unknown as OpenApiDocument
}

type Note = { id: string; text: string }
type World = { created: number; names: Names; notes: Map<string, Note>; tokens: Set<string> }
type Exchange = {
	body: Record<string, unknown>
	method: string
	pathname: string
	send: (status: number, value?: unknown) => void
	token: string
}

function signUp(world: World, { body, send }: Exchange): void {
	if (typeof body["email"] !== "string") return send(400, { error: "email" })
	const token = `t${world.tokens.size}`
	world.tokens.add(token)
	send(201, { access_token: token })
}

function noteCollection(world: World, { body, method, send }: Exchange): void {
	if (method === "GET") return send(200, { items: [...world.notes.values()] })
	if (typeof body["text"] !== "string") return send(400, { error: "text" })
	world.created += 1
	const note = { id: `n${world.created}`, text: body["text"] }
	world.notes.set(note.id, note)
	send(201, note)
}

function noteItem(world: World, id: string, { method, send }: Exchange): void {
	const note = world.notes.get(id)
	if (note === undefined) return send(404, { error: "missing" })
	if (method === "GET") return send(200, note)
	if (method !== "DELETE") return send(404, { error: "missing" })
	world.notes.delete(note.id)
	send(204)
}

/* Everything past sign-up needs a live token; the session end revokes it. */
function authed(world: World, exchange: Exchange): void {
	const { method, pathname, send, token } = exchange
	const { names } = world
	if (!world.tokens.has(token)) return send(401, { error: "unauthorized" })
	if (pathname === `/v1/${names.self}`) return send(200, { email: `${token}@example.test` })
	if (pathname === `/v1/${names.session}` && method === "POST") {
		world.tokens.delete(token)
		return send(200, { ok: true })
	}
	if (pathname === `/v1/${names.version}`) return send(200, { version: "1.0.0" })
	if (pathname === `/v1/${names.notes}`) return noteCollection(world, exchange)
	const item = new RegExp(`^/v1/${names.notes}/([^/]+)$`).exec(pathname)
	if (item !== null) return noteItem(world, item[1] ?? "", exchange)
	send(404, { error: "missing" })
}

async function serve(names: Names): Promise<string> {
	const doc = document(names)
	const world: World = { created: 0, names, notes: new Map(), tokens: new Set(["alpha"]) }
	const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
		const url = new URL(req.url ?? "/", "http://127.0.0.1")
		const method = (req.method ?? "GET").toUpperCase()
		let raw = ""
		for await (const chunk of req) raw += chunk
		const body = jsonBody(raw)
		const send = (status: number, value?: unknown) => {
			res.writeHead(status, { "content-type": "application/json" })
			res.end(value === undefined ? "" : JSON.stringify(value))
		}
		if (url.pathname === "/openapi.json") return send(200, doc)
		/* A body that is not JSON is refused, as any server would. */
		if (body === undefined) return send(400, { error: "malformed json" })
		const token = (req.headers.authorization ?? "").replace(/^Bearer /, "")
		const exchange = { body, method, pathname: url.pathname, send, token }
		if (url.pathname === `/v1/${names.signUp}` && method === "POST") return signUp(world, exchange)
		authed(world, exchange)
	})
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
	open.push({ close: () => new Promise<void>((resolve) => server.close(() => resolve())) })
	return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

async function grades(names: Names): Promise<Record<string, string>> {
	const url = await serve(names)
	const result = await run({
		baseUrl: url,
		principals: { alpha: { security: { bearer: { static: "alpha" } } } },
		/* A fresh principal holds what its signup answered; alpha holds a fixed token. */
		security: {
			bearer: {
				login: {
					from: "$.access_token",
					steps: [{ body: { email: "{principal.email}" }, operationId: names.ops.register }],
				},
			},
		},
		seed: 7,
		spec: `${url}/openapi.json`,
	})
	const byRole = Object.fromEntries(Object.entries(names.ops).map(([role, id]) => [id, role]))
	return Object.fromEntries(
		result.scope.operations.map((op) => [byRole[op.operationId] ?? op.operationId, `${op.status}/${op.tier ?? "-"}`]),
	)
}

describe("rename invariance", () => {
	it("grades every operation the same whatever its path and operationId are called", async () => {
		const familiar = await grades(FAMILIAR)
		const renamed = await grades(RENAMED)
		expect(renamed).toEqual(familiar)
		/* Not vacuous: the familiar run graded the session end and the delete. */
		expect(familiar["logout"]).toBe("passed/verified")
		expect(familiar["delete"]).toMatch(/^passed\//)
	})
})
