/*
 * The security stage: the operation checks, run per operation rather than per entity, and scheduled
 * by probe, each check on one operation, by its placement (`placementOf`).
 *
 * Collection reads run before the entity lanes, concurrently, as the lanes do. After the lanes and
 * before teardown, while the records the run created still exist, reads of one record run
 * concurrently, and then writes and credential-changing probes run alone and in order. Both are sent
 * only to a record the run created (BLOCKING 1), so a refusal on a broken API never applies a write
 * to a record the run did not make. A DELETE goes to a throwaway record of its own (`throwawayTarget`),
 * never to one another step uses. Every finding is attributed to the operation it judges.
 */

import type { Actor } from "../checks/core/context.ts"
import type { OperationCheck, RegisteredCheck } from "../checks/core/check.ts"
import { operationChecks } from "../checks/core/registry.ts"
import { placementOf } from "../checks/core/operation.ts"
import type { OperationWriteContext, ProbePlacement, Probed, WriteTarget } from "../checks/core/operation-context.ts"
import { CHECKS } from "../checks/registry.ts"
import type { Client } from "../../client/client.ts"
import { type Outcome, standDown } from "../finding.ts"
import type { OperationModel } from "../../spec/graph/types.ts"
import type { RunContext } from "./context.ts"
import { unresolvedBy } from "./entity/run-check.ts"
import { probeCredentials } from "./probe-credentials.ts"
import { recordTarget, type TargetReads, targetReads } from "./security-target.ts"
import { isDelete, settle, throwawayTarget, type Throwaways, throwaways } from "./security-throwaway.ts"

/** The collection reads, before the lanes: run concurrently. */
export async function runReadSecurity(ctx: RunContext, registry: readonly RegisteredCheck[] = CHECKS): Promise<void> {
	await Promise.all(placed(ctx, registry, "read").map((probe) => runProbe(ctx, probe)))
}

/**
 * After the lanes: the reads of one record, concurrently; then the writes and credential-changing
 * probes, alone and in order. The reads go first, so a write that removes a record cannot pull it
 * from under them. Every probe of the stage shares one read back of each record it targets.
 */
export async function runWriteSecurity(ctx: RunContext, registry: readonly RegisteredCheck[] = CHECKS): Promise<void> {
	const reads = targetReads()
	await Promise.all(placed(ctx, registry, "item-read").map((probe) => runProbe(ctx, probe, { reads })))
	const throwaway = throwaways()
	for (const probe of placed(ctx, registry, "write")) await runProbe(ctx, probe, { reads, throwaway })
}

/** What a probe after the lanes shares with the rest of its stage: the target reads, and a write's throwaways. */
interface Stage {
	reads: TargetReads
	throwaway?: Throwaways
}

/** One operation check planned on one operation, and where it runs. */
interface Probe {
	check: OperationCheck
	operation: OperationModel
	placement: ProbePlacement
}

/* The probes of one placement, in registry then document order. */
function placed(ctx: RunContext, registry: readonly RegisteredCheck[], placement: ProbePlacement): Probe[] {
	return probes(ctx, operationChecks(registry)).filter((probe) => probe.placement === placement)
}

/* Every in-scope operation paired with every operation check, in registry then document order. */
function probes(ctx: RunContext, checks: readonly OperationCheck[]): Probe[] {
	const operations = ctx.model.operations.filter(
		(op) => ctx.scope.inScope(op.operationId) && !ctx.exclusion.excludes(op.operationId),
	)
	return checks.flatMap((check) =>
		operations.map((operation) => ({ check, operation, placement: placementOf(check, operation) })),
	)
}

/* One probe; a write probe gets the stage's throwaways, and a DELETE that went through consumes its own. */
async function runProbe(ctx: RunContext, probe: Probe, stage?: Stage): Promise<void> {
	const context = await contextOf(ctx, probe, stage)
	const since = ctx.client.transcript.length
	record(ctx, probe, await outcomeOf(ctx, probe, context))
	if (stage?.throwaway !== undefined) settle(ctx, stage.throwaway, { op: probe.operation, since })
}

