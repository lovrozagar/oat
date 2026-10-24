import { describe, expect, it } from "vitest"
import type { Responder } from "../../__fixtures__/harness.ts"
import { PARAMS, queryDoc, REJECT, stage } from "../composition/__fixtures__/query-api.ts"
import { ignoring } from "./__fixtures__/responders.ts"
import { selectProjection } from "./select-projection-honored.ts"

/* An empty listing, whatever is asked. */
const empty: Responder = () => ({ body: [], status: 200 })

describe("select.projection-honored judges", () => {
	it("passes a backend that returns only the requested fields", async () => {
		const staged = stage(selectProjection)
		expect(staged.plan()).toEqual({
			ok: true,
			value: { projection: { select: "id,title" }, requested: ["id", "title"] },
		})
		expect(await staged.run()).toEqual({ kind: "asserted" })
		expect(staged.sent.map((sent) => sent.options.query)).toEqual([{ limit: 5, select: "id,title" }])
	})

	it("fails a sparse fieldset that is accepted and ignored", async () => {
		const staged = stage(selectProjection, { respond: ignoring("select") })
		expect(await staged.run()).toEqual({ kind: "finding", verdict: "BACKEND_BUG" })
		const [finding] = staged.findings.findings
		expect(finding?.summary).toBe("sparse fieldset is accepted but ignored")
		expect(finding?.detail).toContain("select=id,title returned 6 fields, including author, rank, score, status")
	})

	it("asks for the identity alone when nothing else is selectable", async () => {
		const staged = stage(selectProjection, { doc: queryDoc({ selectable: ["id"] }) })
		expect(await staged.run()).toEqual({ kind: "asserted" })
		expect(staged.sent[0]?.options.query?.["select"]).toBe("id")
		expect(stage(selectProjection, { fields: { query: null } }).plan()).toMatchObject({
			value: { requested: ["id"] },
		})
	})
})

describe("select.projection-honored gives up", () => {
	it("is unresolved when the projected listing is refused or empty", async () => {
		const reason = "the projected listing was rejected or empty"
		expect(await stage(selectProjection, { respond: () => REJECT }).run()).toEqual({ kind: "unresolved", reason })
		expect(await stage(selectProjection, { respond: empty }).run()).toEqual({ kind: "unresolved", reason })
	})
})

describe("select.projection-honored plans", () => {
	it("stands down without a select parameter or a seeded record", async () => {
		const noParam = stage(selectProjection, {
			doc: queryDoc(
				{},
				PARAMS.filter((name) => name !== "select"),
			),
		})
		expect(await noParam.run()).toEqual({ kind: "stood-down", reason: "a `select` sparse-fieldset parameter" })
		expect(noParam.sent).toEqual([])
		expect(stage(selectProjection, { rows: [] }).plan().ok).toBe(false)
	})
})
