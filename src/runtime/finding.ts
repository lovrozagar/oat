/**
 * Findings carry their verdict, not a severity guess made at report time. The verdict is derived
 * from what the evidence shows, which is what lets the report collapse cascades and lets the
 * conformance suite assert "exactly this defect was detected".
 */

import type { Exchange } from "./exchange.ts"

export type Verdict = "BACKEND_BUG" | "SPEC_BUG" | "SECURITY" | "AMBIGUITY" | "COVERAGE_GAP" | "BLOCKED"

export interface Finding {
	/** Stable identifier for the check that produced this — the conformance suite asserts on it. */
	check: string
	verdict: Verdict
	entity: string
	summary: string
	detail: string
	evidence: Exchange[]
	/** Set when the finding came from a non-primary `origins[]` host. */
	origin?: string
	/** Fixture filename when `uploads.each` drove the invocation. */
	fixture?: string
	/** Operations this finding judges. Absent on run-level findings (teardown, network, pacing). */
	operations?: string[]
	/** A baseline entry names it: still reported, no longer a reason the run fails. */
	known?: { reason: string }
}

/**
 * Whether a finding is a root cause — what fails a run. Coverage gaps and blocks are what oat
 * could not look at, not what it found. The console, the reports, the matrix and the exit code
 * all ask this one question.
 */
export function isRootCause(finding: { verdict: Verdict | string }): boolean {
	return finding.verdict !== "COVERAGE_GAP" && finding.verdict !== "BLOCKED"
}

/** A root cause no baseline entry names — what the verdict and every defect count count. */
export function isFailingRootCause(finding: { verdict: Verdict | string; known?: unknown }): boolean {
	return isRootCause(finding) && finding.known === undefined
}

/**
 * How one run of a check ended. `run` returns one on every path, so a check cannot fall silent:
 * it either asserted the property, reported a finding, could not reach a verdict, or stood down
 * because what it tests is not there — and the last two say why.
 */
export type Outcome =
	| { kind: "asserted"; note?: string }
	| { kind: "finding"; verdict: Verdict }
	| { kind: "unresolved"; reason: string }
	| { kind: "stood-down"; reason: string }

/** The property was tested and passed — or, if the check reported along the way, did not. */
export const ASSERTED: Outcome = Object.freeze({ kind: "asserted" })

/**
 * The property passed, and how the backend behaved is worth saying — a policy the document leaves
 * open, such as whether unknown query parameters are rejected or ignored.
 */
export function asserted(note: string): Outcome {
	return { kind: "asserted", note }
}

/** The check does not apply here after all: what it tests is absent, for `reason`. */
export function standDown(reason: string): Outcome {
	return { kind: "stood-down", reason }
}

/**
 * A check that ran, could not reach a verdict, and stopped.
 *
 * Distinct from a skip (the entity never had what the check needs) and from a pass (the property
 * was tested and passed). Before this existed a check that bailed halfway — no matching field, an
 * empty listing, a probe that errored — simply returned, and the report was identical to one
 * where the property was verified. On a backend with several faults that is most of the suite
 * going quiet at once, which is the precise moment a reader most needs to know it happened.
 */
export interface Inconclusive {
	check: string
	entity: string
	/** Why no verdict was reachable, in the reader's terms. */
	reason: string
	operations?: string[]
}

function withFixture(finding: Finding, fixture?: string): Finding {
	if (fixture === undefined || fixture === "") return finding
	return { ...finding, fixture }
}

/* A stack frame line as V8 prints it: a newline, indentation, then "at ...". */
const STACK_FRAME = /\n[ \t]*at [^\n]*/g

/*
 * An absolute path that names a user's directory: under /home/<user>, /Users/<user> or /root, or
 * any path on a Windows drive, optionally as a file:// URL. A Unix path elsewhere is left alone,
 * since an API route such as /rows/{id} reads the same and a report must keep it.
 */
