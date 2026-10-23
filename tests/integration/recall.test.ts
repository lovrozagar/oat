import { beforeAll, describe, expect, it } from "vitest"
import { planPasses, recalledChecks } from "../../src/cli/commands/conformance-matrix.ts"
import { EXPECTED } from "../../src/conformance/expected/table.ts"
import { inProcess } from "../../src/conformance/harness/launch.ts"
import { defectsFor } from "../../src/conformance/matrix/defects.ts"
import { acceptableOf, primaryOf } from "../../src/conformance/matrix/expected.ts"
import { renderSuite, renderUnproven } from "../../src/conformance/matrix/render.ts"
import { type AnswerFor, type ConformanceTask, createPool } from "../../src/conformance/pool.ts"
import { recallDefects, SHAPE_NAMES } from "../../src/conformance/shapes.ts"
import type { DefectName } from "../../src/reference/defects/table.ts"
import { CHECKS } from "../../src/runtime/checks/registry.ts"

/*
 * Recall over the whole registry, the claim `oat conformance` ends on: every registered check fires
 * on a defect built for it. The full matrix proves that with every defect on every leg; this runs
 * the fewest of the same tasks that still name every check, one defect each, on the in-memory
 * engine, and judges them with the command's own proof: `renderSuite` for a pass, `recalledChecks`
 * for recall behind a shape, `renderUnproven` for the verdict.
 */

/** The tasks a recall check is built from: one defect in a pass, or one behind a shape. */
type DefectTask = Extract<ConformanceTask, { kind: "defects" | "recall" }>

/** Where a defect runs: a memory pass under a dialect, or recall behind a shape. */
interface Place {
	name: string
	defects: ReadonlySet<DefectName>
	task: (defect: DefectName) => DefectTask
	/** A pass proves whatever a detected defect fired; recall proves only the primary check. */
	recall: boolean
}

/** One chosen defect, the place it runs, and the checks it was chosen to prove. */
interface Pick {
	place: Place
	defect: DefectName
	checks: string[]
}

/** What a pick's task answered. */
type Answer = AnswerFor<DefectTask>

/* The command's memory passes in its order, then recall behind each shape for what no pass runs. */
const PLACES: Place[] = [
	...planPasses(["memory"], undefined, undefined).map(({ dialect }): Place => ({
		defects: new Set(defectsFor("memory", dialect)),
		name: `memory:${dialect}`,
		recall: false,
		task: (defect) => ({ backend: "memory", defects: [defect], dialect, kind: "defects" }),
	})),
	...SHAPE_NAMES.map((shape): Place => ({
		defects: new Set(recallDefects("memory", shape)),
		name: `recall:${shape}`,
		recall: true,
		task: (defect) => ({ defects: [defect], kind: "recall", shape }),
	})),
]

/** Each place that runs one of `defects`, with it; recall places only when `recall`. */
function at(defects: readonly DefectName[], recall: boolean): Array<{ place: Place; defect: DefectName }> {
	return PLACES.filter((place) => recall || !place.recall).flatMap((place) =>
		defects.filter((defect) => place.defects.has(defect)).map((defect) => ({ defect, place })),
	)
}

/** Every place and defect that can prove `check`: as its primary first, then as an acceptable one in a pass. */
function candidates(check: string): Array<{ place: Place; defect: DefectName }> {
	const naming = (Object.keys(EXPECTED) as DefectName[]).filter((defect) =>
		acceptableOf(EXPECTED[defect]).includes(check),
	)
	const primary = naming.filter((defect) => primaryOf(EXPECTED[defect]) === check)
	return [...at(primary, true), ...at(naming, false)]
}

/**
 * One defect per check, as few as possible. A check no defect names as primary is placed first,
 * since its defect is forced; every other check reuses a chosen defect whose primary it is, or takes
 * the first place that runs one.
 */
function plan(): { picks: Pick[]; unplaced: string[] } {
	const ids: string[] = CHECKS.map((check) => check.id)
	const options = new Map(ids.map((id) => [id, candidates(id)]))
	const primaryOnly = (id: string) =>
		(options.get(id) ?? []).filter((option) => primaryOf(EXPECTED[option.defect]) === id)
	const ordered = ids.toSorted((a, b) => Number(primaryOnly(a).length > 0) - Number(primaryOnly(b).length > 0))
	const picks = new Map<string, Pick>()
	const unplaced: string[] = []
	for (const id of ordered) {
		const usable = primaryOnly(id).length > 0 ? primaryOnly(id) : (options.get(id) ?? [])
		const chosen = usable.find((option) => picks.has(`${option.place.name}:${option.defect}`)) ?? usable[0]
		if (chosen === undefined) {
			unplaced.push(id)
			continue
		}
		const key = `${chosen.place.name}:${chosen.defect}`
		const pick = picks.get(key) ?? { ...chosen, checks: [] }
		pick.checks.push(id)
		picks.set(key, pick)
	}
	return { picks: [...picks.values()], unplaced }
}

/** The checks `answers` prove, as the command credits them. */
function proven(answers: readonly Answer[]): Set<string> {
	const results = answers.flatMap((answer) => (answer.kind === "leg" ? answer.results : []))
	const cases = answers.flatMap((answer) => (answer.kind === "cases" ? answer.cases : []))
	return new Set([...renderSuite(results).proven, ...recalledChecks(cases, EXPECTED)])
}

describe("recall over the registry", () => {
	const { picks, unplaced } = plan()
	const answers = new Map<Pick, Answer>()
	let seconds = 0

	beforeAll(async () => {
		const began = performance.now()
		const pool = createPool(1, { inProcess: true, via: inProcess })
		try {
			for (const pick of picks) answers.set(pick, await pool.run(pick.place.task(pick.defect)))
		} finally {
			await pool.close()
		}
		seconds = Math.round((performance.now() - began) / 1000)
	}, 600_000)

	it("places every registered check on a defect built for it", () => {
		expect(unplaced).toEqual([])
		expect(picks.flatMap((pick) => pick.checks).toSorted()).toEqual(CHECKS.map((check) => check.id).toSorted())
	})

	it("proves every registered check", () => {
		const verdict = renderUnproven(proven([...answers.values()]))
		expect(verdict.failures, `${verdict.text}\n  ${picks.length} tasks in ${seconds}s`).toBe(0)
	})

	it("fires each chosen defect's check on that defect", () => {
		const missed = picks.flatMap((pick) => {
			const fired = proven([answers.get(pick) as Answer])
			const absent = pick.checks.filter((id) => !fired.has(id))
			return absent.length === 0 ? [] : [`${pick.place.name}:${pick.defect} did not fire ${absent.join(", ")}`]
		})
		expect(missed).toEqual([])
	})

	it("leaves a check unproven when the one task that proves it is gone", () => {
		/* The picks off the default pass are the only ones naming their checks, on either proof path. */
		const sole = picks.filter((pick) => pick.place.name !== "memory:postgrest")
		expect(sole.map((pick) => pick.place.recall).toSorted()).toEqual([false, true])
		for (const removed of sole) {
			const rest = picks.filter((pick) => pick !== removed).map((pick) => answers.get(pick) as Answer)
			const verdict = renderUnproven(proven(rest))
			expect(verdict.failures).toBeGreaterThan(0)
			for (const id of removed.checks) expect(verdict.text).toContain(`      ${id}\n`)
		}
	})
})
