import { describe, expect, it } from "vitest"
import { runCheck } from "../../core/run.ts"
import { backend } from "./__fixtures__/backend.ts"
import { filters, only, reserving, stage } from "./__fixtures__/widgets.ts"
import { filterMalformedTermRejected as check } from "./filter-malformed-term-rejected.ts"

const COHORT = [
	{ id: "w-1", name: "a-b", note: null, status: "open" },
	{ id: "w-2", name: "c-d", note: null, status: "shut" },
]
const DECLARED = { xQuery: { filterable: ["status"] } }

describe("filter.malformed-term-rejected: run", () => {
	it("asserts when a term missing its operator is refused and the well-formed one is not", async () => {
		const { ctx, findings, sent } = stage({ doc: DECLARED, records: COHORT })
		expect(await runCheck(check, ctx)).toEqual({ kind: "asserted" })
		expect(filters(sent)).toEqual(["status.eq.open", "status.open"])
		expect(findings.findings).toEqual([])
	})

	it("reports a malformed term dropped so the whole collection comes back", async () => {
		const { ctx, findings, sent } = stage({
			behavior: { policy: { malformed: "drop" } },
			doc: DECLARED,
			records: COHORT,
		})
		expect(await runCheck(check, ctx)).toMatchObject({ kind: "finding" })
		expect(filters(sent)).toEqual(["status.eq.open", "status.open", "-"])
		expect(only(findings).detail).toBe(
			"status.open returned 200 with the unfiltered set, so the term was dropped. " +
				"A term the declared grammar cannot parse must be rejected.",
		)
	})

	it("reports an accepted malformed term even when the rows differ from the unfiltered set", async () => {
		const correct = backend(COHORT)
		const { ctx, findings } = stage({
			doc: DECLARED,
			records: COHORT,
			respond: (method, path, options) =>
				options.query?.filter === "status.open"
					? { body: { widgets: [] }, status: 200 }
					: correct(method, path, options),
		})
		expect(await runCheck(check, ctx)).toMatchObject({ kind: "finding" })
		expect(only(findings).detail).toBe(
			"status.open returned 200. A term the declared grammar cannot parse must be rejected.",
		)
	})

	it("reports a malformed term that crashes the parser", async () => {
		const { ctx, findings } = stage({ behavior: { policy: { malformed: 500 } }, doc: DECLARED, records: COHORT })
		expect(await runCheck(check, ctx)).toMatchObject({ kind: "finding" })
		expect(only(findings).summary).toBe("a malformed filter term produces a server error")
	})

	it("is unresolved when even the well-formed control term is refused", async () => {
		const { ctx, sent } = stage({ behavior: { status: () => 403 }, doc: DECLARED, records: COHORT })
		expect(await runCheck(check, ctx)).toEqual({
			kind: "unresolved",
			reason: 'a well-formed term on "status" was refused, so a malformed one proves nothing',
		})
		expect(sent).toHaveLength(1)
	})
})

describe("filter.malformed-term-rejected: plan", () => {
	it("probes the first field whose terms the grammar can write, with a stand-in for a field never set", () => {
		const skipped = stage({
			conventions: reserving("-"),
			doc: { xQuery: { filterable: ["name", "status"] } },
			records: COHORT,
		})
		expect(check.plan(skipped.ctx)).toEqual({
			ok: true,
			value: { control: { filter: "status.eq.open" }, field: "status", malformed: { filter: "status.open" } },
		})
		const unset = stage({ doc: { xQuery: { filterable: ["note"] } }, records: COHORT })
		expect(check.plan(unset.ctx)).toMatchObject({ ok: true, value: { control: { filter: "note.eq.oat-probe" } } })
	})

	it("stands down without a declared grammar, a filter, or a writable term", () => {
		expect(
			check.plan(stage({ doc: { xQuery: { filterable: ["status"], grammar: undefined } }, records: COHORT }).ctx).ok,
		).toBe(false)
		expect(check.plan(stage({ doc: { filterParam: false }, records: COHORT }).ctx).ok).toBe(false)
		const unwritable = stage({
			conventions: reserving("-"),
			doc: { xQuery: { filterable: ["name"] } },
			records: COHORT,
		})
		expect(check.plan(unwritable.ctx)).toEqual({
			needs: "a declared grammar whose terms carry a conjunction or an operator to leave out",
			ok: false,
		})
	})
})
