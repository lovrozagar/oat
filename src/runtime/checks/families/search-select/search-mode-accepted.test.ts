import { describe, expect, it } from "vitest"
import type { Responder } from "../../__fixtures__/harness.ts"
import { PARAMS, queryDoc, queryOf, REJECT, stage } from "../composition/__fixtures__/query-api.ts"
import { answering } from "./__fixtures__/responders.ts"
import { searchModeAccepted } from "./search-mode-accepted.ts"

/* Refuses the plain mode as unsupported and turns every other request away unread. */
const refusesPlainTurnsAwayRest: Responder = (_method, _path, options) =>
	queryOf(options)["search_mode"] === "plain" ? { status: 422 } : { status: 401 }

/* Whether the check plans with modes declared and `param` missing from the document. */
const plansWithout = (param: string): boolean =>
	stage(searchModeAccepted, {
		doc: queryDoc(
			{ searchModes: ["plain"] },
			PARAMS.filter((name) => name !== param),
		),
	}).plan().ok

const MODES = { doc: queryDoc({ searchModes: ["plain", "websearch"] }) }

describe("search.mode-accepted judges", () => {
	it("passes a backend that accepts every declared mode, probing each once", async () => {
		const staged = stage(searchModeAccepted, MODES)
		expect(await staged.run()).toEqual({ kind: "asserted" })
		expect(staged.sent.map((sent) => sent.options.query)).toEqual([
			{ limit: 5, q: "oat", search_mode: "plain" },
			{ limit: 5, q: "oat", search_mode: "websearch" },
		])
	})

	it("reports a declared mode the backend refuses as a document defect", async () => {
		const staged = stage(searchModeAccepted, { ...MODES, respond: answering("search_mode", "websearch", REJECT) })
		expect(await staged.run()).toEqual({ kind: "finding", verdict: "SPEC_BUG" })
		const [finding] = staged.findings.findings
		expect(finding?.summary).toBe("a declared search mode is rejected")
		expect(finding?.detail).toBe("rejected: websearch (400).")
		expect(finding?.evidence).toHaveLength(1)
	})

	it("reports a refusal even beside a mode turned away without a verdict", async () => {
		const mixed = stage(searchModeAccepted, { ...MODES, respond: refusesPlainTurnsAwayRest })
		expect(await mixed.run()).toEqual({ kind: "finding", verdict: "SPEC_BUG" })
		expect(mixed.findings.findings[0]?.detail).toBe("rejected: plain (422).")
	})

	it("is unresolved when every probe is turned away before the mode is consulted", async () => {
		const staged = stage(searchModeAccepted, { ...MODES, respond: () => ({ status: 403 }) })
		expect(await staged.run()).toEqual({
			kind: "unresolved",
			reason: "probes were turned away without a verdict: plain (403), websearch (403)",
		})
	})
})

describe("search.mode-accepted plans", () => {
	it("stands down without declared modes, a mode parameter, or a search parameter", async () => {
		const undeclared = stage(searchModeAccepted)
		expect(await undeclared.run()).toEqual({
			kind: "stood-down",
			reason: "declared searchModes and a search-mode parameter",
		})
		expect(plansWithout("search_mode")).toBe(false)
		expect(plansWithout("q")).toBe(false)
		expect(stage(searchModeAccepted, { doc: queryDoc({ searchModes: [] }) }).plan().ok).toBe(false)
	})

	it("probes nothing when run without declared modes", async () => {
		const staged = stage(searchModeAccepted)
		expect(await searchModeAccepted.run(staged.ctx, undefined)).toEqual({ kind: "asserted" })
		expect(staged.sent).toEqual([])
	})
})
