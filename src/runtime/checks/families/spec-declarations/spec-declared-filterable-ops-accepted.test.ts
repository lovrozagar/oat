import { describe, expect, it } from "vitest"
import { filterSpec } from "../../../../spec/conventions/filter.ts"
import type { EffectiveFilterField } from "../../../../spec/query/effective.ts"
import { emptyCapabilities } from "../../../../spec/query/merge.ts"
import { runCheck } from "../../core/run.ts"
import { listing, queries, refusing, ROW, stage, tagQuery } from "./__fixtures__/widgets.ts"
import { declaredFilterableOpsAccepted } from "./spec-declared-filterable-ops-accepted.ts"

/** Capabilities that name `filterable` exactly, as config or a hook would resolve them. */
function caps(filterable: EffectiveFilterField[]) {
	return { ...emptyCapabilities(), filterable, source: "tag" as const }
}

const ok = refusing(400)
const declared = tagQuery({ filterable: ["name"] })

/** The filter each probe carried, for `filterable` against the one-row cohort or `records`. */
async function probes(filterable: EffectiveFilterField[], fields: Parameters<typeof stage>[1] = {}) {
	const { ctx, sent } = stage(ok, { capabilities: caps(filterable), query: declared, ...fields })
	await declaredFilterableOpsAccepted.run(ctx, undefined)
	return queries(sent).map((query) => Object.values(query as Record<string, unknown>).find((v) => v !== 5))
}

describe("spec.declared-filterable-ops-accepted plan", () => {
	it("applies when the document closes the operator list of a declared field", () => {
		const { ctx } = stage(ok, { capabilities: caps([{ field: "name", ops: ["eq"] }]), query: declared })
		expect(declaredFilterableOpsAccepted.plan(ctx).ok).toBe(true)
	})

	it("stands down for a guessed declaration, or when every operator list is open", () => {
		const closed = caps([{ field: "name", ops: ["eq"] }])
		const contexts = [
			stage(ok, { capabilities: closed, query: { ...declared, source: "heuristic" } }).ctx,
			stage(ok, { capabilities: closed, query: null }).ctx,
			stage(ok, { capabilities: caps([{ field: "name" }]), query: declared }).ctx,
		]
		for (const ctx of contexts) expect(declaredFilterableOpsAccepted.plan(ctx).ok).toBe(false)
	})
})

describe("spec.declared-filterable-ops-accepted run", () => {
	it("passes a backend that accepts every declared operator, probing closed fields only", async () => {
		const { ctx, findings, sent } = stage(ok, {
			capabilities: caps([
				{ field: "name", ops: ["eq", "in", "nin", "is"] },
				{ field: "tags", ops: ["contains"] },
				{ field: "price" },
			]),
			query: declared,
		})
		expect(await runCheck(declaredFilterableOpsAccepted, ctx)).toEqual({ kind: "asserted" })
		expect(queries(sent)).toEqual([
			{ filter: "name.eq.Ann", limit: 5 },
			{ filter: "name.in.(Ann)", limit: 5 },
			{ filter: "name.nin.(Ann)", limit: 5 },
			{ filter: "name.is.null", limit: 5 },
			{ filter: "tags.contains.red", limit: 5 },
		])
		expect(findings.findings).toEqual([])
		expect(findings.inconclusive).toEqual([])
	})

	it("reports the document when the backend refuses a declared operator", async () => {
		const { ctx, findings } = stage(refusing(422, "name.in"), {
			capabilities: caps([{ field: "name", ops: ["eq", "in"] }]),
			query: declared,
		})
		expect(await runCheck(declaredFilterableOpsAccepted, ctx)).toEqual({ kind: "finding", verdict: "SPEC_BUG" })
		const [finding] = findings.findings
		expect(finding?.check).toBe("spec.declared-filterable-ops-accepted")
		expect(finding?.summary).toBe("the document declares a filter operator the backend rejects")
		expect(finding?.detail).toBe("declared ops that 4xx: name.in (422).")
		expect(finding?.evidence.map((e) => e.status)).toEqual([422])
	})
})

