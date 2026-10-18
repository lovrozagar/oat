import { describe, expect, it } from "vitest"
import type { Finding } from "../../runtime/finding.ts"
import type { Outcome, Post } from "./backend.ts"
import * as judge from "./judges.ts"

const CREATE = "create.unique-conflict-rejected"
const UPDATE = "update.unique-conflict-rejected"

function finding(check: string, verdict: string, extra: Partial<Finding> = {}): Finding {
	return {
		check,
		detail: `${verdict} on ${check}`,
		entity: "widget",
		evidence: [],
		summary: "s",
		verdict: verdict as Finding["verdict"],
		...extra,
	}
}

function outcome(result: Partial<Outcome["result"]> = {}, posts: Post[] = []): Outcome {
	return { posts, result: { checksRun: [], entitiesTested: [], findings: [], ...result } }
}

const bug = (check: string): Finding => finding(check, "BACKEND_BUG")
const keyed = (key?: string): Post => ({ body: {}, headers: key === undefined ? {} : { "idempotency-key": key } })

describe("checks that must not run", () => {
	it("pass while absent and fail once run", () => {
		expect(judge.untaggedNotProbed(outcome())).toEqual({ detail: "absent from checksRun", ok: true })
		expect(judge.untaggedNotProbed(outcome({ checksRun: [CREATE] }))).toEqual({ detail: `${CREATE} ran`, ok: false })
		expect(judge.createNotProbed(outcome({ checksRun: [CREATE] }))).toEqual({ detail: "ran", ok: false })
		expect(judge.updateNotProbed(outcome())).toEqual({ detail: "skipped", ok: true })
		expect(judge.updateNotProbed(outcome({ checksRun: [UPDATE] }))).toEqual({ detail: "ran", ok: false })
		expect(judge.noneProbed(outcome())).toEqual({ detail: "absent", ok: true })
		expect(judge.noneProbed(outcome({ checksRun: [UPDATE] }))).toEqual({ detail: "ran", ok: false })
	})
})

describe("duplicates", () => {
	it("refused: ran with no root cause", () => {
		expect(judge.duplicateRefused(outcome({ checksRun: [CREATE] }))).toEqual({ detail: "ran=true bugs=none", ok: true })
		const gap = finding(CREATE, "COVERAGE_GAP")
		expect(judge.duplicateRefused(outcome({ findings: [bug(CREATE), gap] }))).toEqual({
			detail: "ran=false bugs=BACKEND_BUG",
			ok: false,
		})
	})

	it("inserted: the bug's detail, or every finding when there is none", () => {
		expect(judge.duplicateInserted(outcome({ findings: [bug(CREATE)] }))).toEqual({
			detail: `BACKEND_BUG on ${CREATE}`,
			ok: true,
		})
		expect(judge.duplicateInserted(outcome())).toEqual({ detail: "no finding", ok: false })
		expect(judge.duplicateInserted(outcome({ findings: [finding("a.b", "AMBIGUITY")] }))).toEqual({
			detail: "AMBIGUITY:a.b",
			ok: false,
		})
		expect(judge.oneSetInserted(outcome())).toEqual({ detail: "no BACKEND_BUG", ok: false })
	})

	it("a list that grew is a finding", () => {
		expect(judge.listKept(outcome())).toEqual({ detail: "no growth finding", ok: true })
		const grew = finding(CREATE, "BACKEND_BUG", { summary: "list grew" })
		expect(judge.listKept(outcome({ findings: [grew] }))).toEqual({ detail: "cardinality finding", ok: false })
	})

	it("updates score like creates", () => {
		expect(judge.updateRefused(outcome({ checksRun: [UPDATE] }))).toEqual({ detail: "ran=true bug=none", ok: true })
		expect(judge.updateRefused(outcome({ checksRun: [UPDATE], findings: [bug(UPDATE)] }))).toEqual({
			detail: `ran=true bug=BACKEND_BUG on ${UPDATE}`,
			ok: false,
		})
		expect(judge.updateApplied(outcome())).toEqual({ detail: "no finding", ok: false })
		expect(judge.updateApplied(outcome({ findings: [bug(UPDATE)] })).ok).toBe(true)
	})

	it("a gate or a plan limit is a gap, never a pass or a bug", () => {
		const gap = finding(CREATE, "COVERAGE_GAP")
		expect(judge.coverageNotPass(outcome({ findings: [gap] }))).toEqual({
			detail: "bug=none gap=COVERAGE_GAP",
			ok: true,
		})
		expect(judge.coverageNotPass(outcome({ findings: [bug(CREATE)] }))).toEqual({
			detail: "bug=BACKEND_BUG gap=none",
			ok: false,
		})
	})

	it("distinct values still insert", () => {
		const ok = judge.distinctInserted(outcome({ entitiesTested: ["widget"] }))
		expect(ok).toEqual({ detail: "bugs=none entities=widget", ok: true })
		const bugs = outcome({ entitiesTested: [], findings: [bug(UPDATE), finding(CREATE, "BLOCKED"), bug("read.x")] })
		expect(judge.distinctInserted(bugs)).toEqual({ detail: `bugs=${UPDATE} entities=`, ok: false })
	})
})

