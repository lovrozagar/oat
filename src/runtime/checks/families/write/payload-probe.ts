import type { OperationModel } from "../../../../spec/graph.ts"
import type { Exchange } from "../../../exchange.ts"
import { fillPath } from "../../../fill-path.ts"
import { type Outcome, standDown } from "../../../finding.ts"
import type { StringPayload } from "../../../payloads.ts"
import { createdRecordOf, type Record_ } from "../../../world.ts"
import type { WriteContext } from "../../core/context.ts"
import { readRecord, scratchRecord, updateRequest } from "../../isolation/scratch.ts"
import { requestSchemaOf, validBody } from "../../payloads/body.ts"
import { payloadLanes } from "../../payloads/lanes.ts"
import { standDownForFeatureGate, standDownForRateLimit } from "../../planning/stand-down.ts"
import { itemParamFor } from "../../planning/subjects.ts"
import { ASCII_PAYLOAD_PROBE, PAYLOAD_LANES, type PayloadField } from "./payload-cases.ts"
import { confirmedIdentity } from "./records.ts"

/*
 * What `payload.string-survives` writes through, reads back from and cleans up after. Writes go to
 * a record made for the check; with no update, each write is a create of its own and is removed
 * once read back.
 */

export interface PayloadProbe {
	ctx: WriteContext
	check: string
	field: PayloadField
	readOp: OperationModel
	writeOp: OperationModel
	/** Each lane writes its own record; a PUT carries that record's representation, not the first's. */
	currents: Map<string, Record_>
	/** The first record written to: the scratch record through an update, `""` through create. */
	id: string
}

/** Every case on its own: what happened to the value, or why the run must stop. */
export type CaseResult =
	| { kind: "kept" }
	| { kind: "failed"; line: string; evidence: Exchange[] }
	| { kind: "stop"; outcome: Outcome }
	| { kind: "lost-auth" }

/** Whether the probe writes through an update, to records it made, rather than by creating one per value. */
export function viaPatch(probe: PayloadProbe): boolean {
	return probe.ctx.updateOp !== undefined
}

export async function writeField(probe: PayloadProbe, value: unknown, recordId: string): Promise<Exchange> {
	const { ctx, field } = probe
	const updateOp = ctx.updateOp
	if (updateOp !== undefined) {
		const current = probe.currents.get(recordId) ?? probe.currents.get(probe.id) ?? {}
		const update = await updateRequest(ctx, updateOp, current, { [field.name]: value })
		return ctx.client.request(
			update.method,
			fillPath(updateOp.path, { ...ctx.scope, ...itemParamFor(ctx, recordId) }),
			{
				...update.options,
				headers: ctx.auth(),
				operationId: updateOp.operationId,
			},
		)
	}
	const createOp = ctx.createOp
	if (createOp === undefined) throw new Error("payload probe has no write operation")
	const body = { ...validBody(ctx, requestSchemaOf(ctx, createOp) ?? {}), [field.name]: value }
	return ctx.client.request("POST", fillPath(createOp.path, ctx.scope), { body, headers: ctx.auth() })
}

export async function readField(
	probe: PayloadProbe,
	recordId: string,
): Promise<{ exchange: Exchange; value: unknown }> {
	const { ctx, readOp } = probe
	const exchange = await ctx.client.get(fillPath(readOp.path, { ...ctx.scope, ...itemParamFor(ctx, recordId) }), {
		headers: ctx.auth(),
	})
	return { exchange, value: readRecord(readOp, exchange)?.[probe.field.name] }
}

export async function removeRecord(probe: PayloadProbe, recordId: string): Promise<void> {
	const { ctx } = probe
	if (viaPatch(probe) || ctx.deleteOp === undefined) return
	await ctx.client.request("DELETE", fillPath(ctx.deleteOp.path, { ...ctx.scope, ...itemParamFor(ctx, recordId) }), {
		headers: ctx.auth(),
	})
}

export async function identityOf(probe: PayloadProbe, exchange: Exchange): Promise<string | undefined> {
	const { ctx } = probe
	const value = createdRecordOf(exchange.responseBody, ctx.identity, exchange.requestBody)[ctx.identity]
	if (value !== undefined && value !== null) return String(value)
	/* Only a successful write made a record, and only the read under the id it was sent proves
	 * which; the field under test is left out, since mangling it is what this check measures. */
	if (exchange.status < 200 || exchange.status >= 300) return undefined
	return (await confirmedIdentity(ctx, ctx.client, exchange.requestBody, [probe.field.name]))?.id
}

