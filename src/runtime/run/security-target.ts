/*
 * The record a write or item-read probe may target: one this run created, taken from the ledger, read
 * back as its creator so a write's body can be the record's current state. Never an id the run did
 * not create, and never a collection — a probe only ever sends to a record that already exists. The
 * parameter the record's id fills must name a record of its entity: `{token}` in
 * `/invites/{token}/accept` names an invite, so only an invite the run created fills it, never the
 * table the operation is filed under.
 *
 * A stage reads each record back once and shares the read with every probe kind and operation that
 * names it (`TargetReads`), until a write that may have changed it: the next probe reads it again.
 */

import { UnsatisfiedSecurity } from "../../client/credential-source.ts"
import { fillPath } from "../fill-path.ts"
import type { Probed, WriteTarget } from "../checks/core/operation-context.ts"
import type { Exchange } from "../exchange.ts"
import { owningEntityOf } from "../../spec/graph/roots.ts"
import type { OperationModel, SpecModel } from "../../spec/graph/types.ts"
import { recordOf } from "../world/records.ts"
import type { Disposable } from "../teardown/types.ts"
import type { RunContext } from "./context.ts"

/** What one read back gave: the record's current state, or why the probe is untested. */
type ReadBack = { current: unknown } | { untested: string }

/** One record's read back: the answer, the transcript length it is known current to, and the ids its path names. */
interface SharedRead {
	read: Promise<ReadBack>
	since: number
	ids: ReadonlySet<string>
}

/** The reads one security stage shares, keyed by record: its creator, the read, and the read's path. */
export interface TargetReads {
	held: Map<string, SharedRead>
}

/** A stage's shared reads: none yet. */
export function targetReads(): TargetReads {
	return { held: new Map() }
}

/**
 * The run-created record `op` can be probed against, read back (through the stage's `reads` when
 * given); undefined when there is none, and untested, citing the block, when its creator's credential
 * is BLOCKED.
 */
export async function recordTarget(
	ctx: RunContext,
	op: OperationModel,
	reads?: TargetReads,
): Promise<Probed<WriteTarget> | undefined> {
	const record = targetRecord(ctx, op)
	return record === undefined ? undefined : targetOf(ctx, op, record, reads)
}

/** The first record the run created (default: every one ledgered) that `op` names as its single record. */
export function targetRecord(
	ctx: Pick<RunContext, "ledger" | "model">,
	op: OperationModel,
	records: readonly Disposable[] = ctx.ledger.entries(),
): Disposable | undefined {
	return records.find(
		(record) =>
			itemParams(op, record) !== undefined && ownParam(ctx.model, op, record) && actsOn(ctx.model, op, record),
	)
}

/*
 * Whether `op` acts on the record rather than on a collection under it: another entity's create or
 * list (the rows under a table) is a collection route, never a probe's target.
 */
function actsOn(model: SpecModel, op: OperationModel, record: Disposable): boolean {
	if (record.entity === op.entity) return true
	return ![...model.entities.values()].some(
		(entity) => entity.create === op.operationId || entity.list === op.operationId,
	)
}

/* Whether the parameter the record's id fills names a record of the record's own entity. */
function ownParam(model: SpecModel, op: OperationModel, record: Disposable): boolean {
	const param = op.pathParams.find((name) => !(name in record.scope)) as string
	return owningEntityOf(model.operations, op.path, param) === record.entity
}

/**
 * `op`'s target on `record`, one `targetRecord` picked for it, read back as its creator: through the
 * stage's `reads` when given, so a read another probe made of it serves while nothing changed it.
 */
export async function targetOf(
	ctx: RunContext,
	op: OperationModel,
	record: Disposable,
	reads?: TargetReads,
): Promise<Probed<WriteTarget>> {
	/* `targetRecord` picks only a record the operation names. */
	const params = itemParams(op, record) as Record<string, string>
	const read = await readBack(ctx, { entity: record.entity, op, owner: record.owner.id, params }, reads)
	if ("untested" in read) return read
	return {
		current: read.current,
		entity: record.entity,
		id: record.id,
		owner: record.owner.id,
		params,
		path: fillPath(op.path, params),
	}
}

