import { describe, expect, it } from "vitest"
import { PRINCIPALS, SECURITY } from "../../conformance/matrix/principals.ts"
import { createMemoryReference } from "../../reference/http/engines.ts"
import { run } from "../../runtime/run/index.ts"
import { crowd, report } from "./__fixtures__/reports.ts"
import { checkCatalog } from "./catalog.ts"
import {
	buildMatrixGraph,
	buildMatrixGraphFromReport,
	compactMatrixGraph,
	graphJson,
	renderMatrixGraph,
	renderMatrixGraphFromParts,
} from "./graph.ts"
import { rowsOfReport } from "./rows.ts"
import type { MatrixParts } from "./types.ts"

const parts = (): MatrixParts => ({
	...rowsOfReport(report({ cells: { table: { "sort.order-is-applied": "failed" } }, entities: ["table"] })),
	baseUrl: "http://api.test",
	entity: "table",
	generatedAt: "2026-10-18T00:00:00.000Z",
	readSurface: ["GET /table"],
})

describe("buildMatrixGraph", () => {
	it("draws one entity, with no identity and no invalidate links", () => {
		const graph = buildMatrixGraph(parts())
		expect(graph).toMatchObject({
			baseUrl: "http://api.test",
			edges: checkCatalog().edges,
			generatedAt: "2026-10-18T00:00:00.000Z",
			index: { crossClaims: 0, entityCount: 1, failed: ["table"], inbound: {}, parents: [] },
			invalidate: [],
			kind: "oat.matrix",
		})
		expect(graph.entities).toHaveLength(1)
		expect(graph.entities[0]).toMatchObject({ identity: null, name: "table", readSurface: ["GET /table"] })
		expect(graph.read.status.blocked).toBe("not evaluated; a dependsOn check already failed")
		expect(graph.mermaid.startsWith("flowchart LR\n  table((table))")).toBe(true)
	})
})

describe("the matrix schema", () => {
	it("states schemaVersion 1 and no version", () => {
		const keys = Object.keys(buildMatrixGraph(parts()))
		expect(keys.slice(0, 2)).toEqual(["kind", "schemaVersion"])
		expect(buildMatrixGraph(parts())).toMatchObject({ schemaVersion: 1 })
		expect(keys).not.toContain("version")
	})
})

describe("buildMatrixGraphFromReport", () => {
	it("draws every tested entity with its identity, and counts the claims each parent receives", () => {
		const graph = buildMatrixGraphFromReport(
			report({
				entities: [{ identity: "id", name: "table" }, "row", "cell"],
				invalidates: [
					{ routes: ["GET /table"], writer: "row" },
					{ routes: ["GET /table", "GET /cell"], writer: "cell" },
				],
				tested: ["table", "row", "cell", "ghost"],
			}),
		)
		expect(graph.entities.map((e) => [e.name, e.identity, e.readSurface])).toEqual([
			["table", "id", ["GET /table"]],
			["row", null, ["GET /row"]],
			["cell", null, ["GET /cell"]],
			["ghost", null, []],
		])
		expect(graph.index).toEqual({
			crossClaims: 2,
			entityCount: 4,
			failed: [],
			inbound: { table: 2 },
			parents: ["table"],
		})
	})

	it("draws a placeholder entity when the run tested none", () => {
		const graph = buildMatrixGraphFromReport(report({ entities: ["table"], tested: [] }))
		expect(graph.entities.map((e) => e.name)).toEqual(["entity"])
	})

	it("draws a real run: a stale list fails each listing's read-after-write, and what depends on it stands down", async () => {
		const reference = await createMemoryReference({ defects: ["STALE_LIST"] })
		try {
			const transport = reference.fetch
			const result = await run({
				baseUrl: reference.url,
				network: { fetch: transport },
				principals: PRINCIPALS,
				security: SECURITY,
				seed: 42,
				spec: `${reference.url}/v1/openapi/spec`,
			})
			const graph = buildMatrixGraphFromReport({ ...result, baseUrl: reference.url, startedAt: new Date(0) })
			expect(graph.index.failed).toEqual(["job", "row", "table"])
			for (const name of graph.index.failed) {
				const entity = graph.entities.find((e) => e.name === name)
				expect(entity?.roots).toEqual(["list.read-after-write"])
				expect(entity?.counts.blocked).toBeGreaterThan(0)
			}
			expect(graph.index.parents).toEqual(["table"])
		} finally {
			await reference.close()
		}
	})
})

describe("compactMatrixGraph", () => {
	it("keeps a graph of up to 80 entities whole", () => {
		const graph = buildMatrixGraphFromReport(crowd(80, (i) => (i + 1) % 80))
		expect(compactMatrixGraph(graph)).toBe(graph)
	})

	it("drops clean entities' nodes, the dependsOn edges, and repeated or same-entity claims", () => {
		const names = Array.from({ length: 81 }, (_, i) => `e${i}`)
		const graph = buildMatrixGraphFromReport(
			report({
				cells: { e1: { "list.read-after-write": "failed" }, e2: { "query.axes-compose": "blocked" } },
				entities: names,
				invalidates: [
					{ routes: ["GET /e0", "GET /e0"], writer: "e1" },
					{ routes: ["GET /e2"], writer: "e2" },
				],
			}),
		)
		const compact = compactMatrixGraph(graph)
		expect(compact.entities.filter((e) => e.nodes.length > 0).map((e) => e.name)).toEqual(["e1", "e2"])
		expect(compact.edges.every((e) => e.kind === "uses")).toBe(true)
		expect(compact.invalidate).toEqual([
			{ cross: true, fromEntity: "e1", fromOp: "e1.create", toEntity: "e0", toRoute: "GET …/e0" },
		])
	})
})

describe("graphJson", () => {
	it("writes the compacted graph, two-space indented, newline-terminated", () => {
		const input = crowd(81, (i) => (i + 1) % 81)
		const text = renderMatrixGraph(input)
		expect(text).toBe(graphJson(buildMatrixGraphFromReport(input)))
		expect(text.endsWith("}\n")).toBe(true)
		expect(JSON.parse(text)).toEqual(JSON.parse(JSON.stringify(compactMatrixGraph(buildMatrixGraphFromReport(input)))))
		expect(renderMatrixGraphFromParts(parts())).toBe(`${JSON.stringify(buildMatrixGraph(parts()), null, 2)}\n`)
	})
})
