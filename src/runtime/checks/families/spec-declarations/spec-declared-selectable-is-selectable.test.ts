import { describe, expect, it } from "vitest"
import { runCheck } from "../../core/run.ts"
import { listing, queries, refusing, stage, tagQuery } from "./__fixtures__/widgets.ts"
import { declaredSelectableWorks } from "./spec-declared-selectable-is-selectable.ts"

const ok = refusing(400)
const declared = tagQuery({ selectable: ["name", "price"] })

describe("spec.declared-selectable-is-selectable plan", () => {
	it("applies to document-declared selectable fields with a cohort and a select parameter", () => {
		expect(declaredSelectableWorks.plan(stage(ok, { query: declared }).ctx).ok).toBe(true)
	})

	it("stands down when the claim is a guess, empty, unprobeable, or has no select parameter", () => {
		const contexts = [
			stage(ok, { query: { ...declared, source: "heuristic" } }).ctx,
			stage(ok, { query: null }).ctx,
			stage(ok, { query: tagQuery() }).ctx,
			stage(ok, { query: declared, records: [] }).ctx,
			stage(ok, { listOp: listing({}, "select"), query: declared }).ctx,
		]
		for (const ctx of contexts) expect(declaredSelectableWorks.plan(ctx).ok).toBe(false)
	})
})

describe("spec.declared-selectable-is-selectable run", () => {
	it("passes a backend that accepts each declared field beside the identity", async () => {
		const { ctx, findings, sent } = stage(ok, { query: declared })
		expect(await runCheck(declaredSelectableWorks, ctx)).toEqual({ kind: "asserted" })
		expect(queries(sent)).toEqual([
			{ limit: 5, select: "id,name" },
			{ limit: 5, select: "id,price" },
		])
		expect(findings.findings).toEqual([])
		expect(findings.inconclusive).toEqual([])
	})

	it("reports the document when the backend refuses a declared field", async () => {
		const { ctx, findings } = stage(refusing(422, "price"), { query: declared })
		expect(await runCheck(declaredSelectableWorks, ctx)).toEqual({ kind: "finding", verdict: "SPEC_BUG" })
		const [finding] = findings.findings
		expect(finding?.check).toBe("spec.declared-selectable-is-selectable")
		expect(finding?.summary).toBe("the document declares a select field the backend does not accept")
		expect(finding?.detail).toContain("x-query lists 1 field(s) as selectable that the backend rejects: price (422).")
		expect(finding?.evidence.map((e) => e.status)).toEqual([422])
	})

	it("cites at most three refusals, and a refusal outweighs a probe turned away", async () => {
		const respond = refusing(400, "price", "active", "tags", "meta")
		const { ctx, findings } = stage(
			(m, p, o) => (o.query?.["select"] === "id,name" ? { status: 401 } : respond(m, p, o)),
			{
				query: tagQuery({ selectable: ["name", "price", "active", "tags", "meta"] }),
			},
		)
		expect(await runCheck(declaredSelectableWorks, ctx)).toEqual({ kind: "finding", verdict: "SPEC_BUG" })
		expect(findings.findings[0]?.detail).toContain("4 field(s)")
		expect(findings.findings[0]?.evidence).toHaveLength(3)
		expect(findings.inconclusive).toEqual([])
	})

	it("is unresolved when every probe is turned away without a verdict", async () => {
		const { ctx, findings } = stage(refusing(429, "name"), { query: declared })
		expect(await runCheck(declaredSelectableWorks, ctx)).toEqual({
			kind: "unresolved",
			reason: "probes were turned away without a verdict: name (429)",
		})
		expect(findings.findings).toEqual([])
	})

	it("is unresolved, sending nothing, when no fieldset can be written or nothing is declared", async () => {
		for (const fields of [{ listOp: listing({}, "select"), query: declared }, { query: null }]) {
			const { ctx, findings, sent } = stage(ok, fields)
			expect(await declaredSelectableWorks.run(ctx, undefined)).toEqual({
				kind: "unresolved",
				reason: "no declared selectable field could be probed",
			})
			expect(findings.inconclusive).toHaveLength(1)
			expect(sent).toEqual([])
		}
	})
})
