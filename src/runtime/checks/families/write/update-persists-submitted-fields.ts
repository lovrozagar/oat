import type { Check } from "../../core/check.ts"
import { defineCheck } from "../../core/define.ts"
import type { OperationModel } from "../../../../spec/graph/types.ts"
import type { JsonSchema } from "../../../../spec/types.ts"
import type { Exchange } from "../../../exchange.ts"
import { fillPath } from "../../../fill-path.ts"
import { ASSERTED, asserted, type Outcome, standDown } from "../../../finding.ts"
import type { Record_ } from "../../../world/records.ts"
import type { CheckContext, WriteContext } from "../../core/context.ts"
import { cannot, ready } from "../../core/plan.ts"
import { readRecord, scratchRecord } from "../../isolation/scratch.ts"
import { changedValue, requestSchemaOf, validBody, withheldProperties } from "../../payloads/body.ts"
import { recordUpdateDrops } from "../../payloads/update-drops.ts"
import { itemParamFor, subjectsOf } from "../../planning/subjects.ts"

const ID = "update.persists-submitted-fields"
/** At most this many single-field updates when the combined one is refused. */
const MAX_ALONE = 8
/* A status, state, plan or tier enum is a lifecycle switch: changing it can suspend or bill the record. */
const LIFECYCLE = /(^|_)(status|state|plan|tier)$/i

interface Plan {
	updateOp: OperationModel
	readOp: OperationModel
	/** The fields the update offers that a read returns and a change cannot set off a side effect. */
	offered: string[]
}

/** The update's own answer and a read past the cache: the two witnesses of what was stored. */
interface Witnesses {
	answer: Record_ | undefined
	back: Record_ | undefined
}

/**
 * An update must store what it was sent. One update, on a record this check made, carries a new
 * value for every field it offers that a read returns. A field counts as dropped only when neither
 * the update's answer nor a read past the cache holds it as sent, as `create.persists-submitted-fields`
 * judges a create. What it drops is remembered, so every later check picks around it.
 */
export const updatePersistsFields: Check<Plan> = defineCheck<Plan>({
	plan: (ctx) => {
		const { createOp, readOp, updateOp } = ctx
		if (createOp === undefined || readOp === undefined || updateOp === undefined) return cannot()
		const offered = offeredFields(ctx, updateOp)
		return offered.length === 0
			? cannot("an update that offers a field a read returns")
			: ready({ offered, readOp, updateOp })
	},
	dependsOn: ["create.persists-submitted-fields"],
	id: ID,
	mutates: true,
	needs: "a create, an update and an item read",
	subjects: subjectsOf.update,
	async run(ctx, plan): Promise<Outcome> {
		const made = await scratchRecord(ctx, ID)
		if ("outcome" in made) return made.outcome
		const params = { ...ctx.scope, ...itemParamFor(ctx, made.scratch.id) }
		const read = () => ctx.client.get(fillPath(plan.readOp.path, params), { as: { principal: ctx.actor.id } })
		const before = await read()
		const original = before.status < 300 ? readRecord(plan.readOp, before) : undefined
		if (original === undefined) {
			return ctx.findings.unresolved(ID, ctx.entityName, `reading the record returned ${before.status}`)
		}
		const changes = changesFor(ctx, plan, original)
		if (Object.keys(changes).length === 0) return standDown("no offered field has another valid value")
		const outcome = await updateAndJudge(ctx, { changes, path: fillPath(plan.updateOp.path, params), plan, read })
		recordUpdateDrops(ctx, outcome.dropped)
		return judge(ctx, outcome)
	},
})

/** The update body's fields a read returns, none fixed, secret, privileged or a lifecycle switch. */
function offeredFields(ctx: CheckContext, updateOp: OperationModel): string[] {
	const schema = requestSchemaOf(ctx, updateOp)
	const properties = (schema?.properties ?? {}) as Record<
		string,
		JsonSchema & { readOnly?: unknown; writeOnly?: unknown }
	>
	const fixed = new Set([
		...updateOp.immutable,
		...updateOp.generated,
		...updateOp.privileged,
		...withheldProperties(ctx, updateOp),
		ctx.identity,
	])
	return Object.entries(properties)
		.filter(([name, field]) => !fixed.has(name) && field.readOnly !== true && field.writeOnly !== true)
		.filter(([name, field]) => !(LIFECYCLE.test(name) && Array.isArray(field.enum)))
		.map(([name]) => name)
}

