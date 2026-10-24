/**
 * Findings a team already knows about.
 *
 * A backend with open defects fails every run, so a gate built on the exit code cannot tell the
 * old failures from a new one. A baseline names the known ones: a finding an entry matches is
 * reported as known and leaves the verdict alone; every other root cause still fails the run; and
 * an entry that matched nothing is reported as fixed, never as a failure.
 */

import { didYouMean } from "../errors/suggest.ts"
import { UsageError } from "../errors/usage-error.ts"
import { CHECK_IDS, RUN_FINDING_IDS } from "./check-ids.ts"
import { type Finding, isRootCause } from "./finding.ts"
import type { RawOf } from "../config/types/raw.ts"

export interface BaselineEntry {
	check: string
	/** Matches only this entity's findings; absent, every entity's. */
	entity?: string
	/** Matches only findings that judge this operation; absent, the check's findings on any operation. */
	operationId?: string
	/** Why it is known — a ticket, a release note. Shown beside the finding. */
	reason: string
}

export interface BaselineFile {
	version: 1
	entries: BaselineEntry[]
}

const ENTRY_KEYS: ReadonlySet<string> = /* @__PURE__ */ new Set(["check", "entity", "operationId", "reason"])

/** A plain object, read as `T` before any of its values is checked. */
const isRaw = <T>(value: unknown): value is RawOf<T> =>
	typeof value === "object" && value !== null && !Array.isArray(value)

/* Every id a finding can name: a registered check's, or the run's own. */
const FINDING_IDS: ReadonlySet<string> = /* @__PURE__ */ new Set([...CHECK_IDS, ...RUN_FINDING_IDS])

/** A baseline file, validated; `where` names it in the error. */
export function parseBaseline(raw: unknown, where: string): BaselineFile {
	if (!isRaw<BaselineFile>(raw)) throw new UsageError(`${where}: a baseline is { "version": 1, "entries": [...] }`)
	if (raw.version !== 1) throw new UsageError(`${where}: version must be 1`)
	if (!Array.isArray(raw.entries)) throw new UsageError(`${where}: entries must be an array`)
	const entries = raw.entries.map((entry: unknown, index): BaselineEntry => {
		const at = `${where}: entries[${index}]`
		if (!isRaw<BaselineEntry>(entry)) throw new UsageError(`${at} must be an object`)
		for (const key of Object.keys(entry)) {
			if (!ENTRY_KEYS.has(key)) throw new UsageError(`${at}.${key} is not a baseline key`)
		}
		if (typeof entry.check !== "string" || entry.check === "") throw new UsageError(`${at}.check must name a check`)
		if (typeof entry.reason !== "string" || entry.reason === "") {
			throw new UsageError(`${at}.reason must say why the finding is known`)
		}
		for (const key of ["entity", "operationId"] as const) {
			if (entry[key] !== undefined && typeof entry[key] !== "string") {
				throw new UsageError(`${at}.${key} must be a string`)
			}
		}
		/* An id no run raises would match nothing and read as fixed: a renamed check, or a typo. */
		if (!FINDING_IDS.has(entry.check)) {
			throw new UsageError(`${at}.check "${entry.check}" is no check oat runs.${didYouMean(entry.check, FINDING_IDS)}`)
		}
		return {
			check: entry.check,
			reason: entry.reason,
			...(typeof entry.entity === "string" ? { entity: entry.entity } : {}),
			...(typeof entry.operationId === "string" ? { operationId: entry.operationId } : {}),
		}
	})
	return { entries, version: 1 }
}

function matches(entry: BaselineEntry, finding: Finding): boolean {
	if (entry.check !== finding.check) return false
	if (entry.entity !== undefined && entry.entity !== finding.entity) return false
	return entry.operationId === undefined || (finding.operations ?? []).includes(entry.operationId)
}

/**
 * Marks every root-cause finding an entry matches as known, in place, and returns the entries that
 * matched nothing — the defects that are gone.
 */
export function applyBaseline(findings: readonly Finding[], baseline: BaselineFile): { fixed: BaselineEntry[] } {
	const used = new Set<BaselineEntry>()
	for (const finding of findings) {
		if (!isRootCause(finding)) continue
		const entry = baseline.entries.find((candidate) => matches(candidate, finding))
		if (entry === undefined) continue
		finding.known = { reason: entry.reason }
		used.add(entry)
	}
	return { fixed: baseline.entries.filter((entry) => !used.has(entry)) }
}

/** One entry per root-cause finding of a run, deduplicated and sorted, each naming its summary. */
export function baselineFrom(
	findings: ReadonlyArray<Pick<Finding, "check" | "entity" | "verdict" | "summary" | "operations">>,
): BaselineFile {
	const entries = new Map<string, BaselineEntry & { entity: string }>()
	for (const finding of findings) {
		if (!isRootCause(finding)) continue
		const operationId = finding.operations?.[0]
		const entry = {
			check: finding.check,
			entity: finding.entity,
			reason: finding.summary,
			...(operationId === undefined ? {} : { operationId }),
		}
		entries.set(`${entry.check}|${entry.entity}|${entry.operationId ?? ""}`, entry)
	}
	return {
		entries: [...entries.values()].sort(
			(a, b) =>
				a.check.localeCompare(b.check) ||
				a.entity.localeCompare(b.entity) ||
				(a.operationId ?? "").localeCompare(b.operationId ?? ""),
		),
		version: 1,
	}
}
