import { describe, expect, it } from "vitest"
import { json, transport } from "../client/__fixtures__/transport.ts"
import { Client } from "../client/client.ts"
import { Redactor } from "../security/redact.ts"
import { buildModel } from "../spec/graph/build.ts"
import { dereference } from "../spec/load/dereference.ts"
import type { OpenApiDocument } from "../spec/types.ts"
import { FindingCollector } from "./finding.ts"
import { GradeLedger } from "./grades.ts"
import { documentsSuccess, isPublicGet, PUBLIC_GET_CHECK_ID, publicGetCheck, runPublicGets } from "./one-shot.ts"

const ok = (code = "200") => ({ [code]: { description: "ok" } })
const get = (operationId: string, more: Record<string, unknown> = {}) => ({
	get: { operationId, responses: ok(), ...more },
})

const DOCUMENT = {
	components: { securitySchemes: { bearer: { scheme: "bearer", type: "http" } } },
	info: { title: "one-shot", version: "1" },
	openapi: "3.1.0",
	paths: {
		"/body": get("body.get", {
			requestBody: { content: { "application/json": { schema: { type: "object" } } } },
		}),
		"/broken": get("broken.get"),
		"/health": get("health.get"),
		"/hook": { post: { operationId: "hook.post", responses: ok() } },
		"/items": get("item.list", { "x-entity": { action: "list", name: "item" } }),
		"/moved": get("moved.get"),
		"/ping": { head: { operationId: "ping.head", responses: ok("2XX") } },
		/* A parameter mid-segment names no entity, so only the path rule keeps it out. */
		"/download/{token}.zip": get("download.get", {
			parameters: [{ in: "path", name: "token", required: true, schema: { type: "string" } }],
		}),
		"/search": get("search.get", { parameters: [{ in: "query", name: "q", schema: { type: "string" } }] }),
		"/secure": get("secure.get", { security: [{ bearer: [] }] }),
		"/teapot": get("teapot.get", { responses: ok("418") }),
	},
} as unknown as OpenApiDocument

const ANSWERS: Record<string, number> = { "/broken": 404, "/moved": 202 }

function setup() {
	const model = buildModel(dereference(DOCUMENT).doc)
	const wire = transport((sent) => json({}, ANSWERS[new URL(sent.url).pathname] ?? 200))
	const client = new Client({
		baseUrl: "http://api.test",
		network: { fetchImpl: wire.fetch },
		redactor: new Redactor(),
	})
	const findings = new FindingCollector()
	const grades = new GradeLedger()
	const checksRun = new Set<string>()
	return { checksRun, client, findings, grades, model, sent: wire.sent }
}

describe("a public read", () => {
	it("is a GET or HEAD with no entity, id, query, body, or security, that documents a success", () => {
		const { model } = setup()
		const publicReads = model.operations.filter((op) => isPublicGet(op) && documentsSuccess(op))
		expect(publicReads.map((op) => op.operationId).sort()).toEqual([
			"broken.get",
			"health.get",
			"moved.get",
			"ping.head",
		])
	})

	it("must answer the success it documents, to a request with no token", async () => {
		const { checksRun, client, findings, grades, model, sent } = setup()
		await runPublicGets({ checksRun, client, findings, grades, inScope: () => false, mode: "full", model })
		expect(sent.map((request) => `${request.method} ${new URL(request.url).pathname}`).sort()).toEqual([
			"GET /broken",
			"GET /health",
			"GET /moved",
			"HEAD /ping",
		])
		expect([...checksRun]).toEqual([PUBLIC_GET_CHECK_ID])
		expect(grades.ran.get("ping.head")).toEqual(new Set([PUBLIC_GET_CHECK_ID]))
		expect(findings.findings.map((f) => [f.entity, f.detail])).toEqual([
			["broken.get", "broken.get returned 404. The document says 200 for a request with no token and no id."],
			["moved.get", "moved.get returned 202. The document says 200 for a request with no token and no id."],
		])
	})

	it("is asked only when in scope of a targeted run, and not at all when none is", async () => {
		const targeted = setup()
		await runPublicGets({ ...targeted, inScope: (id) => id === "health.get", mode: "targeted" })
		expect(targeted.sent.map((request) => request.url)).toEqual(["http://api.test/health"])
		const none = setup()
		await runPublicGets({ ...none, inScope: () => false, mode: "targeted" })
		expect(none.sent).toEqual([])
		expect(none.checksRun.size).toBe(0)
	})
})

describe("publicGetCheck", () => {
	it("plans nothing and runs nothing in the entity loop: runPublicGets grades these routes", async () => {
		expect(publicGetCheck.plan({} as never)).toEqual({ ok: false })
		expect(publicGetCheck.subjects({} as never, {} as never)).toEqual([])
		await expect(publicGetCheck.run({} as never, undefined as never)).resolves.toEqual({ kind: "asserted" })
	})
})
