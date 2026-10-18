import { describe, expect, it } from "vitest"
import { filterSpec } from "../../../../spec/conventions.ts"
import { emptyCapabilities, type EffectiveFilterField } from "../../../../spec/query-capabilities.ts"
import { runCheck } from "../../core/run.ts"
import { answering, listing, queries, refusing, ROW, stage, tagQuery } from "./__fixtures__/widgets.ts"
import { declaredFilterableWorks } from "./spec-declared-filterable-is-filterable.ts"

/** Capabilities that name `filterable` exactly, as config or a hook would resolve them. */
function caps(filterable: EffectiveFilterField[]) {
	return { ...emptyCapabilities(), filterable, source: "tag" as const }
}

const ok = refusing(400)

describe("spec.declared-filterable-is-filterable plan", () => {
	it("applies to a document-declared filterable field with a cohort and a filter parameter", () => {
		const { ctx } = stage(ok, { query: tagQuery({ filterable: ["name"] }) })
		expect(declaredFilterableWorks.plan(ctx).ok).toBe(true)
	})

	it("stands down when the claim is a guess, empty, unprobeable, or has no filter parameter", () => {
		const declared = tagQuery({ filterable: ["name"] })
		const contexts = [
			stage(ok, { query: { ...declared, source: "heuristic" } }).ctx,
			stage(ok, { query: null }).ctx,
			stage(ok, { query: tagQuery() }).ctx,
			stage(ok, { query: declared, records: [] }).ctx,
			stage(ok, { listOp: listing({}, "filter"), query: declared }).ctx,
		]
		for (const ctx of contexts) expect(declaredFilterableWorks.plan(ctx).ok).toBe(false)
	})
})

describe("spec.declared-filterable-is-filterable run", () => {
	it("passes a backend that accepts every declared field, probing each with a cohort value", async () => {
		const { ctx, findings, sent } = stage(ok, { query: tagQuery({ filterable: ["name", "price", "active"] }) })
		expect(await runCheck(declaredFilterableWorks, ctx)).toEqual({ kind: "asserted" })
		expect(queries(sent)).toEqual([
			{ filter: "name.eq.Ann", limit: 5 },
			{ filter: "price.eq.3", limit: 5 },
			{ filter: "active.eq.true", limit: 5 },
		])
		expect(findings.findings).toEqual([])
		expect(findings.inconclusive).toEqual([])
	})

	it("reports the document when the backend refuses declared fields with 400 or 422", async () => {
		const { ctx, findings } = stage(answering({ active: 422, price: 400 }), {
			query: tagQuery({ filterable: ["name", "price", "active"] }),
		})
		expect(await runCheck(declaredFilterableWorks, ctx)).toEqual({ kind: "finding", verdict: "SPEC_BUG" })
		const [finding] = findings.findings
		expect(finding?.check).toBe("spec.declared-filterable-is-filterable")
		expect(finding?.summary).toBe("the document declares a filter the backend does not accept")
		expect(finding?.detail).toContain(
			"x-query lists 2 field(s) as filterable that the backend rejects: price (400), active (422).",
		)
		expect(finding?.evidence.map((e) => e.status)).toEqual([400, 422])
	})

	it("cites at most three refusals, and a refusal outweighs a probe turned away", async () => {
		const respond = answering({ active: 400, ghost: 400, name: 403, price: 400, rank: 400 })
		const { ctx, findings } = stage(respond, {
			query: tagQuery({ filterable: ["name", "price", "active", "ghost", "rank"] }),
		})
		expect(await runCheck(declaredFilterableWorks, ctx)).toEqual({ kind: "finding", verdict: "SPEC_BUG" })
		expect(findings.findings[0]?.detail).toContain("4 field(s)")
		expect(findings.findings[0]?.evidence).toHaveLength(3)
		expect(findings.inconclusive).toEqual([])
	})

	it("is unresolved when every probe is turned away without a verdict", async () => {
		const { ctx, findings } = stage(refusing(500, "name"), { query: tagQuery({ filterable: ["name", "price"] }) })
		expect(await runCheck(declaredFilterableWorks, ctx)).toEqual({
			kind: "unresolved",
			reason: "probes were turned away without a verdict: name (500)",
		})
		expect(findings.findings).toEqual([])
	})
})

