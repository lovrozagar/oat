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

export function answeredWithoutToken(run: SelfRun, anonymous: Exchange): Outcome {
	return run.findings.security(
		SELF_CHECK_ID,
		run.entity.name,
		"the caller route answered without a token",
		`${run.probe.operationId} returned ${anonymous.status} with no credential. The signed-up caller is the record, so no token is a 401.`,
		[anonymous],
	)
}

/** With no read, the update alone is the check. */
export function updatedAlone(run: SelfRun, anonymous: Exchange, wrote: Exchange): Outcome {
	if (wrote.status === 429) return throttled(run.findings, run.entity.name)
	if (isOk(wrote.status)) return ASSERTED
	return run.findings.backend(
		SELF_CHECK_ID,
		run.entity.name,
		"updating the caller failed",
		`${run.probe.operationId} returned ${wrote.status} for the signed-up caller.`,
		[anonymous, wrote],
	)
}

export function readRefused(run: SelfRun, op: OperationModel, anonymous: Exchange, read: Exchange): Outcome | null {
	if (read.status === 429) return throttled(run.findings, run.entity.name)
	if (read.status === 200) return null
	return run.findings.backend(
		SELF_CHECK_ID,
		run.entity.name,
		"reading the caller failed",
		`${op.operationId} returned ${read.status} for the signed-up caller. The read is that caller and returns 200.`,
		[anonymous, read],
	)
}

export function echoMissed(
	run: SelfRun,
	created: CreatedCaller | null,
	readOp: OperationModel,
	read: Exchange,
): Outcome | null {
	if (created === null || callerEchoed(created.body, read.responseBody)) return null
	return run.findings.backend(
		SELF_CHECK_ID,
		run.entity.name,
		"the create did not show up on the next read",
		`${created.exchange.operationId} sent ${JSON.stringify(created.body)}, and the next ${readOp.operationId} returned ${JSON.stringify(read.responseBody)}.`,
		[created.exchange, read],
	)
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
export function updateProbe(run: SelfRun, model: SpecModel, read: Exchange): UpdateProbe | Outcome {
	const { updateOp } = run
	if (updateOp === undefined) return ASSERTED
	const path = pathOf(updateOp)
	if (path === null) return ASSERTED
	const field = probeField(requestContentOf(updateOp, model)?.schema)
	if (field === null) {
		return run.findings.unresolved(
			SELF_CHECK_ID,
			run.entity.name,
			"the update has no plain string or boolean field to change",
		)
	}
	const before = locateProbe(read.responseBody, field.name)
	return { before, field, op: updateOp, path, value: nextValue(field, before.current) }
}

export function writeRefused(run: SelfRun, update: UpdateProbe, read: Exchange, wrote: Exchange): Outcome | null {
	if (wrote.status === 429) return throttled(run.findings, run.entity.name)
	if (isOk(wrote.status)) return null
	return run.findings.backend(
		SELF_CHECK_ID,
		run.entity.name,
		"updating the caller failed",
		`${update.op.operationId} returned ${wrote.status} when setting ${update.field.name}.`,
		[read, wrote],
	)
}

export function notStuck(run: SelfRun, update: UpdateProbe, wrote: Exchange, again: Exchange): Outcome | null {
	if (again.status === 429) return throttled(run.findings, run.entity.name)
	const after = locateProbe(again.responseBody, update.field.name)
	if (again.status === 200 && probeStuck(update.before, after, update.value)) return null
	/* The read is the probe: the anonymous request went to it. */
	const readOp = run.probe
	return run.findings.backend(
		SELF_CHECK_ID,
		run.entity.name,
		"an update to the caller did not stick",
		`${update.op.operationId} set ${update.field.name} to ${JSON.stringify(update.value)}, and the next ${readOp.operationId} returned ${again.status} with ${JSON.stringify(after.where === "top" ? after.current : after.values)}.`,
		[wrote, again],
	)
}

/** A value the update can put back: what the field held, when it was a plain one. */
export function restorable(update: UpdateProbe): boolean {
	const current = update.before.current
	return typeof current === "string" || current === null || typeof current === "boolean"
}
