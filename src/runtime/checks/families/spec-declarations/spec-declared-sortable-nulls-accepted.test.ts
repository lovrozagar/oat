import { describe, expect, it } from "vitest"
import type { EffectiveSortableField } from "../../../../spec/query/effective.ts"
import { emptyCapabilities } from "../../../../spec/query/merge.ts"
import { runCheck } from "../../core/run.ts"
import { listing, queries, refusing, stage } from "./__fixtures__/widgets.ts"
import { declaredSortableNullsAccepted } from "./spec-declared-sortable-nulls-accepted.ts"

/** Capabilities that sort by `sortable`, with `nulls` declared for every field when given. */
function caps(sortable: EffectiveSortableField[], nulls?: Array<"first" | "last">) {
	return {
		...emptyCapabilities(),
		sortable,
		source: "tag" as const,
		...(nulls === undefined ? {} : { sort: { nulls } }),
	}
}

const ok = refusing(400)

describe("spec.declared-sortable-nulls-accepted plan", () => {
	it("applies when a sortable field declares a nulls token, on its own or for every field", () => {
		for (const capabilities of [caps([{ field: "name", nulls: ["first"] }]), caps([{ field: "name" }], ["last"])]) {
			expect(declaredSortableNullsAccepted.plan(stage(ok, { capabilities }).ctx).ok).toBe(true)
		}
	})

	it("stands down without an order parameter, a nulls token in the grammar, or a declared token", () => {
		const declared = caps([{ field: "name", nulls: ["first"] }])
		const contexts = [
			stage(ok, { capabilities: declared, listOp: listing({}, "order") }).ctx,
			stage(ok, { capabilities: declared, listOp: listing({ sortGrammar: "prefixed" }) }).ctx,
			stage(ok, { capabilities: caps([{ field: "name" }]) }).ctx,
		]
		for (const ctx of contexts) expect(declaredSortableNullsAccepted.plan(ctx).ok).toBe(false)
	})
})

describe("spec.declared-sortable-nulls-accepted run", () => {
	it("passes a backend that accepts each declared token, probing only declared ones", async () => {
		const { ctx, findings, sent } = stage(ok, {
			capabilities: caps([
				{ field: "name", nulls: ["first", "last"] },
				{ field: "price", nulls: ["last"] },
				{ field: "id" },
			]),
		})
		expect(await runCheck(declaredSortableNullsAccepted, ctx)).toEqual({ kind: "asserted" })
		expect(queries(sent)).toEqual([
			{ limit: 5, order: "name.asc.nullsfirst" },
			{ limit: 5, order: "name.asc.nullslast" },
			{ limit: 5, order: "price.asc.nullslast" },
		])
		expect(findings.findings).toEqual([])
		expect(findings.inconclusive).toEqual([])
	})

	it("reports the document when the backend refuses a declared token, citing at most three", async () => {
		const respond = refusing(400, "nullsfirst")
		const { ctx, findings } = stage(
			(m, p, o) => (o.query?.order === "id.asc.nullslast" ? { status: 500 } : respond(m, p, o)),
			{
				capabilities: caps(
					[{ field: "name" }, { field: "price" }, { field: "active" }, { field: "id" }],
					["first", "last"],
				),
			},
		)
		expect(await runCheck(declaredSortableNullsAccepted, ctx)).toEqual({ kind: "finding", verdict: "SPEC_BUG" })
		const [finding] = findings.findings
		expect(finding?.check).toBe("spec.declared-sortable-nulls-accepted")
		expect(finding?.summary).toBe("the document declares a nulls sort token the backend rejects")
		expect(finding?.detail).toBe(
			"rejected: name.asc.nullsfirst (400), price.asc.nullsfirst (400), active.asc.nullsfirst (400), id.asc.nullsfirst (400).",
		)
		expect(finding?.evidence).toHaveLength(3)
		expect(findings.inconclusive).toEqual([])
	})

	it("is unresolved when every probe is turned away without a verdict", async () => {
		const { ctx, findings } = stage(refusing(401, "nullslast"), { capabilities: caps([{ field: "name" }], ["last"]) })
		expect(await runCheck(declaredSortableNullsAccepted, ctx)).toEqual({
			kind: "unresolved",
			reason: "probes were turned away without a verdict: name.asc.nullslast (401)",
		})
		expect(findings.findings).toEqual([])
	})

	it("sends nothing when the grammar has no nulls token", async () => {
		const { ctx, sent } = stage(ok, {
			capabilities: caps([{ field: "name", nulls: ["first"] }]),
			listOp: listing({ sortGrammar: "prefixed" }),
		})
		expect(await declaredSortableNullsAccepted.run(ctx, undefined)).toEqual({ kind: "asserted" })
		expect(sent).toEqual([])
	})
})
