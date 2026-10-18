import { describe, expect, it } from "vitest"
import { modelOf } from "../../__fixtures__/harness.ts"
import { runCheck } from "../../core/run.ts"
import { caller, notesContext } from "./__fixtures__/context.ts"
import { type NotesOptions, notesDocument } from "./__fixtures__/notes.ts"
import { crossTenantFilterBypass } from "./tenant-filter-does-not-bypass-scope.ts"

const FILTER = { in: "query", name: "filter", schema: { type: "string" } }
const filtered = (options: NotesOptions = {}) =>
	modelOf(notesDocument({ listQuery: [FILTER], query: { filterable: ["id"], grammar: "postgrest" }, ...options }))

/** The other tenant's filtered listing: `rows` with `status`. */
const listing = (status: number, rows: unknown[]) => () => ({ body: rows, status })

describe("tenant.filter-does-not-bypass-scope", () => {
	it("passes when an equality filter on another tenant's id finds nothing", async () => {
		const { ctx, findings, sent } = notesContext(filtered(), listing(200, []))
		expect(await runCheck(crossTenantFilterBypass, ctx)).toEqual({ kind: "asserted" })
		expect(sent).toHaveLength(1)
		expect(sent[0]?.path).toBe("/orgs/o2/notes")
		expect(sent[0]?.options.query).toEqual({ filter: "id.eq.n1" })
		expect(caller(sent[0]?.options ?? {})).toBe("other")
		expect(findings.findings).toEqual([])
	})

	it("passes when the filtered listing is refused, or holds only the caller's rows", async () => {
		for (const respond of [listing(403, [{ id: "n1" }]), listing(200, [{ id: "theirs" }])]) {
			const { ctx, findings } = notesContext(filtered(), respond)
			expect(await runCheck(crossTenantFilterBypass, ctx)).toEqual({ kind: "asserted" })
			expect(findings.findings).toEqual([])
		}
	})

	it("reports SECURITY when the filter returns the record across a declared tenant", async () => {
		const { ctx, findings } = notesContext(filtered({ tenant: "org_id" }), listing(200, [{ id: "n1" }]))
		expect(await runCheck(crossTenantFilterBypass, ctx)).toEqual({ kind: "finding", verdict: "SECURITY" })
		expect(findings.findings[0]?.summary).toBe("a filter reaches records outside the caller's tenant")
		expect(findings.findings[0]?.detail).toContain('x-tenant: "org_id"')
	})

	it("reports AMBIGUITY and passes when the tenant was only inferred", async () => {
		const { ctx, findings } = notesContext(filtered(), listing(200, [{ id: "n1" }]))
		expect(await runCheck(crossTenantFilterBypass, ctx)).toEqual({ kind: "asserted" })
		expect(findings.byVerdict("AMBIGUITY")).toHaveLength(1)
		expect(findings.findings[0]?.detail).toContain('from the "org_id" path parameter')
	})

	it("stands down without what the probe needs", () => {
		const unfiltered = modelOf(notesDocument())
		const shared = filtered({ tenant: false })
		const titleOnly = filtered({ query: { filterable: ["title"], grammar: "postgrest" } })
		for (const { ctx } of [
			notesContext(filtered(), listing(200, []), { altAuth: undefined }),
			notesContext(filtered(), listing(200, []), { altScope: undefined }),
			notesContext(filtered(), listing(200, []), { records: [] }),
			notesContext(unfiltered, listing(200, [])),
			notesContext(shared, listing(200, [])),
			notesContext(titleOnly, listing(200, [])),
		]) {
			expect(crossTenantFilterBypass.plan(ctx)).toEqual({ ok: false })
		}
	})

	it("names what is missing when the record has no id or the grammar cannot say equality", () => {
		const { ctx } = notesContext(filtered(), listing(200, []), { records: [{ title: "first" }] })
		expect(crossTenantFilterBypass.plan(ctx)).toEqual({ needs: "a record that carries its identity", ok: false })
		const unrecognised = modelOf(notesDocument({ listQuery: [FILTER] }))
		const { ctx: plain } = notesContext(unrecognised, listing(200, []))
		expect(crossTenantFilterBypass.plan(plain)).toEqual({
			needs: "a filter grammar that can express equality on the identity",
			ok: false,
		})
	})
})