function failedLine(payload: StringPayload, outcome: string): string {
	return `${payload.id} (${payload.why}): ${outcome}`
}

/** A case whose write was refused: a 401 that an ASCII retry passes, or any other 4xx/5xx. */
async function refusedCase(
	probe: PayloadProbe,
	payload: StringPayload,
	written: Exchange,
	recordId: string,
): Promise<CaseResult> {
	const sent = `sent ${JSON.stringify(payload.value)}, got HTTP ${written.status}`
	if (written.status === 401) {
		const retry = await writeField(probe, ASCII_PAYLOAD_PROBE, recordId)
		if (retry.status >= 400) return { kind: "lost-auth" }
		return { evidence: [written], kind: "failed", line: failedLine(payload, sent) }
	}
	if (!viaPatch(probe) && written.status < 500) {
		const extra = await identityOf(probe, written)
		if (extra !== undefined) await removeRecord(probe, extra)
	}
	return { evidence: [written], kind: "failed", line: failedLine(payload, sent) }
}

export async function runCase(probe: PayloadProbe, payload: StringPayload, recordId: string): Promise<CaseResult> {
	const { ctx, check, writeOp } = probe
	const written = await writeField(probe, payload.value, recordId)
	if (standDownForFeatureGate(ctx, writeOp, written, check)) {
		return { kind: "stop", outcome: standDown("a documented feature gate refused the request") }
	}
	if (written.status === 401) return refusedCase(probe, payload, written, recordId)
	if (standDownForRateLimit(ctx, written, check)) {
		return { kind: "stop", outcome: standDown("the request was rate limited") }
	}
	if (written.status === 404 || written.status === 409 || written.status === 415) return { kind: "kept" }
	if (written.status >= 400) return refusedCase(probe, payload, written, recordId)
	const writtenId = viaPatch(probe) ? recordId : await identityOf(probe, written)
	if (writtenId === undefined) {
		return {
			evidence: [written],
			kind: "failed",
			line: failedLine(payload, "write succeeded but returned no identity"),
		}
	}
	const got = await readField(probe, writtenId)
	if (!viaPatch(probe)) await removeRecord(probe, writtenId)
	if (got.value === payload.value) return { kind: "kept" }
	return {
		evidence: [written, got.exchange],
		kind: "failed",
		line: failedLine(payload, `sent ${JSON.stringify(payload.value)}, got ${JSON.stringify(got.value)}`),
	}
}

/*
 * Fanned across records: each lane takes every n-th case on a record of its own, and the
 * lanes run together. Through an update the lanes need records of their own — one write
 * must never be read back as another's — so the extra ones are made here; through create,
 * every case is a record of its own already.
 */
export async function laneRecords(probe: PayloadProbe, cases: number): Promise<string[]> {
	const records = [probe.id]
	if (!viaPatch(probe)) return records
	while (records.length < Math.min(PAYLOAD_LANES, cases)) {
		const made = await scratchRecord(probe.ctx, probe.check)
		if ("outcome" in made) break
		records.push(made.scratch.id)
		probe.currents.set(made.scratch.id, made.scratch.record)
	}
	return records
}

/**
 * Every case's result, by its place in `cases`; a case after a stop or lost authentication is never
 * run. With no records of its own, a lane writes to the probe's first.
 */
export async function runLanes(
	probe: PayloadProbe,
	cases: readonly StringPayload[],
	records: readonly string[],
): Promise<Array<CaseResult | undefined>> {
	const lanes = payloadLanes({
		cases: cases.length,
		max: PAYLOAD_LANES,
		records: records.length,
		viaPatch: viaPatch(probe),
	})
	const results = Array.from<CaseResult | undefined>({ length: cases.length })
	let stopped = false
	await Promise.all(
		Array.from({ length: lanes }, async (_, lane) => {
			const recordId = records[lane % records.length] ?? probe.id
			for (const [index, payload] of cases.entries()) {
				if (index % lanes !== lane) continue
				if (stopped) return
				const result = await runCase(probe, payload, recordId)
				results[index] = result
				if (result.kind === "stop" || result.kind === "lost-auth") stopped = true
			}
		}),
	)
	return results
}