/*
 * The write's path parameters for this record: its creation scope, and the one remaining parameter
 * filled with its id. A write whose every parameter the scope already names is a collection write,
 * which has no single record to target.
 */
function itemParams(op: OperationModel, record: Disposable): Record<string, string> | undefined {
	const missing = op.pathParams.filter((name) => !(name in record.scope))
	if (missing.length !== 1) return undefined
	return { ...record.scope, [missing[0] as string]: record.id }
}

/** What a read back is for: the probed operation, the record's entity, its creator, and its path parameters. */
interface At {
	op: OperationModel
	entity: string
	owner: string
	params: Record<string, string>
}

/*
 * The record as its creator reads it now, out of any envelope, for a harmless body: by the read at
 * the probe's own path, else its entity's documented read. Undefined when neither exists or the read
 * does not show the record; nothing undocumented is ever sent. Shared through `reads` while no write
 * since may have changed the record; each probe gets its own copy to build a body from.
 */
async function readBack(ctx: RunContext, at: At, reads?: TargetReads): Promise<ReadBack> {
	const { model } = ctx
	const read =
		model.byRoute.get(`GET ${at.op.path}`) ?? model.byOperationId.get(model.entities.get(at.entity)?.read ?? "")
	if (read === undefined) return { current: undefined }
	const path = fillPath(read.path, at.params)
	if (reads === undefined) return readAs(ctx, { at, path, read })
	const key = `${at.owner} ${read.operationId} ${path}`
	let shared = reads.held.get(key)
	if (shared === undefined || changedSince(ctx, shared)) {
		const since = ctx.client.transcript.length
		shared = { ids: new Set(Object.values(at.params)), read: readAs(ctx, { at, path, read }), since }
		reads.held.set(key, shared)
	} else shared.since = ctx.client.transcript.length
	const answer = await shared.read
	return "current" in answer ? { current: structuredClone(answer.current) } : answer
}

const SAFE: ReadonlySet<string> = /* @__PURE__ */ new Set(["GET", "HEAD", "OPTIONS"])

/*
 * Whether a request since the read may have changed the record: a write, by anyone, whose path names
 * the record's id or an ancestor's, and that was not refused with a 4xx. One that went through changed
 * it; a server error or a lost answer may have.
 */
function changedSince(ctx: RunContext, shared: SharedRead): boolean {
	const { client } = ctx
	return client.transcript.slice(shared.since).some((exchange) => {
		if (SAFE.has(exchange.method) || (exchange.status >= 400 && exchange.status < 500)) return false
		return namesOf(client.relativePath(exchange.url), exchange).some((name) => shared.ids.has(name))
	})
}

/* The values a request's path holds: each segment as sent, and each parameter as its template decoded it. */
function namesOf(path: string, exchange: Exchange): string[] {
	return [...path.split("/"), ...Object.values(exchange.pathParams ?? {})]
}

/*
 * One read back as the record's creator. A creator whose credential is BLOCKED reads nothing, and the
 * probe is untested with the block as its reason.
 */
async function readAs(
	ctx: RunContext,
	{ at, path, read }: { at: At; path: string; read: OperationModel },
): Promise<ReadBack> {
	try {
		const answer = await ctx.client
			.readOnlyView({ purpose: "probe", subject: at.op.operationId })
			.get(path, { as: { principal: at.owner } })
		return { current: answer.status >= 200 && answer.status < 300 ? recordOf(read, answer.responseBody) : undefined }
	} catch (error) {
		if (!(error instanceof UnsatisfiedSecurity) || error.kind !== "blocked") return { current: undefined }
		const why = `${at.owner}'s credential is BLOCKED (${error.reason})`
		return { untested: `${at.op.operationId}'s target could not be read back: ${why}` }
	}
}