describe("spec.declared-filterable-is-filterable run without a probe", () => {
	it("is unresolved, sending nothing, when no declared field allows a probe", async () => {
		const { ctx, findings, sent } = stage(ok, {
			capabilities: caps([{ field: "name", ops: ["gt"] }]),
			query: tagQuery({ filterable: ["name"] }),
		})
		expect(await runCheck(declaredFilterableWorks, ctx)).toMatchObject({ kind: "unresolved" })
		expect(findings.inconclusive[0]?.reason).toBe(
			"no declared filterable field holds a non-null value in the cohort, so none could be probed",
		)
		expect(sent).toEqual([])
	})

	it("is unresolved, sending nothing, when run without a declaration", async () => {
		const { ctx, sent } = stage(ok, { query: null })
		expect(await declaredFilterableWorks.run(ctx, undefined)).toMatchObject({ kind: "unresolved" })
		expect(sent).toEqual([])
	})

	it("sends nothing for a field the grammar cannot spell a term for", async () => {
		const spec = { ...filterSpec(listing({}).conventions), term: "{conj}{field}.{op}.{value}" }
		const { ctx, sent } = stage(ok, {
			listOp: listing({ filterGrammar: spec, grammar: "template" }),
			query: tagQuery({ filterable: ["name"] }),
		})
		expect(await runCheck(declaredFilterableWorks, ctx)).toMatchObject({ kind: "unresolved" })
		expect(sent).toEqual([])
	})
})

/** The filter each declared field was probed with, given the cohort and the capabilities. */
async function probes(filterable: string[], fields: Parameters<typeof stage>[1] = {}) {
	const { ctx, sent } = stage(ok, { query: tagQuery({ filterable }), ...fields })
	await declaredFilterableWorks.run(ctx, undefined)
	return queries(sent).map((query) => (query as { filter: string }).filter)
}

describe("spec.declared-filterable-is-filterable array probes", () => {
	it("probes an array field by membership of an element the cohort holds", async () => {
		expect(await probes(["tags"], { capabilities: caps([{ field: "tags", ops: ["contains"] }]) })).toEqual([
			"tags.contains.red",
		])
	})

	it("draws a member from the item schema when the cohort's array is empty or the field is unlisted", async () => {
		const filters = await probes(["tags", "labels"], {
			capabilities: caps([
				{ field: "tags", ops: ["contains"] },
				{ field: "labels", ops: ["contains"], type: "array" },
			]),
			records: [{ ...ROW, tags: [] }],
		})
		expect(filters).toEqual([
			"tags.contains.zzz last alphabetically 4242 test",
			"labels.contains.zzz last alphabetically 4242 test",
		])
	})

	it("skips an array field without membership, or whose members no value can meet", async () => {
		const filters = await probes(["tags", "impossibles"], {
			capabilities: caps([{ field: "tags" }, { field: "impossibles", ops: ["contains"] }]),
		})
		expect(filters).toEqual([])
	})
})

describe("spec.declared-filterable-is-filterable scalar probes", () => {
	it("skips a scalar field without equality", async () => {
		expect(await probes(["name"], { capabilities: caps([{ field: "name", ops: ["like"] }]) })).toEqual([])
	})

	it("passes over null values to the first cohort value, and uses fields the capabilities omit", async () => {
		const filters = await probes(["name"], {
			capabilities: caps([]),
			records: [
				{ ...ROW, name: null },
				{ ...ROW, name: "Bo" },
			],
		})
		expect(filters).toEqual(["name.eq.Bo"])
	})

	it("draws a sentinel of the field's type when the cohort holds no scalar for it", async () => {
		const filters = await probes(["price", "active", "rank", "ghost"], {
			capabilities: caps([
				{ field: "price" },
				{ field: "active" },
				{ field: "rank", type: "number" },
				{ field: "ghost" },
			]),
			records: [{ id: "w1" }],
		})
		const [price, active, rank, ghost] = filters
		expect(price).toMatch(/^price\.eq\.\d+$/)
		expect(active).toBe("active.eq.true")
		expect(rank).toMatch(/^rank\.eq\.\d+$/)
		expect(ghost).toBe("ghost.eq.zzz last alphabetically 4242 test")
	})

	it("skips a scalar field whose sentinel is not scalar or cannot be drawn", async () => {
		expect(
			await probes(["meta", "impossible"], { capabilities: caps([{ field: "meta" }, { field: "impossible" }]) }),
		).toEqual([])
	})
})
