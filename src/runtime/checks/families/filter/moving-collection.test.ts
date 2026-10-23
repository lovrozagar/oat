import { describe, expect, it } from "vitest"
import type { OpenApiDocument } from "../../../../spec/types.ts"
import type { Record_ } from "../../../world/records.ts"
import { type Serve, wireStage } from "../../__fixtures__/wire.ts"
import type { Check } from "../../core/check.ts"
import { runCheck } from "../../core/run.ts"
import { filterAliasMatchesCanonical } from "./filter-alias-matches-canonical.ts"
import { filterInIsUnionOfEq } from "./filter-in-is-union-of-eq.ts"
import { filterIsNullSelectsNulls } from "./filter-is-null-selects-nulls.ts"
import { filterNinComplementsIn } from "./filter-nin-complements-in.ts"
import { filterOrderedTriplePartitions } from "./filter-ordered-triple-partitions.ts"

/*
 * Checks run side by side, and one may change a record while another reads the collection term
 * by term. A full prod run read `category.ne.general` (0 rows), then another check moved a row
 * into another category, then read `category.neq.general` (1 row), and reported the alias as
 * broken. A filter check that compares several reads must read again before blaming the backend:
 * when the same read now holds other rows, the collection moved, and nothing is concluded.
 */

const COHORT: Record_[] = [
	{ amount: 1, category: "general", id: "w1", note: "a" },
	{ amount: 5, category: "general", id: "w2", note: null },
	{ amount: 9, category: "special", id: "w3", note: "c" },
]

/* One filter term against one field: the stored value, the raw operand, its list and number forms. */
type Term = { list: string[]; number: number; raw: string; value: unknown }

const OPERATORS: Readonly<Record<string, (term: Term) => boolean>> = {
	eq: ({ raw, value }) => String(value) === raw,
	gt: ({ number, value }) => typeof value === "number" && value > number,
	gte: ({ number, value }) => typeof value === "number" && value >= number,
	in: ({ list, value }) => list.includes(String(value)),
	is: ({ raw, value }) => (raw === "null" ? value === null : value !== null),
	lt: ({ number, value }) => typeof value === "number" && value < number,
	lte: ({ number, value }) => typeof value === "number" && value <= number,
	ne: ({ raw, value }) => value !== null && String(value) !== raw,
	neq: ({ raw, value }) => value !== null && String(value) !== raw,
	nin: ({ list, value }) => value !== null && !list.includes(String(value)),
}

function matches(row: Record_, term: string): boolean {
	const match = /^([a-z]+)\.([a-z]+)\.(.*)$/.exec(term)
	if (match === null) return true
	const [, field = "", op = "", raw = ""] = match
	const operator = Object.hasOwn(OPERATORS, op) ? OPERATORS[op] : undefined
	if (operator === undefined) return false
	return operator({ list: raw.replace(/^\(|\)$/g, "").split(","), number: Number(raw), raw, value: row[field] })
}

/* A record another check made for itself, outside the cohort, that it is about to change. */
const SCRATCH: Record_ = { amount: 7, category: "general", id: "s1", note: "x" }

/* A correct backend, and one other writer: right after the first filtered read it moves its row. */
type Move = "update" | "create" | "delete"

function moving(after: number, move: Move): Serve {
	const store = [...COHORT, SCRATCH].map((row) => ({ ...row }))
	let filtered = 0
	return (url) => {
		const filter = url.searchParams.get("filter")
		const rows = filter === null ? store : store.filter((row) => matches(row, filter))
		const body = { widgets: rows.map((row) => ({ ...row })) }
		if (filter !== null && ++filtered === after) {
			const at = store.findIndex((row) => row["id"] === "s1")
			if (move === "update") Object.assign(store[at] ?? {}, { amount: 70, category: "special", note: null })
			if (move === "create") store.push({ amount: 3, category: "general", id: "s2", note: null })
			if (move === "delete") store.splice(at, 1)
		}
		return body
	}
}

function movingDoc(): OpenApiDocument {
	const item = {
		properties: {
			amount: { type: "integer" },
			category: { type: "string" },
			id: { type: "string" },
			note: { type: ["string", "null"] },
		},
		required: ["id"],
		type: "object",
	}
	const ops = ["eq", "ne", "neq", "in", "nin", "gt", "lt", "gte", "lte", "is"]
	const schema = { properties: { widgets: { items: item, type: "array" } }, type: "object" }
	return {
		info: { title: "moving", version: "1" },
		openapi: "3.1.0",
		paths: {
			"/v1/widgets": {
				get: {
					operationId: "widget.list",
					parameters: [
						{ in: "query", name: "filter", schema: { type: "string" } },
						{ in: "query", name: "limit", schema: { default: 50, maximum: 100, minimum: 1, type: "integer" } },
					],
					responses: { "200": { content: { "application/json": { schema } }, description: "ok" } },
					"x-entity": { action: "list", identity: "id", name: "widget" },
					"x-query": {
						aliases: { ne: "neq" },
						filterable: [
							{ field: "category", ops, type: "string" },
							{ field: "amount", ops, type: "number" },
							{ field: "note", ops, type: "string" },
						],
						grammar: "postgrest",
						maxLimit: 100,
					},
				},
			},
		},
	} as unknown as OpenApiDocument
}

async function judge(check: Check, after: number, move: Move): Promise<string[]> {
	const { ctx, findings } = wireStage(movingDoc(), "widget.list", {
		fields: { collectionKey: "widgets", records: COHORT.map((row) => ({ ...row })) },
		serve: moving(after, move),
	})
	await runCheck(check, ctx)
	return findings.findings.map((finding) => `${finding.check}: ${finding.summary}`)
}

describe("a filter check whose collection moves between its reads", () => {
	for (const check of [
		filterAliasMatchesCanonical,
		filterInIsUnionOfEq,
		filterNinComplementsIn,
		filterOrderedTriplePartitions,
		filterIsNullSelectsNulls,
	] as Check[]) {
		for (const move of ["update", "create", "delete"] as const) {
			for (const after of [1, 2, 3]) {
				it(`${check.id} blames nothing on the backend after a ${move} following read ${after}`, async () => {
					expect(await judge(check, after, move)).toEqual([])
				})
			}
		}
	}
})
