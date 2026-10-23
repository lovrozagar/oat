import { describe, expect, it } from "vitest"
import type { Record_ } from "../../../world/records.ts"
import type { Responder } from "../../__fixtures__/harness.ts"
import { wireStage } from "../../__fixtures__/wire.ts"
import { runCheck } from "../../core/run.ts"
import type { OpenApiDocument } from "../../../../spec/types.ts"
import { backend, NOTES, PARAMS, queryDoc, queryOf, REJECT, stage } from "../composition/__fixtures__/query-api.ts"
import { sortMultiKeyTiebreak } from "./sort-multi-key-tiebreak.ts"

/* Applies only the first sort key; ties keep their stored order. */
const firstKeyOnly: Responder = (method, path, options) => {
	const query = queryOf(options)
	return backend()(method, path, { query: { ...query, order: query.order?.split(",")[0] } })
}

/* Shows only one of the rows tied on status "open". */
const hidingTies: Responder = (method, path, options) =>
	backend(NOTES.filter((row) => row.id !== "n2" && row.id !== "n4"))(method, path, options)

const noJoin = { sortGrammar: { asc: "asc", desc: "desc", join: null, term: "{field}:{direction}" } }

describe("sort.multi-key-tiebreak judges", () => {
	it("passes a backend that orders ties by the second key", async () => {
		const staged = stage(sortMultiKeyTiebreak)
		expect(await staged.run()).toEqual({ kind: "asserted" })
		expect(staged.sent.map((sent) => sent.options.query?.order)).toEqual(["status.asc,title.desc"])
	})

	it("fails a backend that ignores the second key", async () => {
		const staged = stage(sortMultiKeyTiebreak, { respond: firstKeyOnly })
		expect(await staged.run()).toEqual({ kind: "finding", verdict: "BACKEND_BUG" })
		expect(staged.findings.findings[0]).toMatchObject({
			detail: 'order=status.asc,title.desc left ties on "status" unordered by "title".',
			summary: "the second sort key is not applied on ties",
		})
	})

	it("is unresolved when the multi-key order is refused", async () => {
		const staged = stage(sortMultiKeyTiebreak, { respond: () => REJECT })
		expect(await staged.run()).toEqual({ kind: "unresolved", reason: "multi-key order was rejected" })
	})

	it("is unresolved when the listing does not show the tie", async () => {
		const staged = stage(sortMultiKeyTiebreak, { respond: hidingTies })
		expect(await staged.run()).toEqual({
			kind: "unresolved",
			reason: "the listing does not show rows tied on status",
		})
	})

	it("is unresolved when run against a grammar that sorts by one key", async () => {
		const planned = sortMultiKeyTiebreak.plan(stage(sortMultiKeyTiebreak).ctx)
		const single = stage(sortMultiKeyTiebreak, { doc: queryDoc(noJoin) })
		if (!planned.ok) throw new Error("the default cohort has a multi-key pair")
		expect(await sortMultiKeyTiebreak.run(single.ctx, planned.value)).toEqual({
			kind: "unresolved",
			reason: "the grammar sorts by one key only",
		})
	})
})

describe("sort.multi-key-tiebreak plans", () => {
	it("pairs the first field with ties and a second that differs within them", () => {
		const plan = sortMultiKeyTiebreak.plan(stage(sortMultiKeyTiebreak, { doc: queryDoc({ sort: { maxKeys: 3 } }) }).ctx)
		expect(plan).toMatchObject({ ok: true, value: { primary: "status", secondary: "title" } })
		expect(plan.ok && plan.value.tied.map((row) => row.id)).toEqual(["n1", "n2", "n4"])
	})

	it("passes over the identity, rows missing a key, and ties that agree on the second key", () => {
		const rows: Record_[] = [
			{ id: "a", status: "open", title: "same" },
			{ id: "b", status: "open", title: "same" },
			{ id: "c", status: "open" },
			{ id: "d", rank: 1, status: "shut" },
			{ id: "e", rank: 2, status: "shut" },
		]
		const doc = queryDoc({ sortable: ["status", "id", "title", "rank"] })
		const plan = stage(sortMultiKeyTiebreak, { doc, rows }).plan()
		expect(plan).toMatchObject({ ok: true, value: { primary: "status", secondary: "rank" } })
	})

	it("stands down without an order parameter, with one key allowed, or without a tie", async () => {
		const unordered = queryDoc(
			{},
			PARAMS.filter((name) => name !== "order"),
		)
		expect(stage(sortMultiKeyTiebreak, { doc: unordered }).plan().ok).toBe(false)
		expect(stage(sortMultiKeyTiebreak, { doc: queryDoc({ sort: { maxKeys: 1 } }) }).plan().ok).toBe(false)
		expect(stage(sortMultiKeyTiebreak, { fields: { query: null } }).plan().ok).toBe(false)
		const distinct = stage(sortMultiKeyTiebreak, { rows: NOTES.slice(0, 1) })
		expect(await distinct.run()).toEqual({
			kind: "stood-down",
			reason: "two sortable fields and rows that tie on the first and differ on the second",
		})
	})

	it("needs a grammar that joins keys", () => {
		expect(stage(sortMultiKeyTiebreak, { doc: queryDoc(noJoin) }).plan()).toEqual({
			needs: "a sort grammar that joins keys",
			ok: false,
		})
	})
})

/*
 * A field a listing does not carry is no value to tie on. A public listing declared `created_at`
 * sortable but left it out of every row; oat read the rows as tied on it and blamed the second
 * key for an order the server took from a `created_at` it never showed (prod, 2026-10-16).
 */

const PROFILES: Record_[] = [
	{ handle: "a", updated_at: 100 },
	{ handle: "b", updated_at: 300 },
	{ handle: "c", updated_at: 200 },
]

function profilesDoc(): OpenApiDocument {
	const item = { properties: { handle: { type: "string" }, updated_at: { type: "integer" } }, type: "object" }
	const schema = { properties: { profiles: { items: item, type: "array" } }, type: "object" }
	return {
		info: { title: "profiles", version: "1" },
		openapi: "3.1.0",
		paths: {
			"/v1/profiles": {
				get: {
					operationId: "profile.list",
					parameters: [
						{ in: "query", name: "order", schema: { type: "string" } },
						{ in: "query", name: "limit", schema: { default: 50, maximum: 100, minimum: 1, type: "integer" } },
					],
					responses: { "200": { content: { "application/json": { schema } }, description: "ok" } },
					"x-entity": { action: "list", identity: "handle", name: "profile" },
					"x-query": { grammar: "postgrest", maxLimit: 100, sortable: ["created_at", "updated_at"] },
				},
			},
		},
	} as unknown as OpenApiDocument
}

describe("sort.multi-key-tiebreak on a field the rows do not carry", () => {
	it("does not read the missing field as a tie", async () => {
		/* Sorted by a creation time the rows do not show: whatever order is asked, this one comes back. */
		const { ctx, findings } = wireStage(profilesDoc(), "profile.list", {
			fields: { collectionKey: "profiles", identity: "handle", records: PROFILES.map((row) => ({ ...row })) },
			serve: () => ({ profiles: PROFILES }),
		})
		await runCheck(sortMultiKeyTiebreak, ctx)
		expect(findings.findings.map((finding) => `${finding.check}: ${finding.summary}`)).toEqual([])
	})
})
