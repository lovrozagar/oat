import { describe, expect, it } from "vitest"
import { buildModel } from "../../spec/graph/build.ts"
import type { SpecModel } from "../../spec/graph/types.ts"
import type { OpenApiDocument } from "../../spec/types.ts"
import { referenceModel } from "./__fixtures__/models.ts"
import { type Targeting, targetEntity, targetPattern } from "./targeting.ts"
import type { ScopeInput } from "./types.ts"

const model = referenceModel()

const targeting = (input: ScopeInput = {}, primary: SpecModel = model): Targeting => ({
	excluded: [],
	input,
	model: primary,
	originTargets: new Map(),
	targets: new Set(),
})

const exclusion = {
	profile: "cheap",
	reason: (op: { operationId: string }) => (op.operationId === "job.start" ? "x-cost: high" : null),
}

describe("targetPattern", () => {
	it("targets the primary's matches", () => {
		const t = targeting()
		targetPattern(t, "row.get")
		expect([...t.targets]).toEqual(["row.get"])
	})

	it("routes <origin>:<pattern> to that origin, prefix removed", () => {
		const t = targeting({ origins: new Map([["cdn", referenceModel()]]) })
		targetPattern(t, "cdn:job.*")
		targetPattern(t, "cdn:row.get")
		expect([...(t.originTargets.get("cdn") ?? [])]).toContain("row.get")
		expect(t.targets.size).toBe(0)
	})

	it("refuses an origin that is not configured, naming the known ones", () => {
		expect(() => targetPattern(targeting({ origins: new Map([["cdn", model]]) }), "api:row.get")).toThrow(
			'oat: --ops "api:row.get" names origin "api", which is not configured. Known: cdn.',
		)
		expect(() => targetPattern(targeting({ origins: new Map() }), "api:row.get")).toThrow(
			'oat: --ops "api:row.get" names origin "api", which is not configured.',
		)
		/* Without origins, a prefixed id is just an id the primary may not have. */
		expect(() => targetPattern(targeting(), "api:row.get")).toThrow('oat: --ops "api:row.get" matches no operation.')
	})

	it("reads a colon in an unnamed operation's path as the path, whatever the method's case", () => {
		const unnamed = buildModel({
			info: { title: "t", version: "1" },
			openapi: "3.1.0",
			paths: { "/jobs/{id}:cancel": { post: { responses: { "200": { description: "ok" } } } } },
		} as unknown as OpenApiDocument)
		const t = targeting({ origins: new Map([["cdn", model]]) }, unnamed)
		targetPattern(t, "post /jobs/{id}:cancel")
		expect([...t.targets]).toEqual(["POST /jobs/{id}:cancel"])
	})

	it("refuses an exact target the profile excludes, and drops glob matches it excludes", () => {
		expect(() => targetPattern(targeting({ exclusion }), "job.start")).toThrow(
			"oat: target job.start is excluded by --profile cheap (x-cost: high). Drop it from --ops or run --profile full.",
		)
		const t = targeting({ exclusion })
		targetPattern(t, "job.*")
		expect(t.targets.has("job.start")).toBe(false)
		expect(t.targets.has("job.list")).toBe(true)
		expect(t.excluded).toEqual([{ operationId: "job.start", reason: "x-cost: high" }])
	})
})

describe("targetEntity", () => {
	it("targets every operation the entity owns, on the primary and on each origin that models it", () => {
		const t = targeting({
			exclusion,
			origins: new Map([
				["cdn", referenceModel()],
				["empty", { ...model, entities: new Map() }],
			]),
		})
		targetEntity(t, "job")
		expect(t.targets.has("job.list")).toBe(true)
		expect(t.targets.has("job.start")).toBe(false)
		expect([...(t.originTargets.get("cdn") ?? [])]).toContain("job.list")
		expect(t.originTargets.has("empty")).toBe(false)
		expect(t.excluded.map((excluded) => excluded.operationId)).toEqual(["job.start", "cdn:job.start"])
	})

	it("finds an entity only an origin models", () => {
		const t = targeting({ origins: new Map([["cdn", model]]) }, { ...model, entities: new Map() })
		targetEntity(t, "row")
		expect(t.targets.size).toBe(0)
		expect(t.originTargets.get("cdn")?.has("row.get")).toBe(true)
	})

	it("refuses an entity nobody models, suggesting from every origin", () => {
		expect(() => targetEntity(targeting(), "tabel")).toThrow(
			'oat: --only "tabel" names no entity. Did you mean: table?',
		)
		expect(() => targetEntity(targeting({ origins: new Map([["cdn", model]]) }), "jbo")).toThrow(/Did you mean: job/)
	})
})
