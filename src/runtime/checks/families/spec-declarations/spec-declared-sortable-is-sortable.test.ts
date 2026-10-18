import { describe, expect, it } from "vitest"
import { runCheck } from "../../core/run.ts"
import { listing, queries, refusing, stage, tagQuery } from "./__fixtures__/widgets.ts"
import { declaredSortableWorks } from "./spec-declared-sortable-is-sortable.ts"

const ok = refusing(400)
const declared = tagQuery({ sortable: ["name", "price"] })

describe("spec.declared-sortable-is-sortable plan", () => {
	it("applies to document-declared sortable fields with a cohort and an order parameter", () => {
		expect(declaredSortableWorks.plan(stage(ok, { query: declared }).ctx).ok).toBe(true)
	})

	it("stands down when the claim is a guess, empty, unprobeable, or has no order parameter", () => {
		const contexts = [
			stage(ok, { query: { ...declared, source: "heuristic" } }).ctx,
			stage(ok, { query: null }).ctx,
			stage(ok, { query: tagQuery() }).ctx,
			stage(ok, { query: declared, records: [] }).ctx,
			stage(ok, { listOp: listing({}, "order"), query: declared }).ctx,
		]
		for (const ctx of contexts) expect(declaredSortableWorks.plan(ctx).ok).toBe(false)
	})
})

describe("spec.declared-sortable-is-sortable run", () => {
	it("passes a backend that accepts an ascending order on each declared field", async () => {
		const { ctx, findings, sent } = stage(ok, { query: declared })
		expect(await runCheck(declaredSortableWorks, ctx)).toEqual({ kind: "asserted" })
		expect(queries(sent)).toEqual([
			{ limit: 5, order: "name.asc" },
			{ limit: 5, order: "price.asc" },
		])
		expect(findings.findings).toEqual([])
		expect(findings.inconclusive).toEqual([])
	})

	it("reports the document when the backend refuses a declared field", async () => {
		const { ctx, findings } = stage(refusing(400, "price"), { query: declared })
		expect(await runCheck(declaredSortableWorks, ctx)).toEqual({ kind: "finding", verdict: "SPEC_BUG" })
		const [finding] = findings.findings
		expect(finding?.check).toBe("spec.declared-sortable-is-sortable")
		expect(finding?.summary).toBe("the document declares a sort field the backend does not accept")
		expect(finding?.detail).toContain("x-query lists 1 field(s) as sortable that the backend rejects: price (400).")
		expect(finding?.evidence.map((e) => e.status)).toEqual([400])
	})

	it("cites at most three refusals, and a refusal outweighs a probe turned away", async () => {
		const respond = refusing(422, "price", "active", "tags", "meta")
		const { ctx, findings } = stage((m, p, o) => (o.query?.order === "name.asc" ? { status: 503 } : respond(m, p, o)), {
			query: tagQuery({ sortable: ["name", "price", "active", "tags", "meta"] }),
		})
		expect(await runCheck(declaredSortableWorks, ctx)).toEqual({ kind: "finding", verdict: "SPEC_BUG" })
		expect(findings.findings[0]?.detail).toContain("4 field(s)")
		expect(findings.findings[0]?.evidence).toHaveLength(3)
		expect(findings.inconclusive).toEqual([])
	})

	it("is unresolved when every probe is turned away without a verdict", async () => {
		const { ctx, findings } = stage(refusing(404, "name"), { query: declared })
		expect(await runCheck(declaredSortableWorks, ctx)).toEqual({
			kind: "unresolved",
			reason: "probes were turned away without a verdict: name (404)",
		})
		expect(findings.findings).toEqual([])
	})

	it("is unresolved, sending nothing, when nothing is declared", async () => {
		for (const query of [null, tagQuery()]) {
			const { ctx, sent } = stage(ok, { query })
			expect(await declaredSortableWorks.run(ctx, undefined)).toEqual({
				kind: "unresolved",
				reason: "no declared sortable field could be probed",
			})
			expect(sent).toEqual([])
		}
	})
})
