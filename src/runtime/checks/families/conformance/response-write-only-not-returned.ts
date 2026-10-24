import type { Check } from "../../core/check.ts"
import { defineCheck } from "../../core/define.ts"
import type { OperationModel } from "../../../../spec/graph/types.ts"
import type { JsonSchema } from "../../../../spec/types.ts"
import { type Exchange, isBodyRef } from "../../../exchange.ts"
import { ASSERTED, type Outcome, standDown } from "../../../finding.ts"
import { type Record_, recordOf, recordsFromList } from "../../../world/records.ts"
import type { CheckContext } from "../../core/context.ts"
import { cannot, ready } from "../../core/plan.ts"
import { requestSchemaOf } from "../../payloads/body.ts"
import { itemSchemaOf } from "../../payloads/item-schema.ts"
import { graded, isEventStream, ownOps } from "../../planning/subjects.ts"

const WRITE_ONLY = "response.write-only-not-returned"

/* A name or format that says the value is a credential: leaking one is a security defect, not drift. */
const SECRET_NAME = /pass(word)?|secret|token|api[-_]?key|private[-_]?key|credential/i

/*
 * The answers a writeOnly value must never reach: the item read and the listing, read later and by
 * anyone allowed to. The create's own answer goes to the caller who just sent the value, and handing a
 * generated key or secret back once there is a common, deliberate pattern; it is not judged.
 */
function answers(op: OperationModel): boolean {
	return op.action === "read" || op.action === "list"
}

/**
 * A property the document marks writeOnly is never sent back — OAS 3 makes it "relevant only for
 * request messages" — whatever additionalProperties says: an open schema accepts a leaked password,
 * so schema validation alone misses it. Every 2xx answer of this entity's item read and listing the
 * run drew is read for one, record by record. A credential-like field is a security
 * finding; any other is a spec bug. Nothing is sent.
 */
export const writeOnlyNotReturned: Check<{ fields: Map<string, JsonSchema> }> = defineCheck<{
	fields: Map<string, JsonSchema>
}>({
	plan: (ctx) => {
		if (ctx.readOp === undefined && ctx.listOp === undefined) return cannot()
		const fields = writeOnlyFields(ctx)
		return fields.size === 0 ? cannot() : ready({ fields })
	},
	id: WRITE_ONLY,
	judgesTranscript: true,
	needs: "a property the record's schema or a write's body marks writeOnly, and an item read or a listing",
	subjects: (entity, model) => ownOps(entity, model, answers),
	async run(ctx, { fields }): Promise<Outcome> {
		const judged = new Set<string>()
		const leaks = new Map<string, { exchange: Exchange; names: string[] }>()
		for (const listed of ctx.client.exchangesForEntity(ctx.entityName)) {
			const op = answeringOf(ctx, listed)
			if (op === undefined || leaks.has(op.operationId)) continue
			const exchange = await ctx.client.hydrate(listed)
			if (isEventStream(exchange, op) || isBodyRef(exchange.responseBody)) continue
			judged.add(op.operationId)
			const names = leakedNames(recordsIn(op, exchange.responseBody), fields)
			if (names.length > 0) leaks.set(op.operationId, { exchange, names })
		}
		if (judged.size === 0) return standDown("a 2xx answer of this entity's item read or listing")
		ctx.judged?.([...judged])
		let outcome: Outcome = ASSERTED
		for (const [operationId, { exchange, names }] of leaks) {
			const claim = {
				summary: `${operationId} answered a field the document marks writeOnly: ${names.join(", ")}`,
				detail:
					`${operationId} returned ${exchange.status} carrying ${names.join(", ")}, which the document marks ` +
					"writeOnly: a value a client sends and the server never returns.",
				evidence: [exchange],
			}
			const findings = ctx.findings.attributed([operationId])
			const secret = names.some((name) => isSecretLike(name, fields.get(name)))
			outcome = secret
				? findings.security(WRITE_ONLY, ctx.entityName, claim)
				: findings.spec(WRITE_ONLY, ctx.entityName, claim)
		}
		return outcome
	},
})

/** The writeOnly properties of the record's schema and of each write's request body, by name. */
function writeOnlyFields(ctx: CheckContext): Map<string, JsonSchema> {
	const record = itemSchemaOf({ listOp: ctx.listOp, model: ctx.model, readOp: ctx.readOp })
	const schemas = [
		record,
		...[ctx.createOp, ctx.updateOp].map((op) => (op === undefined ? null : requestSchemaOf(ctx, op))),
	]
	const fields = new Map<string, JsonSchema>()
	for (const schema of schemas) {
		const properties = (schema?.properties ?? {}) as Record<string, JsonSchema>
		for (const [name, property] of Object.entries(properties))
			if (property.writeOnly === true) fields.set(name, property)
	}
	return fields
}

/** The item read or listing an exchange answered with 2xx, when it is this entity's and graded. */
function answeringOf(ctx: CheckContext, exchange: Exchange): OperationModel | undefined {
	if (exchange.status < 200 || exchange.status >= 300 || exchange.superseded === true) return undefined
	const op = exchange.operationId === undefined ? undefined : ctx.model.byOperationId.get(exchange.operationId)
	if (op === undefined || op.entity !== ctx.entityName || !answers(op)) return undefined
	return graded(ctx, op) ? op : undefined
}

/** The records an answer carries: a listing's rows, else the one record where the operation keeps it. */
function recordsIn(op: OperationModel, body: unknown): Record_[] {
	if (op.action === "list") return recordsFromList(body, op.collection)
	const record = recordOf(op, body)
	return record === undefined ? [] : [record]
}

/** Whether a record holds the field with a value: null, absent and empty say nothing was returned. */
function holds(record: Record_, name: string): boolean {
	return Object.hasOwn(record, name) && record[name] !== null && record[name] !== ""
}

/** The writeOnly fields any of the records holds with a value. */
function leakedNames(records: readonly Record_[], fields: ReadonlyMap<string, JsonSchema>): string[] {
	return [...fields.keys()].filter((name) => records.some((record) => holds(record, name)))
}

function isSecretLike(name: string, schema: JsonSchema | undefined): boolean {
	return SECRET_NAME.test(name) || schema?.format === "password"
}
