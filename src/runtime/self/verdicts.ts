/** What each answer on the caller's routes means, decided without another request. */

import type { EntityModel, OperationModel, SpecModel } from "../../spec/graph/types.ts"
import { requestContentOf } from "../body/encode.ts"
import type { Exchange } from "../exchange.ts"
import { ASSERTED, type FindingCollector, type Outcome } from "../finding.ts"
import type { CreatedCaller } from "./create.ts"
import { callerEchoed } from "./create.ts"
import { type LocatedProbe, locateProbe, probeStuck } from "./locate.ts"
import { SELF_CHECK_ID } from "./operations.ts"
import { nextValue, type ProbeField, probeField } from "./probe-field.ts"
import { pathOf, throttled } from "./requests.ts"

/** The run of one self check: its entity, findings, and the operations it calls. */
export interface SelfRun {
	entity: EntityModel
	findings: FindingCollector
	/** The read when there is one, else the update: what the anonymous request goes to. */
	probe: OperationModel
	probePath: string
	readOp: OperationModel | undefined
	updateOp: OperationModel | undefined
	readOps: OperationModel[]
}

const isOk = (status: number): boolean => status >= 200 && status < 300

export function answeredWithoutToken(ctx: SelfRun, anonymous: Exchange): Outcome {
	return ctx.findings.security(SELF_CHECK_ID, ctx.entity.name, {
		summary: "the caller route answered without a token",
		detail: `${ctx.probe.operationId} returned ${anonymous.status} with no credential. The signed-up caller is the record, so no token is a 401.`,
		evidence: [anonymous],
	})
}

/** With no read, the update alone is the check. */
export function updatedAlone(ctx: SelfRun, anonymous: Exchange, wrote: Exchange): Outcome {
	if (wrote.status === 429) return throttled(ctx.findings, ctx.entity.name)
	if (isOk(wrote.status)) return ASSERTED
	return ctx.findings.backend(SELF_CHECK_ID, ctx.entity.name, {
		summary: "updating the caller failed",
		detail: `${ctx.probe.operationId} returned ${wrote.status} for the signed-up caller.`,
		evidence: [anonymous, wrote],
	})
}

export function readRefused(ctx: SelfRun, op: OperationModel, anonymous: Exchange, read: Exchange): Outcome | null {
	if (read.status === 429) return throttled(ctx.findings, ctx.entity.name)
	if (read.status === 200) return null
	return ctx.findings.backend(SELF_CHECK_ID, ctx.entity.name, {
		summary: "reading the caller failed",
		detail: `${op.operationId} returned ${read.status} for the signed-up caller. The read is that caller and returns 200.`,
		evidence: [anonymous, read],
	})
}

export function echoMissed(
	ctx: SelfRun,
	created: CreatedCaller | null,
	readOp: OperationModel,
	read: Exchange,
): Outcome | null {
	if (created === null || callerEchoed(created.body, read.responseBody)) return null
	return ctx.findings.backend(SELF_CHECK_ID, ctx.entity.name, {
		summary: "the create did not show up on the next read",
		detail: `${created.exchange.operationId} sent ${JSON.stringify(created.body)}, and the next ${readOp.operationId} returned ${JSON.stringify(read.responseBody)}.`,
		evidence: [created.exchange, read],
	})
}

/** The update the check sends: the field it changes, to what, and what it held before. */
export interface UpdateProbe {
	op: OperationModel
	path: string
	field: ProbeField
	before: LocatedProbe
	value: boolean | string
}

/** The update to send, or how the check ends without one. */
export function updateProbe(ctx: SelfRun, model: SpecModel, read: Exchange): UpdateProbe | Outcome {
	const { updateOp } = ctx
	if (updateOp === undefined) return ASSERTED
	const path = pathOf(updateOp)
	if (path === null) return ASSERTED
	const field = probeField(requestContentOf(updateOp, model)?.schema)
	if (field === null) {
		return ctx.findings.unresolved(
			SELF_CHECK_ID,
			ctx.entity.name,
			"the update has no plain string or boolean field to change",
		)
	}
	const before = locateProbe(read.responseBody, field.name)
	return { before, field, op: updateOp, path, value: nextValue(field, before.current) }
}

export function writeRefused(ctx: SelfRun, update: UpdateProbe, read: Exchange, wrote: Exchange): Outcome | null {
	if (wrote.status === 429) return throttled(ctx.findings, ctx.entity.name)
	if (isOk(wrote.status)) return null
	return ctx.findings.backend(SELF_CHECK_ID, ctx.entity.name, {
		summary: "updating the caller failed",
		detail: `${update.op.operationId} returned ${wrote.status} when setting ${update.field.name}.`,
		evidence: [read, wrote],
	})
}

export function notStuck(ctx: SelfRun, update: UpdateProbe, wrote: Exchange, again: Exchange): Outcome | null {
	if (again.status === 429) return throttled(ctx.findings, ctx.entity.name)
	const after = locateProbe(again.responseBody, update.field.name)
	if (again.status === 200 && probeStuck(update.before, after, update.value)) return null
	/* The read is the probe: the anonymous request went to it. */
	const readOp = ctx.probe
	return ctx.findings.backend(SELF_CHECK_ID, ctx.entity.name, {
		summary: "an update to the caller did not stick",
		detail: `${update.op.operationId} set ${update.field.name} to ${JSON.stringify(update.value)}, and the next ${readOp.operationId} returned ${again.status} with ${JSON.stringify(after.where === "top" ? after.current : after.values)}.`,
		evidence: [wrote, again],
	})
}

/** A value the update can put back: what the field held, when it was a plain one. */
export function restorable(update: UpdateProbe): boolean {
	const current = update.before.current
	return typeof current === "string" || current === null || typeof current === "boolean"
}
