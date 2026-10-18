/** How the unique suite judges what one run saw: each judge is one result the suite reports. */

import { type Finding, isRootCause } from "../../runtime/finding.ts"
import type { Outcome } from "./backend.ts"

export interface Verdict {
	ok: boolean
	detail: string
}

const CREATE = "create.unique-conflict-rejected"
const UPDATE = "update.unique-conflict-rejected"

type Result = Outcome["result"]

function found(result: Result, check: string, verdict: string): Finding | undefined {
	return result.findings.find((f) => f.check === check && f.verdict === verdict)
}

function seedOf(result: Result): Finding | undefined {
	return result.findings.find((f) => f.check === "world.seed" && f.entity === "widget")
}

function seedDetail(seed: Finding | undefined): string {
	return `seed=${seed?.verdict ?? "none"} ${seed?.detail ?? ""}`
}

/** A check that must not run: `ok` while it is absent, said as `[ran, absent]`. */
function absent(ran: boolean, [yes, no]: [string, string]): Verdict {
	return { detail: ran ? yes : no, ok: !ran }
}

/** A BACKEND_BUG on `check` that must be found: its detail, or `missing` when it is not. */
function bug(result: Result, check: string, missing: () => string): Verdict {
	const hit = found(result, check, "BACKEND_BUG")
	return { detail: hit === undefined ? missing() : hit.detail, ok: hit !== undefined }
}

export function untaggedNotProbed({ result }: Outcome): Verdict {
	return absent(result.checksRun.includes(CREATE), [`${CREATE} ran`, "absent from checksRun"])
}

export function createNotProbed({ result }: Outcome): Verdict {
	return absent(result.checksRun.includes(CREATE), ["ran", "skipped"])
}

export function updateNotProbed({ result }: Outcome): Verdict {
	return absent(result.checksRun.includes(UPDATE), ["ran", "skipped"])
}

export function noneProbed({ result }: Outcome): Verdict {
	return absent(result.checksRun.includes(CREATE) || result.checksRun.includes(UPDATE), ["ran", "absent"])
}

export function duplicateRefused({ result }: Outcome): Verdict {
	const bugs = result.findings.filter(isRootCause).filter((f) => f.check === CREATE)
	const ran = result.checksRun.includes(CREATE)
	return {
		detail: `ran=${String(ran)} bugs=${bugs.map((f) => f.verdict).join(",") || "none"}`,
		ok: ran && bugs.length === 0,
	}
}

export function duplicateInserted({ result }: Outcome): Verdict {
	return bug(result, CREATE, () => result.findings.map((f) => `${f.verdict}:${f.check}`).join(",") || "no finding")
}

export function listKept({ result }: Outcome): Verdict {
	const grew = result.findings.some((f) => f.check === CREATE && f.summary.includes("grew"))
	return { detail: grew ? "cardinality finding" : "no growth finding", ok: !grew }
}

export function oneSetInserted({ result }: Outcome): Verdict {
	return bug(result, CREATE, () => "no BACKEND_BUG")
}

export function updateRefused({ result }: Outcome): Verdict {
	const hit = found(result, UPDATE, "BACKEND_BUG")
	const ran = result.checksRun.includes(UPDATE)
	return { detail: `ran=${String(ran)} bug=${hit?.detail ?? "none"}`, ok: ran && hit === undefined }
}

export function updateApplied({ result }: Outcome): Verdict {
	return bug(result, UPDATE, () => "no finding")
}

/** No probe after the seed sends the seed's own Idempotency-Key again. */
export function freshKey({ posts, result }: Outcome): Verdict {
	const first = posts[0]?.headers["idempotency-key"]
	const reused = posts.slice(1).some((post) => {
		const value = post.headers["idempotency-key"]
		return typeof value === "string" && typeof first === "string" && value === first && value !== ""
	})
	return { detail: reused ? "reused seed key" : "fresh or omitted", ok: result.checksRun.includes(CREATE) && !reused }
}

export function driftReported({ result }: Outcome): Verdict {
	const drift = result.findings.find((f) => f.check === "schema.error-response-matches-document")
	return {
		detail: drift === undefined ? result.findings.map((f) => f.check).join(",") || "none" : drift.verdict,
		ok: drift !== undefined,
	}
}

/** The probe answered with something that is neither a 409 nor an insert: a gap, never a pass or a bug. */
export function coverageNotPass({ result }: Outcome): Verdict {
	const hit = found(result, CREATE, "BACKEND_BUG")
	const gap = found(result, CREATE, "COVERAGE_GAP")
	return {
		detail: `bug=${hit?.verdict ?? "none"} gap=${gap?.verdict ?? "none"}`,
		ok: hit === undefined && gap !== undefined,
	}
}

function adopted(seed: Finding | undefined): boolean {
	return seed?.verdict === "COVERAGE_GAP" && seed.detail.includes("x-unique")
}

export function seedAdopted({ result }: Outcome): Verdict {
	const seed = seedOf(result)
	return { detail: seedDetail(seed), ok: adopted(seed) }
}

export function probedAfterAdopt({ result }: Outcome): Verdict {
	const ran = result.checksRun.includes(CREATE)
	return { detail: ran ? "ran" : `checksRun=${result.checksRun.join(",")}`, ok: ran }
}

export function seedNotEvidence({ result }: Outcome): Verdict {
	const asSeed = result.findings.some(
		(f) => f.check === CREATE && f.verdict !== "BACKEND_BUG" && f.evidence.length === 0,
	)
	return { detail: asSeed ? "scored seed as unique pass" : "seed is not unique-check evidence", ok: !asSeed }
}

export function seedBlocked({ result }: Outcome): Verdict {
	const seed = seedOf(result)
	return { detail: seedDetail(seed), ok: seed?.verdict === "BLOCKED" }
}

export function untaggedNotAdopted({ result }: Outcome): Verdict {
	const adopts = adopted(seedOf(result))
	return { detail: adopts ? "adopted without a tag" : "not unique-adopt", ok: !adopts }
}

export function distinctInserted({ result }: Outcome): Verdict {
	const bugs = result.findings
		.filter(isRootCause)
		.filter((f) => f.check.startsWith("create.unique") || f.check.startsWith("update.unique"))
	return {
		detail: `bugs=${bugs.map((f) => f.check).join(",") || "none"} entities=${result.entitiesTested.join(",")}`,
		ok: bugs.length === 0 && result.entitiesTested.includes("widget"),
	}
}