/*
 * A value per offered field the record holds: the salted valid body's, unique to this check, so a
 * rename never takes a name another check's record will want; else a changed value.
 */
function changesFor(ctx: WriteContext, plan: Plan, original: Record_): Record<string, unknown> {
	const schema = requestSchemaOf(ctx, plan.updateOp)
	const fresh = schema === null ? {} : validBody(ctx, schema)
	const changes: Record<string, unknown> = {}
	for (const field of plan.offered) {
		if (!Object.hasOwn(original, field)) continue
		const salted = fresh[field]
		const next =
			salted !== undefined && JSON.stringify(salted) !== JSON.stringify(original[field])
				? salted
				: changedValue(ctx, field, original[field], plan.updateOp)
		if (next !== undefined) changes[field] = next
	}
	return changes
}

interface Judged {
	dropped: string[]
	refused: Array<{ field: string; status: number }>
	evidence: Exchange[]
}

/** One combined update; when it is refused, each field alone (at most MAX_ALONE), so one bad field hides none. */
async function updateAndJudge(
	ctx: WriteContext,
	run: { changes: Record<string, unknown>; path: string; plan: Plan; read: () => Promise<Exchange> },
): Promise<Judged> {
	const send = (fields: Record<string, unknown>) => sendUpdate(ctx, { fields, path: run.path, plan: run.plan })
	const combined = await send(run.changes)
	if (combined.status < 300) return witnessed(run, [combined, Object.entries(run.changes)])
	const judged: Judged = { dropped: [], evidence: [], refused: [] }
	for (const [field, value] of Object.entries(run.changes).slice(0, MAX_ALONE)) {
		const alone = await send({ [field]: value })
		if (alone.status >= 300) judged.refused.push({ field, status: alone.status })
		else mergeInto(judged, await witnessed(run, [alone, [[field, value]]]))
	}
	return judged
}

function mergeInto(target: Judged, more: Judged): void {
	target.dropped.push(...more.dropped)
	target.evidence.push(...more.evidence)
}

async function sendUpdate(
	ctx: WriteContext,
	{ fields, path, plan }: { fields: Record<string, unknown>; path: string; plan: Plan },
): Promise<Exchange> {
	const schema = requestSchemaOf(ctx, plan.updateOp)
	/* A PUT replaces the record, so it carries a whole valid body; a PATCH only the fields. */
	const whole = plan.updateOp.method.toUpperCase() === "PATCH" || schema === null ? {} : validBody(ctx, schema)
	return ctx.client.request(plan.updateOp.method, path, {
		as: { principal: ctx.actor.id },
		body: { ...whole, ...fields },
	})
}

/** Whether `record` holds the field as it was sent. */
function holds(record: Record_ | undefined, [key, value]: [string, unknown]): boolean {
	return record !== undefined && Object.hasOwn(record, key) && JSON.stringify(record[key]) === JSON.stringify(value)
}

/** The fields neither the update's answer nor a read past the cache holds as sent. */
async function witnessed(
	run: { plan: Plan; read: () => Promise<Exchange> },
	[update, sent]: [Exchange, Array<[string, unknown]>],
): Promise<Judged> {
	const after = await run.read()
	const seen: Witnesses = {
		answer: readRecord(run.plan.updateOp, update),
		back: after.status < 300 ? readRecord(run.plan.readOp, after) : undefined,
	}
	const dropped = sent.filter((field) => !holds(seen.answer, field) && !holds(seen.back, field)).map(([key]) => key)
	return { dropped, evidence: dropped.length === 0 ? [] : [update, after], refused: [] }
}

function refusedNote(refused: Judged["refused"]): string {
	const fields = refused.map(({ field, status }) => `${field} on its own (${status})`).join(", ")
	return `the update refused ${fields}; every other field it was sent was stored`
}

function judge(ctx: WriteContext, judged: Judged): Outcome {
	if (judged.dropped.length === 0) return judged.refused.length === 0 ? ASSERTED : asserted(refusedNote(judged.refused))
	const named = judged.dropped.map((field) => `"${field}"`).join(", ")
	return ctx.findings.backend(ID, ctx.entityName, {
		detail:
			`the update answered success and stored none of ${named} as sent: neither its answer nor a read ` +
			"past the cache shows them. Callers are told the write succeeded." +
			(judged.refused.length === 0 ? "" : ` Also, ${refusedNote(judged.refused)}.`),
		evidence: judged.evidence.slice(0, 4),
		summary: "update silently discards submitted fields",
	})
}
