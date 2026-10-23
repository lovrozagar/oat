import { describe, expect, it } from "vitest"
import type { JsonSchema, OpenApiDocument } from "../../../../spec/types.ts"
import type { FindingCollector } from "../../../finding.ts"
import type { Record_ } from "../../../world/records.ts"
import { type Serve, wireStage } from "../../__fixtures__/wire.ts"
import type { Check } from "../../core/check.ts"
import { runCheck } from "../../core/run.ts"
import { filterContainsMembership } from "./filter-contains-membership.ts"
import { filterIsNullSelectsNulls } from "./filter-is-null-selects-nulls.ts"
import { numericComparisonIsNumeric } from "./filter-numeric-comparison-is-numeric.ts"

/*
 * A live store holds rows oat never seeded. A filter check that knows the cohort judges only the
 * cohort's identities: an extra match outside it is no defect, and must not hide one inside it.
 */

const TEXT_COMPARE = "compared as text rather than as a number"

/** Cohort values whose numeric order disagrees with text order (`13` vs `5`). */
const COHORT: Record_[] = [
	{ amount: 2, id: "n-low", note: "present", tags: ["red"] },
	{ amount: 5, id: "n-mid", note: null, tags: ["red"] },
	{ amount: 13, id: "n-high", note: "present", tags: ["blue"] },
]

/** Rows the live store holds that oat never seeded. */
const OUTSIDE: Record_[] = [
	{ amount: 9, id: "x-gt", note: null, tags: ["red"] },
	{ amount: 9, id: "x-gt-2", note: "present", tags: ["green"] },
]

function itemSchema(): JsonSchema {
	return {
		properties: {
			amount: { type: "number" },
			id: { type: "string" },
			note: { type: ["string", "null"] },
			tags: { items: { type: "string" }, type: "array" },
		},
		required: ["id", "amount"],
		type: "object",
	}
}

function listSpec(): OpenApiDocument {
	const schema = {
		properties: { widgets: { items: itemSchema(), type: "array" } },
		required: ["widgets"],
		type: "object",
	}
	return {
		info: { title: "numeric-filter", version: "1" },
		openapi: "3.1.0",
		paths: {
			"/v1/widgets": {
				get: {
					operationId: "widget.list",
					parameters: [
						{
							description: "PostgREST-style filter: field.op.value, e.g. amount.gt.5",
							in: "query",
							name: "filter",
							schema: { type: "string" },
						},
						{ in: "query", name: "limit", schema: { default: 20, maximum: 100, minimum: 1, type: "integer" } },
						{ in: "query", name: "page", schema: { minimum: 1, type: "integer" } },
					],
					responses: { "200": { content: { "application/json": { schema } }, description: "ok" } },
					"x-entity": { action: "list", identity: "id", name: "widget" },
					"x-query": {
						filterable: [
							{ field: "amount", ops: ["eq", "gt", "lt"], type: "number" },
							{ field: "note", ops: ["eq", "is"], type: "string" },
							{ field: "tags", ops: ["contains"], type: "array" },
						],
						grammar: "postgrest",
						maxLimit: 100,
					},
				},
			},
		},
	} as OpenApiDocument
}

type CompareMode = "numeric" | "lexical"

interface StoreOptions {
	compare: CompareMode
	dropKnownMatch?: boolean
	includeKnownNonMatch?: boolean
	store: Record_[]
}

function matchesFilter(row: Record_, filter: string, compare: CompareMode): boolean {
	const isNull = /^([^.]+)\.is\.(null|notnull)$/.exec(filter)
	if (isNull !== null) {
		const field = isNull[1] as string
		const isNullValue = row[field] === null || row[field] === undefined
		return isNull[2] === "null" ? isNullValue : !isNullValue
	}
	const contains = /^([^.]+)\.contains\.(.+)$/.exec(filter)
	if (contains !== null) {
		const value = row[contains[1] as string]
		return Array.isArray(value) && value.some((item) => String(item) === contains[2])
	}
	const gt = /^([^.]+)\.gt\.(.+)$/.exec(filter)
	if (gt !== null) {
		const threshold = gt[2] as string
		const value = row[gt[1] as string]
		if (typeof value !== "number") return false
		return compare === "lexical" ? String(value) > threshold : value > Number(threshold)
	}
	return true
}

function filterStore(opts: StoreOptions, filter: string | null): Record_[] {
	const known = new Set(COHORT.map((row) => String(row["id"])))
	let rows =
		filter === null || filter === ""
			? [...opts.store]
			: opts.store.filter((row) => matchesFilter(row, filter, opts.compare))
	if (opts.dropKnownMatch === true) {
		const victim = rows.find((row) => known.has(String(row["id"])))
		if (victim !== undefined) rows = rows.filter((row) => row["id"] !== victim["id"])
	}
	if (opts.includeKnownNonMatch === true) {
		const included = new Set(rows.filter((row) => known.has(String(row["id"]))).map((row) => String(row["id"])))
		const extra = COHORT.find((row) => !included.has(String(row["id"])))
		if (extra !== undefined) rows = [...rows, extra]
	}
	return rows
}

