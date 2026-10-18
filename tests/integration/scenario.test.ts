import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { afterEach, describe, expect, it } from "vitest"
import type { Scenario } from "../../src/config/define-config.ts"
import type { OpenApiDocument } from "../../src/spec/types.ts"
import { run } from "../../src/runtime/run/index.ts"

let open: Array<{ close: () => Promise<void> }> = []
afterEach(async () => {
	for (const server of open) await server.close()
	open = []
})

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

function spec(): OpenApiDocument {
	return {
		components: { securitySchemes: { bearer: { scheme: "bearer", type: "http" } } },
		info: { title: "scenario", version: "1" },
		openapi: "3.1.0",
		paths: {
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
		},
		security: [{ bearer: [] }],
	} as unknown as OpenApiDocument
}

interface Api {
	url: string
	/** Writes to stats become visible this long after they happen. */
	statsLagMs: number
}

async function serve(options: { brokenRename?: boolean; statsLagMs?: number } = {}): Promise<Api> {
	const notes = new Map<string, { id: string; text: string }>()
	const statWrites: Array<{ at: number; text: string }> = []
	const statsLagMs = options.statsLagMs ?? 0
	const document = spec()
	const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
		const url = new URL(req.url ?? "/", "http://127.0.0.1")
		const method = (req.method ?? "GET").toUpperCase()
		let raw = ""
		for await (const chunk of req) raw += chunk
		const isJson = String(req.headers["content-type"] ?? "").includes("json")
		const body = raw === "" || !isJson ? {} : (JSON.parse(raw) as Record<string, unknown>)
		const send = (status: number, value: unknown) => {
			res.writeHead(status, { "content-type": "application/json" })
			res.end(JSON.stringify(value))
		}
		if (url.pathname === "/openapi.json") return send(200, document)
		if (req.headers.authorization !== "Bearer alpha") return send(401, { error: "unauthorized" })
		const invalid = (method === "POST" || method === "PATCH") && url.pathname.startsWith("/v1/notes")
		if (invalid && typeof body["text"] !== "string") return send(400, { error: "text_required" })
		if (url.pathname === "/v1/notes" && method === "POST") {
			const note = { id: `n${notes.size + 1}`, text: String(body["text"]) }
			notes.set(note.id, note)
			statWrites.push({ at: Date.now(), text: note.text })
			return send(201, note)
		}
		if (url.pathname === "/v1/notes" && method === "GET") return send(200, { items: [...notes.values()] })
		const item = /^\/v1\/notes\/([^/]+)$/.exec(url.pathname)
		if (item !== null && method === "PATCH") {
			const note = notes.get(item[1] ?? "")
			if (note === undefined) return send(404, { error: "not_found" })
			if (options.brokenRename !== true) note.text = String(body["text"])
			return send(200, note)
		}
		if (url.pathname === "/v1/stats") {
			const visible = statWrites.filter((write) => Date.now() - write.at >= statsLagMs)
			return send(200, { texts: visible.map((write) => write.text) })
		}
		if (url.pathname === "/v1/checkout" && method === "POST") {
			return send(200, { url: "https://pay.example/session/cs_1" })
		}
		if (url.pathname === "/v1/forms" && method === "POST") {
			return send(200, { type: req.headers["content-type"] ?? "", body: raw })
		}
		if (url.pathname === "/v1/token" && method === "POST") {
			const claims = Buffer.from(JSON.stringify({ sub: "usr_42" })).toString("base64url")
			return send(200, { token: `h.${claims}.s` })
		}
		if (url.pathname === "/v1/users/usr_42" && method === "GET") return send(200, { id: "usr_42" })
		if (url.pathname === "/v1/ceremony/options" && method === "POST") {
			return send(200, { options: { challenge: "ch_1", rp: { id: "example.test" } } })
		}
		if (url.pathname === "/v1/ceremony/verify" && method === "POST") {
			const credential = body["credential"] as { signed?: unknown } | undefined
			return send(200, { verified: credential?.signed === "ch_1" })
		}
		if (url.pathname === "/v1/checkout/confirm" && method === "POST") {
			return send(200, { confirmed: body["session"] === "cs_1-paid" })
		}
		send(404, { error: "not_found" })
	})
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
	const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
	open.push({ close: () => new Promise<void>((resolve) => server.close(() => resolve())) })
	return { statsLagMs, url }
}