describe("freshKey", () => {
	const run = { checksRun: [CREATE] }

	it("passes a probe that omits the key or sends a new one", () => {
		expect(judge.freshKey(outcome(run, [keyed("k1"), keyed("k2"), keyed()]))).toEqual({
			detail: "fresh or omitted",
			ok: true,
		})
		expect(judge.freshKey(outcome(run, [keyed(), keyed("k1")])).ok).toBe(true)
		expect(judge.freshKey(outcome(run, [keyed(""), keyed("")])).ok).toBe(true)
		expect(judge.freshKey(outcome({}, [])).ok).toBe(false)
	})

	it("fails a probe that resends the seed's key", () => {
		expect(judge.freshKey(outcome(run, [keyed("k1"), keyed("k1")]))).toEqual({ detail: "reused seed key", ok: false })
	})
})

describe("driftReported", () => {
	it("names the drift's verdict, or every check that did fire", () => {
		const drift = finding("schema.error-response-matches-document", "BACKEND_BUG")
		expect(judge.driftReported(outcome({ findings: [drift] }))).toEqual({ detail: "BACKEND_BUG", ok: true })
		expect(judge.driftReported(outcome())).toEqual({ detail: "none", ok: false })
		expect(judge.driftReported(outcome({ findings: [bug(CREATE)] }))).toEqual({ detail: CREATE, ok: false })
	})
})

const seed = (verdict: string, detail: string): Finding => finding("world.seed", verdict, { detail })

describe("the seed", () => {
	const adopted = seed("COVERAGE_GAP", "409 under x-unique")

	it("adopts a tagged 409 against a listed widget", () => {
		expect(judge.seedAdopted(outcome({ findings: [adopted] }))).toEqual({
			detail: "seed=COVERAGE_GAP 409 under x-unique",
			ok: true,
		})
		expect(judge.seedAdopted(outcome())).toEqual({ detail: "seed=none ", ok: false })
		expect(judge.seedAdopted(outcome({ findings: [seed("COVERAGE_GAP", "other")] })).ok).toBe(false)
		const elsewhere = finding("world.seed", "COVERAGE_GAP", { detail: "x-unique", entity: "gadget" })
		expect(judge.seedAdopted(outcome({ findings: [elsewhere] })).ok).toBe(false)
	})

	it("keeps probing after an adopt, and never counts the seed as the probe", () => {
		expect(judge.probedAfterAdopt(outcome({ checksRun: [CREATE] }))).toEqual({ detail: "ran", ok: true })
		expect(judge.probedAfterAdopt(outcome({ checksRun: ["a", "b"] }))).toEqual({ detail: "checksRun=a,b", ok: false })
		expect(judge.seedNotEvidence(outcome({ findings: [bug(CREATE)] }))).toEqual({
			detail: "seed is not unique-check evidence",
			ok: true,
		})
		expect(judge.seedNotEvidence(outcome({ findings: [finding(CREATE, "COVERAGE_GAP")] }))).toEqual({
			detail: "scored seed as unique pass",
			ok: false,
		})
	})

	it("blocks a seed it could not adopt, and never adopts without a tag", () => {
		expect(judge.seedBlocked(outcome({ findings: [seed("BLOCKED", "409")] }))).toEqual({
			detail: "seed=BLOCKED 409",
			ok: true,
		})
		expect(judge.seedBlocked(outcome()).ok).toBe(false)
		expect(judge.untaggedNotAdopted(outcome({ findings: [seed("BLOCKED", "409")] }))).toEqual({
			detail: "not unique-adopt",
			ok: true,
		})
		expect(judge.untaggedNotAdopted(outcome({ findings: [adopted] }))).toEqual({
			detail: "adopted without a tag",
			ok: false,
		})
	})
})
