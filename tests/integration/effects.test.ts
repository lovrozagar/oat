import { afterEach, describe, expect, it } from "vitest"
import { mergeScope } from "../../src/runtime/effects/scope.ts"
import { driveWait } from "../../src/runtime/wait.ts"
import { Client } from "../../src/client/client.ts"
import { readEffects } from "../../src/spec/extensions/effects.ts"
import { GapCollector } from "../../src/spec/extensions/gaps.ts"
import { buildModel } from "../../src/spec/graph/build.ts"
import { Redactor } from "../../src/security/redact.ts"
import {
	createTable,
	deleteTable,
	extract,
	listRows,
	Listeners,
	listTables,
	nestedSpec,
	patchTable,
	readTable,
	reply,
	type Route,
	runTable,
	send,
	serve,
	TableWorld,
} from "../support/effects-fixtures.ts"

const listeners = new Listeners()

afterEach(async () => {
	await listeners.closeAll()
})

describe("readEffects", () => {
	it("copies min, skips non-objects, and rejects count+min", () => {
		expect(readEffects({ responses: {} })).toEqual([])
		expect(
			readEffects({
				responses: {},
				"x-effects": [null, "nope", { entity: "table" }, { entity: "table", op: "create", min: 1 }],
			} as never),
		).toEqual([{ entity: "table", min: 1, op: "create" }])
		const gaps = new GapCollector()
		expect(
			readEffects(
				{
					responses: {},
					"x-effects": [{ count: 1, entity: "row", min: 1, op: "append" }],
				} as never,
				"extract.once",
				gaps,
			),
		).toEqual([])
		expect(gaps.gaps[0]?.tag).toBe("x-effects")
		expect(gaps.gaps[0]?.detail).toMatch(/count and min/)
		expect(
			readEffects({
				responses: {},
				"x-effects": [{ count: Number.NaN, entity: "row", min: Number.POSITIVE_INFINITY, op: "append" }],
			} as never),
		).toEqual([{ entity: "row", op: "append" }])
		const noId = new GapCollector()
		readEffects(
			{ responses: {}, "x-effects": [{ count: 1, entity: "x", min: 2, op: "create" }] } as never,
			undefined,
			noId,
		)
		expect(noId.gaps[0]?.operationId).toBe("")
	})
})

/* The table routes around `extractRoute`; `echo` and `onPoll` as patchTable and listRows take them. */
function extractServer(world: TableWorld, extractRoute: Route, extra: { echo: boolean; onPoll?: () => void }) {
	return [
		listTables(world),
		createTable(world),
		readTable(world),
		listRows(world, extra.onPoll),
		extractRoute,
		deleteTable(world),
		patchTable(world, extra.echo),
	]
}

function extractedTable(id: string) {
	return { id, table_id: id, name: "extracted" }
}

async function runWithRows(rowCount: number) {
	const world = new TableWorld()
	const rows = Array.from({ length: rowCount }, (_, i) => ({ id: `r_${String(i + 1)}` }))
	const routes = extractServer(world, extract(world, rows, extractedTable), { echo: true })
	const server = await serve(listeners, nestedSpec(), routes)
	return runTable(server.url)
}

/* The extract action crashes; every other table route works, and the row list is always empty. */
function crashingExtractRoutes(world: TableWorld): Route[] {
	return [
		({ res, url }) => url.pathname.endsWith("/extract") && reply(res, 500, { error: "upstream unavailable" }),
		listTables(world),
		createTable(world, false),
		readTable(world),
		({ res, url }) => url.pathname.endsWith("/rows") && reply(res, 200, { rows: [] }),
		deleteTable(world),
		patchTable(world),
	]
}

describe("declared effects bind the nested list", () => {
	it("fails when the new table's row list is empty and passes when it has 5", async () => {
		const empty = await runWithRows(0)
		expect(
			empty.findings.some(
				(finding) => finding.check === "effects.declared-effect-occurs" && finding.verdict === "BACKEND_BUG",
			),
		).toBe(true)

		const full = await runWithRows(5)
		expect(full.findings.filter((finding) => finding.check === "effects.declared-effect-occurs")).toEqual([])
	})

	/* The check could not see the effect, so it reports a gap; the 500 itself is still a failure. */
	it("fails an action that answers with a server error, not only leaves its effect unverified", async () => {
		const server = await serve(listeners, nestedSpec(), crashingExtractRoutes(new TableWorld()))
		const result = await runTable(server.url)
		const crashed = result.findings.filter(
			(f) => f.verdict === "BACKEND_BUG" && f.evidence.some((e) => e.url.endsWith("/extract") && e.status === 500),
		)
		expect(crashed.map((f) => f.check)).toContain("response.no-server-error")
		expect(result.scope.operations.find((op) => op.operationId === "extract.once")?.status).toBe("failed")
	})

	it("uses the bound id on x-wait after the write", async () => {
		const spec = nestedSpec()
		const extractOp = spec.paths?.["/v1/projects/{project_id}/extract"]?.post as Record<string, unknown>
		extractOp["x-wait"] = { operationId: "row.list", pollIntervalMs: 20, timeoutMs: 400, until: "$.rows.0" }
		let polls = 0
		const world = new TableWorld()
		const extractRoute = extract(world, [{ id: "r_1" }], (id) => ({ table_id: id }))
		const routes = extractServer(world, extractRoute, { echo: false, onPoll: () => (polls += 1) })
		const server = await serve(listeners, spec, routes)
		const result = await runTable(server.url)
		expect(result.findings.filter((finding) => finding.check === "effects.side-effect-arrives")).toEqual([])
		expect(polls).toBeGreaterThan(0)
	})

	it("binds the created table from the list delta when the write body has no id", async () => {
		const world = new TableWorld()
		const extractRoute = extract(world, [{ id: "r_1" }, { id: "r_2" }], () => ({ accepted: true }))
		const server = await serve(listeners, nestedSpec(), extractServer(world, extractRoute, { echo: false }))
		const result = await runTable(server.url)
		expect(result.findings.filter((finding) => finding.check === "effects.declared-effect-occurs")).toEqual([])
	})
})

describe("driveWait with a bound scope", () => {
	it("fills the poll path from the bound parent id", async () => {
		const spec = nestedSpec()
		const server = await listeners.listen((req, res) => {
			const url = new URL(req.url ?? "/", "http://127.0.0.1")
			if (url.pathname.endsWith("/rows")) return send(res, 200, { rows: [{ id: "r1" }] })
			return send(res, 404)
		})
		const model = buildModel(spec)
		const pollOp = model.byOperationId.get("row.list")
		if (pollOp === undefined) throw new Error("missing row.list")
		/* The document declares no security, so every actor sends nothing. */
		const client = new Client({
			baseUrl: server.url,
			credentials: { resolve: async () => ({ kind: "anonymous" }) },
			redactor: new Redactor(),
		})
		const unbound = await driveWait({
			client,
			pollOp,
			principal: "a",
			record: { table_id: "t1" },
			scope: { project_id: "p1" },
			spec: { operationId: "row.list", pollIntervalMs: 10, timeoutMs: 30 },
			writeOpId: "extract.once",
		})
		expect(unbound.timedOut).toBe(true)
		expect(unbound.polls).toBe(0)

		const bound = await driveWait({
			client,
			pollOp,
			principal: "a",
			record: { table_id: "t1" },
			scope: mergeScope({ project_id: "p1" }, { table_id: "t1" }),
			spec: { operationId: "row.list", pollIntervalMs: 10, timeoutMs: 200, until: "$.rows.0" },
			writeOpId: "extract.once",
		})
		expect(bound.timedOut).toBe(false)
	})
})