const RENAME: Scenario = {
	covers: ["notes.write", "notes.rename"],
	id: "notes",
	steps: [
		{ body: { text: "first" }, operationId: "notes.write", saveAs: { id: "$.id" } },
		{
			assert: { contains: "first", from: "$.items[*].text", observes: ["notes.write"] },
			operationId: "notes.list",
		},
		{ bind: { id: "{id}" }, body: { text: "second" }, operationId: "notes.rename" },
		{
			assert: { contains: "second", from: "$.items[*].text", observes: ["notes.rename"] },
			operationId: "notes.list",
		},
	],
}

async function runWith(api: Api, scenarios: Scenario[], ops: string[], hooks = {}) {
	return run({
		baseUrl: api.url,
		hooks,
		ops,
		principals: [{ headers: { authorization: "Bearer alpha" }, id: "alpha" }],
		scenarios,
		seed: 1,
		spec: `${api.url}/openapi.json`,
	})
}

function row(result: Awaited<ReturnType<typeof runWith>>, operationId: string) {
	return result.scope.operations.find((op) => op.operationId === operationId)
}

describe("scenarios", () => {
	it("grades each covered operation verified when a later read shows its value", async () => {
		const api = await serve()
		const result = await runWith(api, [RENAME], ["notes.write", "notes.rename"])
		for (const id of ["notes.write", "notes.rename"]) {
			const graded = row(result, id)
			expect(graded?.status).toBe("passed")
			expect(graded?.tier).toBe("verified")
			const call = result.client.transcript.find((exchange) => exchange.seq === graded?.evidence?.call)
			const seen = result.client.transcript.find((exchange) => exchange.seq === graded?.evidence?.observation?.seq)
			expect(call?.operationId).toBe(id)
			expect(seen?.operationId).toBe("notes.list")
			expect(seen?.seq).toBeGreaterThan(call?.seq ?? Number.POSITIVE_INFINITY)
		}
		expect(row(result, "notes.rename")?.evidence?.observation).toMatchObject({
			path: "$.items[*].text",
			value: "second",
		})
	})

	it("fails the operation whose read does not show it and blocks what the scenario never reached", async () => {
		const api = await serve({ brokenRename: true })
		const extended: Scenario = {
			...RENAME,
			covers: [...RENAME.covers, "stats.get"],
			steps: [...RENAME.steps, { assert: { contains: "first", from: "$.texts[*]" }, operationId: "stats.get" }],
		}
		const result = await runWith(api, [extended], ["notes.write", "notes.rename", "stats.get"])
		expect(row(result, "notes.write")?.status).toBe("passed")
		expect(row(result, "notes.rename")?.status).toBe("failed")
		expect(row(result, "stats.get")?.status).toBe("blocked")
		expect(row(result, "stats.get")?.reason).toContain('scenario "notes" stopped at step 4')
		const finding = result.findings.find((f) => f.operations?.includes("notes.rename"))
		expect(finding?.check).toBe("scenario.notes")
		expect(finding?.evidence.map((exchange) => exchange.operationId)).toContain("notes.list")
	})

	it("polls an eventually consistent read until it shows the call's value", async () => {
		const api = await serve({ statsLagMs: 400 })
		const scenario: Scenario = {
			covers: ["notes.write", "stats.get"],
			id: "lagging",
			steps: [
				{ body: { text: "lagging-write" }, operationId: "notes.write" },
				{
					assert: { equals: "lagging-write", from: "$.texts[*]", observes: ["notes.write"] },
					operationId: "stats.get",
					poll: { within: "3s" },
				},
			],
		}
		const result = await runWith(api, [scenario], ["notes.write", "stats.get"])
		expect(row(result, "stats.get")?.status).toBe("passed")
		expect(row(result, "notes.write")?.tier).toBe("verified")
	})

	it("fails a lagging read without poll", async () => {
		const api = await serve({ statsLagMs: 2_000 })
		const scenario: Scenario = {
			covers: ["notes.write", "stats.get"],
			id: "impatient",
			steps: [
				{ body: { text: "impatient-write" }, operationId: "notes.write" },
				{
					assert: { equals: "impatient-write", from: "$.texts[*]", observes: ["notes.write"] },
					operationId: "stats.get",
				},
			],
		}
		const result = await runWith(api, [scenario], ["notes.write", "stats.get"])
		expect(row(result, "stats.get")?.status).toBe("failed")
	})

	it("hands a browser step to the external hook and feeds its answer forward", async () => {
		const api = await serve()
		const seen: Array<{ input: unknown; name: string }> = []
		const scenario: Scenario = {
			covers: ["checkout.open", "checkout.confirm"],
			id: "pay",
			steps: [
				{ operationId: "checkout.open", saveAs: { checkoutUrl: "$.url" } },
				{ as: "session", external: "pay-with-test-card", input: { url: "{checkoutUrl}" } },
				{
					assert: { equals: "true", from: "$.confirmed", observes: ["checkout.open"] },
					body: { session: "{session}" },
					operationId: "checkout.confirm",
				},
			],
		}
		const external = async (name: string, input: Record<string, unknown>) => {
			seen.push({ input, name })
			return "cs_1-paid"
		}
		const result = await runWith(api, [scenario], ["checkout.open", "checkout.confirm"], { external })
		expect(seen).toEqual([{ input: { url: "https://pay.example/session/cs_1" }, name: "pay-with-test-card" }])
		expect(row(result, "checkout.open")?.tier).toBe("verified")
		expect(row(result, "checkout.confirm")?.status).toBe("passed")
	})

	it("keeps an object a response or a hook returns, and sends it whole where a body names it", async () => {
		const api = await serve()
		const seen: unknown[] = []
		const scenario: Scenario = {
			covers: ["ceremony.options", "ceremony.verify"],
			id: "ceremony",
			steps: [
				{ operationId: "ceremony.options", saveAs: { options: "$.options" } },
				{ as: "credential", external: "sign", input: { options: "{options}" } },
				{
					assert: { equals: "true", from: "$.verified", observes: ["ceremony.options"] },
					body: { credential: "{credential}" },
					operationId: "ceremony.verify",
				},
			],
		}
		const external = async (_name: string, input: Record<string, unknown>) => {
			seen.push(input)
			const options = input["options"] as { challenge: string }
			return JSON.stringify({ signed: options.challenge })
		}
		const result = await runWith(api, [scenario], ["ceremony.options", "ceremony.verify"], { external })
		expect(seen).toEqual([{ options: { challenge: "ch_1", rp: { id: "example.test" } } }])
		expect(row(result, "ceremony.verify")?.status).toBe("passed")
		const sent = result.client.transcript.find((exchange) => exchange.operationId === "ceremony.verify")
		expect(sent?.requestBody).toEqual({ credential: { signed: "ch_1" } })
	})

	it("proves a removal by a later read that no longer holds the value", async () => {
		const api = await serve()
		const scenario: Scenario = {
			covers: ["notes.write", "stats.get"],
			id: "gone",
			steps: [
				{ body: { text: "keep-me" }, operationId: "notes.write" },
				{
					assert: { excludes: "never-written", from: "$.texts[*]", observes: ["notes.write"] },
					operationId: "stats.get",
				},
			],
		}
		const result = await runWith(api, [scenario], ["notes.write", "stats.get"])
		expect(row(result, "notes.write")?.tier).toBe("verified")
		expect(row(result, "notes.write")?.evidence?.observation).toMatchObject({ absent: true, value: "never-written" })
		const failing: Scenario = {
			...scenario,
			id: "still-there",
			steps: [
				scenario.steps[0] as Scenario["steps"][number],
				{ assert: { excludes: "keep-me", from: "$.texts[*]", observes: ["notes.write"] }, operationId: "stats.get" },
			],
		}
		const refused = await runWith(await serve(), [failing], ["notes.write", "stats.get"])
		expect(row(refused, "notes.write")?.status).toBe("failed")
	})

	it("binds values out of a token's claims, as an auth flow does", async () => {
		const api = await serve()
		const scenario: Scenario = {
			covers: ["token.mint", "user.get"],
			id: "claims",
			steps: [
				{
					operationId: "token.mint",
					saveAs: { token: "$.token" },
					saveClaimsFrom: { bind: { userId: "sub" }, token: "token" },
				},
				{
					assert: { equals: "usr_42", from: "$.id", observes: ["token.mint"] },
					bind: { user_id: "{userId}" },
					operationId: "user.get",
				},
			],
		}
		const result = await runWith(api, [scenario], ["token.mint", "user.get"])
		expect(row(result, "user.get")?.status).toBe("passed")
		expect(row(result, "token.mint")?.tier).toBe("verified")
	})

	it("keeps each observation with the call it saw, when an operation is called again", async () => {
		const api = await serve()
		const scenario: Scenario = {
			covers: ["notes.write"],
			id: "twice",
			steps: [
				{ body: { text: "once" }, operationId: "notes.write" },
				{ assert: { contains: "once", from: "$.items[*].text", observes: ["notes.write"] }, operationId: "notes.list" },
				{ body: { text: "twice" }, operationId: "notes.write" },
			],
		}
		const result = await runWith(api, [scenario], ["notes.write"])
		const evidence = row(result, "notes.write")?.evidence
		const call = result.client.transcript.find((exchange) => exchange.seq === evidence?.call)
		expect(call?.requestBody).toEqual({ text: "once" })
		expect(evidence?.observation?.seq).toBeGreaterThan(evidence?.call ?? Number.POSITIVE_INFINITY)
	})

	it("does not let a write's own response prove that write", async () => {
		const api = await serve()
		const scenario: Scenario = {
			covers: ["checkout.open"],
			id: "self-proof",
			steps: [{ assert: { contains: "cs_1", from: "$.url" }, operationId: "checkout.open" }],
		}
		const result = await runWith(api, [scenario], ["checkout.open"])
		expect(row(result, "checkout.open")?.status).toBe("passed")
		expect(row(result, "checkout.open")?.tier).toBe("contract")
	})

	it("starts each scenario with its principal's roots, and lets a step speak as another principal", async () => {
		const api = await serve()
		const scenario: Scenario = {
			covers: ["user.get"],
			id: "roots",
			steps: [
				{ expect: [401], operationId: "notes.list", principal: "nobody" },
				{ assert: { equals: "usr_42", from: "$.id" }, bind: { user_id: "{owner_id}" }, operationId: "user.get" },
			],
		}
		const result = await run({
			baseUrl: api.url,
			ops: ["user.get"],
			principals: [
				{ headers: { authorization: "Bearer alpha" }, id: "alpha", roots: { owner_id: "usr_42" } },
				{ headers: { authorization: "Bearer nobody" }, id: "nobody" },
			],
			scenarios: [scenario],
			seed: 1,
			spec: `${api.url}/openapi.json`,
		})
		expect(row(result, "user.get")?.status).toBe("passed")
		const refused = result.client.transcript.find(
			(exchange) => exchange.operationId === "notes.list" && exchange.status === 401,
		)
		expect(refused?.requestHeaders.authorization).toBe("Bearer nobody")
	})

	it("sends the request media type a step names, among those the operation documents", async () => {
		const api = await serve()
		const scenario: Scenario = {
			covers: ["form.send"],
			id: "form",
			steps: [
				{
					assert: { contains: "application/x-www-form-urlencoded", from: "$.type" },
					body: { text: "plain words" },
					mediaType: "application/x-www-form-urlencoded",
					operationId: "form.send",
				},
			],
		}
		const result = await runWith(api, [scenario], ["form.send"])
		expect(row(result, "form.send")?.status).toBe("passed")
		const sent = result.client.transcript.find((exchange) => exchange.operationId === "form.send")
		expect(JSON.stringify(sent?.requestBody)).toContain("plain words")
	})

	it("refuses a scenario that covers an operation it never calls", async () => {
		const api = await serve()
		const scenario: Scenario = { ...RENAME, covers: [...RENAME.covers, "stats.get"] }
		await expect(runWith(api, [scenario], ["notes.write"])).rejects.toThrow(
			'scenario "notes" covers stats.get but no step calls it',
		)
	})
})