const USER_PATH =
	/(?<![\w./\\-])(?:file:\/\/)?(?:\/(?:home|Users)\/[^\s/'"`()<>]+|\/root(?![^\s/'"`()<>])|[A-Za-z]:(?=[\\/]))[^\s'"`()<>]*/g

/* Everything up to the last path separator that something follows. */
const DIRECTORIES = /^.*[\\/](?=[^\\/])/

/**
 * `path` as a whole path, never inside a longer one: under cwd "/x/oat", "/x/oat2" and "/x/oat.bak"
 * stay, while "/x/oat/a.ts" and a sentence ending "/x/oat." match.
 */
function wholePath(path: string): RegExp {
	return new RegExp(
		String.raw`(?<![\w.-])${path.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)}(?![\w-]|\.\w)`,
		"g",
	)
}

/**
 * Text a report may carry. A report is shared beyond the machine that ran it, so no finding names
 * where oat or its user lives:
 * - every stack frame line ("\n    at ...") is dropped;
 * - a path under the working directory is written relative to it, the directory itself as ".";
 * - any other path in a user's directory (see `USER_PATH`) is cut to its last segment, so
 *   "/home/ann/x/spec.yaml:3" reads "spec.yaml:3".
 */
function reportable(text: string): string {
	return text
		.replaceAll(STACK_FRAME, "")
		.replaceAll(wholePath(process.cwd()), ".")
		.replaceAll(USER_PATH, (path) => path.replace(DIRECTORIES, ""))
}

export class FindingCollector {
	readonly findings: Finding[]
	readonly inconclusive: Inconclusive[]
	readonly #operations: readonly string[] | undefined
	readonly #owner: string | undefined

	constructor(
		findings: Finding[] = [],
		inconclusive: Inconclusive[] = [],
		operations?: readonly string[],
		owner?: string,
	) {
		this.findings = findings
		this.inconclusive = inconclusive
		this.#operations = operations
		this.#owner = owner
	}

	/**
	 * A view that accepts findings only under `check`. Each check runs against one, so a check
	 * cannot report under another's id: a finding filed under the wrong id is proven by the wrong
	 * defect, and suppresses the wrong dependents.
	 */
	ownedBy(check: string): FindingCollector {
		return new FindingCollector(this.findings, this.inconclusive, this.#operations, check)
	}

	#own(check: string): void {
		if (this.#owner !== undefined && check !== this.#owner) {
			throw new Error(`check "${this.#owner}" tried to report under "${check}"`)
		}
	}

	/**
	 * A view over the same findings that attributes everything it records to `operations`.
	 *
	 * Each check runs against its own view, so a finding lands on the operations the check judges
	 * without threading an id through every call site. Read-only checks run concurrently, so a
	 * shared "current check" would attribute one check's finding to another.
	 */
	attributed(operations: readonly string[]): FindingCollector {
		return new FindingCollector(this.findings, this.inconclusive, operations, this.#owner)
	}

	#stamp(): { operations: string[] } | Record<string, never> {
		return this.#operations === undefined ? {} : { operations: [...this.#operations] }
	}

	/**
	 * Records that a check ran without reaching a verdict. Returns `undefined` so a check can
	 * `return ctx.findings.unresolved(...)` at the point it gives up, which keeps the reason
	 * beside the condition that caused it rather than in a comment.
	 */
	unresolved(check: string, entity: string, reason: string): Outcome {
		this.#own(check)
		const said = reportable(reason)
		this.inconclusive.push({ check, entity, reason: said, ...this.#stamp() })
		return { kind: "unresolved", reason: said }
	}

	/** Records a finding. Every finding passes here, so here its text is made fit to share. */
	report(finding: Finding): Outcome {
		this.#own(finding.check)
		const recorded: Finding = {
			...finding,
			detail: reportable(finding.detail),
			summary: reportable(finding.summary),
			...(finding.operations === undefined ? this.#stamp() : {}),
		}
		this.findings.push(recorded)
		if (recorded.verdict === "COVERAGE_GAP") return standDown(recorded.summary)
		if (recorded.verdict === "BLOCKED") return { kind: "unresolved", reason: recorded.summary }
		return { kind: "finding", verdict: recorded.verdict }
	}

	backend(
		check: string,
		entity: string,
		summary: string,
		detail: string,
		evidence: Exchange[],
		fixture?: string,
	): Outcome {
		return this.report(withFixture({ check, detail, entity, evidence, summary, verdict: "BACKEND_BUG" }, fixture))
	}

	security(
		check: string,
		entity: string,
		summary: string,
		detail: string,
		evidence: Exchange[],
		fixture?: string,
	): Outcome {
		return this.report(withFixture({ check, detail, entity, evidence, summary, verdict: "SECURITY" }, fixture))
	}

	spec(
		check: string,
		entity: string,
		summary: string,
		detail: string,
		evidence: Exchange[],
		fixture?: string,
	): Outcome {
		return this.report(withFixture({ check, detail, entity, evidence, summary, verdict: "SPEC_BUG" }, fixture))
	}

	gap(check: string, entity: string, summary: string, detail: string, fixture?: string): Outcome {
		return this.report(withFixture({ check, detail, entity, evidence: [], summary, verdict: "COVERAGE_GAP" }, fixture))
	}

	blocked(check: string, entity: string, summary: string, cause: string, evidence: Exchange[] = []): Outcome {
		return this.report({
			check,
			detail: `blocked by ${cause}`,
			entity,
			evidence,
			summary,
			verdict: "BLOCKED",
		})
	}

	checks(): string[] {
		return [...new Set(this.findings.map((f) => f.check))].sort()
	}

	byVerdict(verdict: Verdict): Finding[] {
		return this.findings.filter((f) => f.verdict === verdict)
	}
}
