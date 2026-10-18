import { MissingValueError } from "../../../errors/missing-value.ts"
import type { WriteContext } from "../../checks/core/context.ts"
import { checkSalts } from "../../checks/core/run.ts"
import { CHECKS } from "../../checks/registry.ts"
import { AuthRefreshError, type Client } from "../../client.ts"
import { FencedError } from "../../fence.ts"
import { type FindingCollector, isRootCause, type Outcome } from "../../finding.ts"
import { isNetworkError } from "../../network.ts"
import type { EntityRun } from "./state.ts"
import { messageOf } from "../errors.ts"

export type Check = (typeof CHECKS)[number]

/** One entity's check run: what each check grades, what its plan gathered, how each ended. */
export interface CheckLoop {
	run: EntityRun
	context: WriteContext
	plans: Map<string, unknown>
	outcomes: Map<string, Outcome>
}

/** A check whose plan applies, with the subjects it grades: in scope, and not excluded by the profile. */
export interface PlannedCheck {
	check: Check
	graded: string[]
}

/** Runs one check, records how it ended, and grades its subjects by that. */
export async function runCheck(loop: CheckLoop, { check, graded }: PlannedCheck): Promise<void> {
	const { run } = loop
	const { ctx, entity } = run
	const attributed = graded.length === 0 ? ctx.findings : ctx.findings.attributed(graded)
	let judged: Set<string> | undefined
	const view = viewFor(loop, check, attributed, (operationIds) => {
		judged ??= new Set()
		for (const id of operationIds) judged.add(id)
	})
	ctx.state.checksRun.add(check.id)
	ctx.progress.tick({
		check: check.id,
		entity: entity.name,
		entityIndex: ctx.progress.entityIndex,
		entityTotal: ctx.progress.entityTotal,
		phase: "test",
		requests: ctx.progress.requests,
	})
	const start = ctx.findings.findings.length
	const began = performance.now()
	const ran = await outcomeOf(loop, check, view, attributed)
	if (ran === undefined) return
	ctx.state.checkTimings.push({ check: check.id, entity: entity.name, ms: Math.round(performance.now() - began) })
	const outcome = reported(run, check, ran, start)
	loop.outcomes.set(check.id, outcome)
	judge(run, check, outcome, {
		graded,
		judged: judged === undefined ? graded : graded.filter((id) => judged?.has(id) === true),
	})
}

/**
 * The check's own view of the context. Its own client: every exchange names this check, even
 * while a batch runs concurrently, and a check that does not mutate gets one that refuses to
 * write. Salts of this check on this entity alone: what it sends never depends on what ran beside it.
 */
function viewFor(
	loop: CheckLoop,
	check: Check,
	attributed: FindingCollector,
	judged: (operationIds: readonly string[]) => void,
): WriteContext {
	const { client } = loop.run.ctx
	const stamp = { check: check.id, purpose: "assertion", subject: loop.run.entity.name } as const
	return {
		...loop.context,
		client: check.mutates === true ? client.view(stamp) : (client.readOnlyView(stamp) as Client),
		findings: attributed.ownedBy(check.id),
		judged,
		nextSalt: checkSalts(CHECKS.indexOf(check), loop.run.index),
	}
}

/**
 * How the check ended. An error it threw is mapped to what it means: the network or a credential
 * gone, a fenced request, a value nobody supplied. `undefined` when it ended without a verdict to
 * time or grade; anything else unexpected is the check's own gap.
 */
async function outcomeOf(
	loop: CheckLoop,
	check: Check,
	view: WriteContext,
	attributed: FindingCollector,
): Promise<Outcome | undefined> {
	try {
		return await check.run(view, loop.plans.get(check.id))
	} catch (error) {
		const unresolved = await unresolvedBy(loop, check, error, attributed)
		if (unresolved !== undefined) {
			loop.outcomes.set(check.id, { kind: "unresolved", reason: unresolved })
			return undefined
		}
		const name = loop.run.entity.name
		const detail = messageOf(error)
		return view.findings.gap(check.id, name, `check "${check.id}" could not complete`, detail)
	}
}

/** Why an error left the check unresolved, reported where it is a cause; `undefined` for any other error. */
async function unresolvedBy(
	loop: CheckLoop,
	check: Check,
	error: unknown,
	attributed: FindingCollector,
): Promise<string | undefined> {
	const name = loop.run.entity.name
	if (isNetworkError(error)) {
		await loop.run.ctx.network.note(error, name)
		return "the network failed"
	}
	if (error instanceof FencedError) {
		attributed.blocked(
			"fence",
			name,
			`${check.id} was fenced: ${error.request.reason}`,
			`${error.message}. The request was never sent, so ${check.id} could not complete.`,
		)
		return "a request was fenced"
	}
	if (error instanceof MissingValueError) return error.message
	if (!(error instanceof AuthRefreshError)) return undefined
	attributed.blocked(
		"auth.refresh",
		name,
		`refreshing the credential${error.principal === undefined ? "" : ` of "${error.principal}"`} failed`,
		`${error.message}. ${check.id} could not complete.`,
	)
	return "a credential could not be refreshed"
}

/**
 * A check that reported along the way and then fell through to "asserted" did not assert
 * anything: what it reported is the outcome.
 */
function reported(run: EntityRun, check: Check, outcome: Outcome, start: number): Outcome {
	if (outcome.kind !== "asserted") return outcome
	const found = run.ctx.findings.findings
		.slice(start)
		.find((finding) => finding.check === check.id && finding.entity === run.entity.name && isRootCause(finding))
	return found === undefined ? outcome : { kind: "finding", verdict: found.verdict }
}

/**
 * Grades the check's subjects by its outcome: those it judged, when it named them, else all it
 * grades. A check that stood down did not pass: the report says why.
 */
function judge(run: EntityRun, check: Check, outcome: Outcome, subjects: { graded: string[]; judged: string[] }): void {
	const { state, grades } = run.ctx
	const entity = run.entity.name
	if (outcome.kind === "asserted" && outcome.note !== undefined) {
		state.checkNotes.push({ check: check.id, entity, note: outcome.note })
	}
	if (outcome.kind !== "stood-down") {
		grades.graded(subjects.judged, check.id)
		return
	}
	const needs = withLostVariants(run, outcome.reason)
	state.checksSkipped.push({ check: check.id, entity, needs })
	grades.skipped(subjects.graded, needs)
}

/**
 * What a check that stands down for want of cohort data needed, naming the variants that never
 * arrived: the gap points at the seed rather than the API.
 */
export function withLostVariants(run: EntityRun, needs: string): string {
	const lost = run.lostVariants
	if (lost.length === 0 || !/cohort|record/.test(needs)) return needs
	const named = lost.map((variant) => `"${variant}"`).join(", ")
	return `${needs} (the cohort is missing its ${named} variant${lost.length === 1 ? "" : "s"}, which failed to seed)`
}
