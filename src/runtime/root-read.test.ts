import { describe, expect, it } from "vitest"
import type { EntityModel } from "../spec/graph/types.ts"
import type { OpenApiDocument } from "../spec/types.ts"
import { fakeClient, modelOf, type Responder } from "./checks/__fixtures__/harness.ts"
import { FindingCollector } from "./finding.ts"
import { ROOT_READ_CHECK_ID, rootReadCheck, rootReadIds, runRootRead } from "./root-read.ts"

const projectId = { in: "path", name: "project_id", required: true, schema: { type: "string" } }
const ok = { "200": { description: "ok" }, "401": { description: "no token" } }

function rootRead(operationId: string, query: string[] = []) {
	return {
		get: {
			operationId,
			parameters: [projectId, ...query.map((name) => ({ in: "query", name, schema: { type: "string" } }))],
			responses: ok,
			"x-entity": { action: "read", identity: "root", name: "overview" },
		},
	}
}

const model = modelOf({
	info: { title: "t", version: "1" },
	openapi: "3.1.0",
	paths: {
		"/projects/{project_id}/overview": rootRead("project.overview"),
		"/projects/{project_id}/usage": rootRead("project.usage", ["from", "to"]),
		"/projects/{project_id}/since": rootRead("project.since", ["from"]),
	},
} as unknown as OpenApiDocument)

const overview = model.entities.get("overview") as EntityModel

/** Refuses an anonymous read with 401, and answers an authenticated one with 200. */
const honest: Responder = (_method, _path, options) => {
	const headers = typeof options.headers === "function" ? options.headers() : (options.headers ?? {})
	return { status: headers.authorization === undefined ? 401 : 200 }
}

async function judge(
	entity: EntityModel,
	respond: Responder = honest,
	roots: Record<string, string> = { project_id: "p1" },
) {
	const { client, sent } = fakeClient(respond)
	const findings = new FindingCollector()
	const outcome = await runRootRead({
		auth: () => ({ authorization: "Bearer a" }),
		client,
		entity,
		findings,
		model,
		roots,
	})
	return { findings, outcome, sent }
}

describe("rootReadIds", () => {
	it("are the reads of an entity identified by the caller's root, and none otherwise", () => {
		expect(rootReadIds(overview)).toEqual(overview.reads)
		expect(rootReadIds({ ...overview, reads: [] })).toEqual([overview.read])
		const { read: _, ...unread } = overview
		expect(rootReadIds({ ...unread, reads: [] })).toEqual([])
		expect(rootReadIds({ ...overview, identity: "id" } as EntityModel)).toEqual([])
	})
})

describe("runRootRead", () => {
	it("asserts a read refused without a token and served with one, asking a week of dates where both bounds exist", async () => {
		const entity = { ...overview, reads: ["project.overview", "project.usage", "project.since", "ghost.read"] }
		const { findings, outcome, sent } = await judge(entity)
		expect(outcome).toEqual({ kind: "asserted" })
		expect(findings.findings).toEqual([])
		expect(sent.map((s) => [s.path, s.options.skipAuthRefresh])).toEqual([
			["/projects/p1/overview", true],
			["/projects/p1/overview", undefined],
			["/projects/p1/usage", true],
			["/projects/p1/usage", undefined],
			["/projects/p1/since", true],
			["/projects/p1/since", undefined],
		])
		const query = sent[2]?.options.query as { from: string; to: string }
		expect(Date.parse(query.to) - Date.parse(query.from)).toBe(7 * 24 * 60 * 60 * 1000)
		expect(sent[4]?.options.query).toBeUndefined()
	})

	it("is a security finding when the read answers without a token", async () => {
		const { findings, outcome } = await judge(overview, () => ({ status: 200 }))
		expect(outcome).toEqual({ kind: "finding", verdict: "SECURITY" })
		expect(findings.findings[0]).toMatchObject({
			check: ROOT_READ_CHECK_ID,
			detail: "project.overview returned 200 with no credential.",
			operations: overview.reads,
		})
	})

	it("is a backend finding when the authenticated read fails", async () => {
		const { findings, outcome } = await judge(overview, (method, path, options) =>
			honest(method, path, options)?.status === 401 ? { status: 401 } : { status: 500 },
		)
		expect(outcome).toEqual({ kind: "finding", verdict: "BACKEND_BUG" })
		expect(findings.findings[0]?.detail).toBe("project.overview returned 500 for /projects/p1/overview.")
	})

	it("cannot reach a verdict without the caller's root", async () => {
		const { findings, outcome } = await judge(overview, honest, {})
		expect(outcome).toEqual({ kind: "unresolved", reason: "project.overview needs a path id" })
		expect(findings.inconclusive).toHaveLength(1)
	})
})

describe("rootReadCheck", () => {
	it("keeps the id registered, and plans and runs nothing itself", async () => {
		expect(rootReadCheck.plan(undefined as never)).toEqual({ ok: false })
		expect(await rootReadCheck.run(undefined as never, undefined as never)).toEqual({ kind: "asserted" })
		expect(rootReadCheck.subjects(overview, model)).toEqual([])
	})
})
