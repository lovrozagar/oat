import { describe, expect, it } from "vitest"
import type { Record_ } from "../../../world.ts"
import type { Responder } from "../../__fixtures__/harness.ts"
import { PARAMS, queryDoc, REJECT, stage } from "../composition/__fixtures__/query-api.ts"
import { projecting } from "./__fixtures__/responders.ts"
import { selectRequestedFieldsPresent } from "./select-requested-fields-present.ts"

/* The projection with `field` left out of every record. */
const dropping = (field: string): Responder => projecting(({ [field]: _dropped, ...rest }: Record_) => rest)

/* An empty listing, whatever is asked. */
const empty: Responder = () => ({ body: [], status: 200 })

describe("select.requested-fields-present judges", () => {
	it("passes a projection carrying the identity and the first two selectable fields", async () => {
		const staged = stage(selectRequestedFieldsPresent)
		expect(await staged.run()).toEqual({ kind: "asserted" })
		expect(staged.sent.map((sent) => sent.options.query)).toEqual([{ limit: 5, select: "id,title,status" }])
	})

	it("fails a projection that leaves out a requested field", async () => {
		const staged = stage(selectRequestedFieldsPresent, { respond: dropping("status") })
		expect(await staged.run()).toEqual({ kind: "finding", verdict: "BACKEND_BUG" })
		const [finding] = staged.findings.findings
		expect(finding?.summary).toBe("a requested select field is missing from the projection")
		expect(finding?.detail).toBe("select=id,title,status omitted status.")
	})

	it("fails a missing identity the document lists as selectable", async () => {
		const staged = stage(selectRequestedFieldsPresent, { respond: dropping("id") })
		expect(await staged.run()).toEqual({ kind: "finding", verdict: "BACKEND_BUG" })
		expect(staged.findings.findings[0]?.detail).toBe("select=id,title,status omitted id.")
	})

	it("leaves a missing identity unresolved when it is not selectable", async () => {
		const staged = stage(selectRequestedFieldsPresent, {
			doc: queryDoc({ selectable: ["title", "status"] }),
			respond: dropping("id"),
		})
		expect(await staged.run()).toEqual({
			kind: "unresolved",
			reason: "identity was omitted from select and missing from items",
		})
	})
})

describe("select.requested-fields-present gives up", () => {
	it("is unresolved when the probe is refused or empty", async () => {
		const reason = "select probe was rejected or empty"
		expect(await stage(selectRequestedFieldsPresent, { respond: () => REJECT }).run()).toEqual({
			kind: "unresolved",
			reason,
		})
		expect(await stage(selectRequestedFieldsPresent, { respond: empty }).run()).toEqual({ kind: "unresolved", reason })
	})

	it("leaves a missing identity unresolved when run with no declared query", async () => {
		const staged = stage(selectRequestedFieldsPresent, { fields: { query: null }, respond: dropping("id") })
		const plan = { projection: { select: "id,title" }, requested: ["id", "title"] }
		expect(await selectRequestedFieldsPresent.run(staged.ctx, plan)).toEqual({
			kind: "unresolved",
			reason: "identity was omitted from select and missing from items",
		})
	})
})

describe("select.requested-fields-present plans", () => {
	it("stands down without a select parameter or a selectable field", async () => {
		const noParam = stage(selectRequestedFieldsPresent, {
			doc: queryDoc(
				{},
				PARAMS.filter((name) => name !== "select"),
			),
		})
		expect(await noParam.run()).toEqual({
			kind: "stood-down",
			reason: "a select parameter and at least one selectable field",
		})
		expect(stage(selectRequestedFieldsPresent, { doc: queryDoc({ selectable: [] }) }).plan().ok).toBe(false)
		expect(stage(selectRequestedFieldsPresent, { fields: { query: null } }).plan().ok).toBe(false)
	})
})
