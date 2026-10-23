import { describe, expect, it } from "vitest"
import { exchange } from "../__fixtures__/harness.ts"
import { notesContext } from "../query/__fixtures__/notes.ts"
import {
	STORED_FIELDS_UNKNOWN,
	standDownForFeatureGate,
	standDownForRateLimit,
	storedFieldsUnknown,
} from "./stand-down.ts"

/*
 * Two answers a check that needed a success stands down on instead of judging: a feature gate the
 * document declares, refused as documented, and a rate limit that outlasted the client's retries.
 */

const GATE_BODY = { vars: { current_plan: "free", feature: "exports", type: "feature_gate" } }

describe("standDownForFeatureGate", () => {
	it("stands down with a named gap on the 403 a declared gate documents", () => {
		const { ctx, findings } = notesContext()
		const gated = { ...ctx.listOp, featureGate: "exports" }
		expect(standDownForFeatureGate(ctx, gated, exchange("GET", "/notes", { body: GATE_BODY, status: 403 }), "c")).toBe(
			true,
		)
		expect(findings.findings).toHaveLength(1)
		expect(findings.findings[0]).toMatchObject({
			check: "c",
			summary: "note.list did not apply",
			verdict: "COVERAGE_GAP",
		})
		expect(findings.findings[0]?.detail).toContain("x-feature-gate: exports (current_plan: free, feature: exports)")
	})

	it("does not stand down without an operation, a declared gate, or the gate's own refusal", () => {
		const { ctx, findings } = notesContext()
		const denial = exchange("GET", "/notes", { body: GATE_BODY, status: 403 })
		expect(standDownForFeatureGate(ctx, undefined, denial, "c")).toBe(false)
		expect(standDownForFeatureGate(ctx, ctx.listOp, denial, "c")).toBe(false)
		const gated = { ...ctx.listOp, featureGate: "exports" }
		expect(standDownForFeatureGate(ctx, gated, exchange("GET", "/notes", { body: {}, status: 403 }), "c")).toBe(false)
		expect(findings.findings).toEqual([])
	})
})

describe("standDownForRateLimit", () => {
	it("leaves the check unresolved on a 429, and does nothing otherwise", () => {
		const { ctx, findings } = notesContext()
		expect(standDownForRateLimit(ctx, exchange("GET", "/notes", { status: 200 }), "c")).toBe(false)
		expect(findings.inconclusive).toEqual([])
		expect(standDownForRateLimit(ctx, exchange("GET", "/notes", { status: 429 }), "c")).toBe(true)
		expect(findings.inconclusive).toEqual([
			{
				check: "c",
				entity: "note",
				reason: "the request was rate-limited (429) after retries, so this check could not complete",
			},
		])
	})
})

describe("storedFieldsUnknown", () => {
	it("stands down on records oat sent and never read back, and on nothing else", () => {
		const { ctx } = notesContext()
		expect(storedFieldsUnknown(ctx)).toBeUndefined()
		expect(storedFieldsUnknown({ ...ctx, recordsUnverified: true })).toEqual({
			needs: STORED_FIELDS_UNKNOWN,
			ok: false,
		})
		expect(STORED_FIELDS_UNKNOWN).toMatch(/^records read back from the server/)
	})
})