/* Plans the check and, when it applies, runs it; what the scheduler does for one operation check. */
async function outcomeOf(ctx: RunContext, probe: Probe, context: OperationWriteContext): Promise<Outcome> {
	const { check, operation } = probe
	/* The one place opt-in is enforced: a check that could lock an account out runs only when asked. */
	const switchedOn = new Map<string, boolean | undefined>(Object.entries(ctx.options.checks ?? {}))
	if (check.optIn === true && switchedOn.get(check.id) !== true) {
		return standDown(`opt in with checks: { "${check.id}": true }`)
	}
	const planned = check.plan(context)
	if (!planned.ok) return standDown(planned.needs ?? check.needs ?? "an unstated precondition")
	try {
		return await check.run(context, planned.value)
	} catch (error) {
		/* A stop is reported under its own id (the fence, a blocked credential), never the check's. */
		const stopped = {
			attributed: ctx.findings.attributed([operation.operationId]),
			checkId: check.id,
			ctx,
			entity: operation.operationId,
		}
		const reason = await unresolvedBy(stopped, error)
		if (reason !== undefined) return { kind: "unresolved", reason }
		return context.findings.gap(check.id, operation.operationId, {
			summary: `check "${check.id}" could not complete`,
			detail: `${operation.operationId}: ${error instanceof Error ? error.message : String(error)}`,
		})
	}
}

/** The context one operation check runs against, owned by the check and attributed to the operation. */
async function contextOf(ctx: RunContext, probe: Probe, stage?: Stage): Promise<OperationWriteContext> {
	const { check, operation, placement } = probe
	const stamp = { check: check.id, purpose: "assertion", subject: operation.operationId } as const
	const client = placement === "write" ? ctx.client.view(stamp) : (ctx.client.readOnlyView(stamp) as Client)
	const actors = actorsOf(ctx)
	const context: OperationWriteContext = {
		actor: actors[0],
		client,
		findings: ctx.findings.attributed([operation.operationId]).ownedBy(check.id),
		model: ctx.model,
		nonce: ctx.nonce,
		operation,
		options: { checks: ctx.options.checks ?? {} },
		placement,
		principals: actors,
		probe: probeCredentials(ctx),
		security: operation.security,
		subject: operation.operationId,
	}
	const peer = actors.find((actor) => actor.tenant !== actors[0].tenant)
	if (peer !== undefined) context.peer = peer
	const target = await targetFor(ctx, probe, stage)
	if (target === undefined) return context
	if ("untested" in target) context.untargeted = target.untested
	else context.target = target
	return context
}

/* A write probe's DELETE takes a throwaway; any other probe after the lanes, the run-created record. */
async function targetFor(
	ctx: RunContext,
	{ operation, placement }: Probe,
	stage: Stage | undefined,
): Promise<Probed<WriteTarget> | undefined> {
	if (placement === "read" || stage === undefined) return undefined
	if (stage.throwaway !== undefined && isDelete(operation)) return throwawayTarget(ctx, operation, stage.throwaway)
	return recordTarget(ctx, operation, stage.reads)
}

/** Every principal as an operation check acts as it: its id, tenant, rank, scope and invite value. */
function actorsOf(ctx: RunContext): [Actor, ...Actor[]] {
	const [alpha, ...rest] = ctx.principals.all
	const actor = (principal: (typeof ctx.principals.all)[number]): Actor => ({
		id: principal.id,
		inviteAs: principal.inviteAs,
		rank: principal.rank,
		scope: { ...principal.scope },
		tenant: principal.tenant,
		...(principal.readOnly === true ? { readOnly: true } : {}),
	})
	return [actor(alpha as (typeof ctx.principals.all)[number]), ...rest.map(actor)]
}

/* Grades the operation by the outcome, and records a note or a stand-down as the entity loop does. */
function record(ctx: RunContext, probe: Probe, outcome: Outcome): void {
	const { check, operation } = probe
	const { state, grades } = ctx
	state.checksRun.add(check.id)
	if (outcome.kind === "asserted" && outcome.note !== undefined) {
		state.checkNotes.push({ check: check.id, entity: operation.operationId, note: outcome.note })
	}
	if (outcome.kind === "stood-down") {
		state.checksSkipped.push({ check: check.id, entity: operation.operationId, needs: outcome.reason })
		grades.skipped([operation.operationId], outcome.reason)
		return
	}
	grades.probedBy([operation.operationId], check.id)
}