/** The widget listing over `opts`, paged; any other route is a 404. */
function listing(opts: StoreOptions): Serve {
	return (url, method) => {
		if (method !== "GET" || url.pathname !== "/v1/widgets") return undefined
		const rows = filterStore(opts, url.searchParams.get("filter"))
		const limit = Number(url.searchParams.get("limit") ?? 20)
		const page = Number(url.searchParams.get("page") ?? 1)
		return { widgets: rows.slice((page - 1) * limit, page * limit) }
	}
}

async function judge(check: Check, opts: StoreOptions): Promise<{ findings: FindingCollector; requests: string[] }> {
	const staged = wireStage(listSpec(), "widget.list", {
		fields: { collectionKey: "widgets", identity: "id", records: COHORT },
		serve: listing(opts),
	})
	expect(check.plan(staged.ctx).ok).toBe(true)
	await runCheck(check, staged.ctx)
	return staged
}

function backendOf(findings: FindingCollector, check: Check) {
	return findings.findings.filter((finding) => finding.check === check.id && finding.verdict === "BACKEND_BUG")
}

function inconclusiveOf(findings: FindingCollector, check: Check) {
	return findings.inconclusive.filter((item) => item.check === check.id)
}

describe("filter.numeric-comparison-is-numeric against a store wider than the cohort", () => {
	const check = numericComparisonIsNumeric as Check

	it("does not treat extra matching rows outside the cohort as BACKEND_BUG", async () => {
		const { findings, requests } = await judge(check, { compare: "numeric", store: [...COHORT, ...OUTSIDE] })
		expect(requests.some((url) => url.includes("filter="))).toBe(true)
		expect(backendOf(findings, check)).toEqual([])
		expect(inconclusiveOf(findings, check)).toEqual([])
	})

	it("passes when the known matches are exactly the numeric gt subset", async () => {
		const { findings } = await judge(check, { compare: "numeric", store: [...COHORT] })
		expect(backendOf(findings, check)).toEqual([])
		expect(inconclusiveOf(findings, check)).toEqual([])
	})

	it("reports a lexical miss as BACKEND_BUG titled as text compare", async () => {
		const bugs = backendOf((await judge(check, { compare: "lexical", store: [...COHORT] })).findings, check)
		expect(bugs.length).toBeGreaterThan(0)
		expect(bugs[0]?.summary).toContain(TEXT_COMPARE)
	})

	it("does not let unknown extras hide a lexical miss", async () => {
		const { findings } = await judge(check, { compare: "lexical", store: [...COHORT, ...OUTSIDE] })
		const bugs = backendOf(findings, check)
		expect(bugs.length).toBeGreaterThan(0)
		expect(bugs[0]?.summary).toContain(TEXT_COMPARE)
	})

	it("reports a known identity that fails numeric gt but is listed", async () => {
		const { findings } = await judge(check, { compare: "numeric", includeKnownNonMatch: true, store: [...COHORT] })
		const bugs = backendOf(findings, check)
		expect(bugs.length).toBeGreaterThan(0)
		expect(bugs[0]?.summary).not.toContain(TEXT_COMPARE)
	})

	it("does not title an extras-only mismatch as a text compare", async () => {
		const store = [...COHORT, ...OUTSIDE]
		const { findings } = await judge(check, { compare: "numeric", includeKnownNonMatch: true, store })
		const bugs = backendOf(findings, check)
		expect(bugs.length).toBeGreaterThan(0)
		expect(bugs[0]?.summary).not.toContain(TEXT_COMPARE)
	})
})

describe("sibling exact-cohort filter checks", () => {
	for (const check of [filterContainsMembership, filterIsNullSelectsNulls] as Check[]) {
		it(`${check.id} ignores extra identities outside the cohort`, async () => {
			const { findings } = await judge(check, { compare: "numeric", store: [...COHORT, ...OUTSIDE] })
			expect(backendOf(findings, check)).toEqual([])
			expect(inconclusiveOf(findings, check)).toEqual([])
		})

		it(`${check.id} still fails a known miss`, async () => {
			const opts: StoreOptions = { compare: "numeric", dropKnownMatch: true, store: [...COHORT, ...OUTSIDE] }
			const { findings } = await judge(check, opts)
			expect(backendOf(findings, check).length).toBeGreaterThan(0)
		})
	}
})
