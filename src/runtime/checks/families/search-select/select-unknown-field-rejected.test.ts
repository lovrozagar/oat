import { describe, expect, it } from "vitest"
import type { Responder } from "../../__fixtures__/harness.ts"
import { NOTES, PARAMS, queryDoc, stage } from "../composition/__fixtures__/query-api.ts"
import { selectUnknownFieldRejected } from "./select-unknown-field-rejected.ts"

const UNKNOWN = "oat_no_such_select_xyz"
const policy = (unknown: string) => ({ doc: queryDoc({ select: { unknown } }) })

/* Serves the identity and drops a field it does not know: the ignore policy, followed. */
const dropsUnknown: Responder = () => ({ body: NOTES.map((row) => ({ id: row["id"] })), status: 200 })

/* Echoes the undeclared name back as a field. */
const echoesUnknown: Responder = () => ({ body: NOTES.map((row) => ({ id: row["id"], [UNKNOWN]: null })), status: 200 })

/* An empty listing, whatever is asked. */
const empty: Responder = () => ({ body: [], status: 200 })

describe("select.unknown-field-rejected under reject", () => {
	it("passes a backend that refuses an undeclared field as invalid", async () => {
		const staged = stage(selectUnknownFieldRejected, policy("reject"))
		expect(await staged.run()).toEqual({ kind: "asserted" })
		expect(staged.sent.map((sent) => sent.options.query)).toEqual([{ limit: 5, select: `id,${UNKNOWN}` }])
	})

	it("fails an undeclared field that is accepted", async () => {
		const staged = stage(selectUnknownFieldRejected, { ...policy("reject"), respond: dropsUnknown })
		expect(await staged.run()).toEqual({ kind: "finding", verdict: "BACKEND_BUG" })
		expect(staged.findings.findings[0]?.summary).toBe("unknown select field was not rejected")
		expect(staged.findings.findings[0]?.detail).toBe("select.unknown=reject but the probe returned 200.")
	})

	it("fails a crash and leaves an unrelated refusal unresolved", async () => {
		const crashed = stage(selectUnknownFieldRejected, { ...policy("reject"), respond: () => ({ status: 500 }) })
		expect(await crashed.run()).toEqual({ kind: "finding", verdict: "BACKEND_BUG" })
		const forbidden = stage(selectUnknownFieldRejected, { ...policy("reject"), respond: () => ({ status: 403 }) })
		expect(await forbidden.run()).toMatchObject({ kind: "unresolved" })
	})
})

describe("select.unknown-field-rejected under ignore", () => {
	it("passes a backend that drops the undeclared field, or lists nothing", async () => {
		expect(await stage(selectUnknownFieldRejected, { ...policy("ignore"), respond: dropsUnknown }).run()).toEqual({
			kind: "asserted",
		})
		expect(await stage(selectUnknownFieldRejected, { ...policy("ignore"), respond: empty }).run()).toEqual({
			kind: "asserted",
		})
	})

	it("fails a backend that returns the undeclared field", async () => {
		const staged = stage(selectUnknownFieldRejected, { ...policy("ignore"), respond: echoesUnknown })
		expect(await staged.run()).toEqual({ kind: "finding", verdict: "BACKEND_BUG" })
		expect(staged.findings.findings[0]?.summary).toBe("unknown select field was honored under ignore")
	})

	it("is unresolved when the undeclared field is refused after all", async () => {
		expect(await stage(selectUnknownFieldRejected, policy("ignore")).run()).toEqual({
			kind: "unresolved",
			reason: "unknown select field was rejected under ignore",
		})
	})
})

describe("select.unknown-field-rejected plans", () => {
	it("stands down without a declared policy or a select parameter", async () => {
		const undeclared = stage(selectUnknownFieldRejected)
		expect(await undeclared.run()).toEqual({ kind: "stood-down", reason: "`select.unknown` declared" })
		expect(undeclared.sent).toEqual([])
		const noParam = stage(selectUnknownFieldRejected, {
			doc: queryDoc(
				{ select: { unknown: "reject" } },
				PARAMS.filter((name) => name !== "select"),
			),
		})
		expect(noParam.plan().ok).toBe(false)
	})
})