describe("spec.declared-filterable-ops-accepted verdicts over many probes", () => {
	it("names at most eight refusals and cites three, and a refusal outweighs a probe turned away", async () => {
		const ops = ["eq", "neq", "gt", "gte", "lt", "lte", "like", "ilike", "in"] as const
		const respond = refusing(400, "name.")
		const { ctx, findings } = stage(
			(m, p, o) => (String(o.query?.["filter"]).startsWith("tags") ? { status: 500 } : respond(m, p, o)),
			{
				capabilities: caps([
					{ field: "name", ops: [...ops] },
					{ field: "tags", ops: ["contains"] },
				]),
				query: declared,
			},
		)
		expect(await runCheck(declaredFilterableOpsAccepted, ctx)).toEqual({ kind: "finding", verdict: "SPEC_BUG" })
		const [finding] = findings.findings
		expect(finding?.detail).toBe(
			`declared ops that 4xx: ${ops
				.slice(0, 8)
				.map((op) => `name.${op} (400)`)
				.join(", ")}.`,
		)
		expect(finding?.evidence).toHaveLength(3)
		expect(findings.inconclusive).toEqual([])
	})

	it("is unresolved when every probe is turned away without a verdict", async () => {
		const { ctx, findings } = stage(refusing(403, "name.eq"), {
			capabilities: caps([{ field: "name", ops: ["eq", "gt"] }]),
			query: declared,
		})
		expect(await runCheck(declaredFilterableOpsAccepted, ctx)).toEqual({
			kind: "unresolved",
			reason: "probes were turned away without a verdict: name.eq (403)",
		})
		expect(findings.findings).toEqual([])
	})
})

describe("spec.declared-filterable-ops-accepted probes", () => {
	it("skips operators the grammar cannot write, and terms it cannot spell", async () => {
		expect(await probes([{ field: "name", ops: ["eq", "gt"] }], { listOp: listing({ grammar: "equality" }) })).toEqual([
			"Ann",
		])
		const spec = { ...filterSpec(listing({}).conventions), term: "{conj}{field}.{op}.{value}" }
		expect(
			await probes([{ field: "name", ops: ["eq"] }], { listOp: listing({ filterGrammar: spec, grammar: "template" }) }),
		).toEqual([])
	})

	it("probes membership with a stand-in when the cohort's array is empty", async () => {
		expect(await probes([{ field: "tags", ops: ["contains"] }], { records: [{ ...ROW, tags: [] }] })).toEqual([
			"tags.contains.oat-probe",
		])
	})

	it("draws a sentinel of the field's type when no row holds the field", async () => {
		const filters = await probes(
			[
				{ field: "price", ops: ["gt"] },
				{ field: "rank", ops: ["eq"], type: "number" },
				{ field: "ghost", ops: ["in"] },
			],
			{ records: [{ id: "w1" }] },
		)
		const [price, rank, ghost] = filters
		expect(price).toMatch(/^price\.gt\.\d+$/)
		expect(rank).toMatch(/^rank\.eq\.\d+$/)
		expect(ghost).toBe("ghost.in.(zzz last alphabetically 4242 test)")
	})

	it("sends no operator probe for a field with no typed value to compare against", async () => {
		const filters = await probes(
			[
				{ field: "meta", ops: ["eq"] },
				{ field: "impossible", ops: ["eq"] },
				{ field: "name", ops: ["eq"] },
			],
			{ records: [{ id: "w1" }] },
		)
		expect(filters).toHaveLength(1)
		expect(filters[0]).toMatch(/^name\.eq\./)
	})

	it("is unresolved when no declared operator has a value to probe with", async () => {
		const { ctx, sent } = stage(ok, {
			capabilities: caps([{ field: "meta", ops: ["eq"] }]),
			query: declared,
			records: [{ id: "w1" }],
		})
		expect(await declaredFilterableOpsAccepted.run(ctx, undefined)).toEqual({
			kind: "unresolved",
			reason: "no declared operator has a value of its field's type to probe with",
		})
		expect(sent).toEqual([])
	})
})
