import type { Hooks } from "../../config/types/hooks.ts"
import type { Client } from "../../client/client.ts"
import type { EntityModel, OperationModel, SpecModel } from "../../spec/graph/types.ts"
import type { Exchange } from "../exchange.ts"
import { ASSERTED, type FindingCollector, type Outcome } from "../finding.ts"
import { runSelfActions } from "./actions.ts"
import { createCaller, failedToCreate } from "./create.ts"
import { SELF_CHECK_ID, selfOperationIds, selfReadIds } from "./operations.ts"
import { operation, pathOf, sendUpdate } from "./requests.ts"
import {
	answeredWithoutToken,
	echoMissed,
	notStuck,
	readRefused,
	restorable,
	type SelfRun,
	updatedAlone,
	updateProbe,
	writeRefused,
} from "./verdicts.ts"

export interface SelfInput {
	auth: () => Record<string, string>
	client: Client
	entity: EntityModel
	findings: FindingCollector
	model: SpecModel
	nonce?: string
	resolveInput?: Hooks["resolveInput"]
	seed?: number
}

/** The operations the check calls, or why it cannot call them. */
function selfRun(input: SelfInput): SelfRun | Outcome {
	const { entity, model } = input
	const readOp = operation(model, entity.read)
	const updateOp = operation(model, entity.update)
	const findings = input.findings.attributed(selfOperationIds(entity, model)).ownedBy(SELF_CHECK_ID)
	const probe = readOp ?? updateOp
	if (probe === undefined) return findings.unresolved(SELF_CHECK_ID, entity.name, "no read or update")
	const probePath = pathOf(probe)
	if (probePath === null) {
		return findings.unresolved(SELF_CHECK_ID, entity.name, `${probe.operationId} needs a path id`)
	}
	/* Every read id names an operation of the model; the first of them is the entity's read. */
	const readOps = selfReadIds(entity).map((id) => operation(model, id) as OperationModel)
	return { entity, findings, probe, probePath, readOp, readOps, updateOp }
}

export async function runSelfIdentity(input: SelfInput): Promise<Outcome> {
	const { client, auth } = input
	const run = selfRun(input)
	if ("kind" in run) return run
	const { findings, probe, probePath, readOp } = run
	const anonymous = await client.request(probe.method, probePath, {
		headers: {},
		operationId: probe.operationId,
		skipAuthRefresh: true,
	})
	if (anonymous.status !== 401) return answeredWithoutToken(run, anonymous)
	if (readOp === undefined) {
		/* No read: the probe is the update. */
		const wrote = await sendUpdate(input, { op: probe, path: probePath }, { note: "Oat" })
		return updatedAlone(run, anonymous, wrote)
	}

	const created = await createCaller(input, findings)
	if (failedToCreate(created)) return created
	const reads: Exchange[] = []
	for (const op of run.readOps) {
		const readPath = pathOf(op)
		if (readPath === null)
			return findings.unresolved(SELF_CHECK_ID, run.entity.name, `${op.operationId} needs a path id`)
		const read = await client.request(op.method, readPath, { headers: auth, operationId: op.operationId })
		const refused = readRefused(run, op, anonymous, read)
		if (refused !== null) return refused
		reads.push(read)
	}
	/* The entity's read is the first of its reads, so one was made. */
	const read = reads[0] as Exchange
	const missed = echoMissed(run, created, readOp, read)
	if (missed !== null) return missed

	const acted = await runSelfActions(input, findings, created)
	if (acted !== null) return acted

	const update = updateProbe(run, input.model, read)
	if ("kind" in update) return update
	const { field } = update
	const wrote = await sendUpdate(input, update, { [field.name]: update.value })
	const writeFailed = writeRefused(run, update, read, wrote)
	if (writeFailed !== null) return writeFailed
	/* The read's path was filled in the loop above, so it needs no id. */
	const again = await client.request(readOp.method, probePath, { headers: auth, operationId: readOp.operationId })
	const lost = notStuck(run, update, wrote, again)
	if (lost !== null) return lost
	if (restorable(update)) await sendUpdate(input, update, { [field.name]: update.before.current })
	return ASSERTED
}
