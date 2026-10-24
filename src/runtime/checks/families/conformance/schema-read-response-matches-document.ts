import type { Check } from "../../core/check.ts"
import { defineCheck } from "../../core/define.ts"
import type { OperationModel } from "../../../../spec/graph/types.ts"
import { type Exchange, isBodyRef } from "../../../exchange.ts"
import { ASSERTED, asserted, type Outcome, standDown } from "../../../finding.ts"
import { judges } from "../../../probe-judging.ts"
import type { SchemaValidator } from "../../../validate.ts"
import type { CheckContext } from "../../core/context.ts"
import { cannot, ready } from "../../core/plan.ts"
import { graded, isEventStream, subjectsOf } from "../../planning/subjects.ts"

const READ_SCHEMA = "schema.read-response-matches-document"

/* The schema errors a finding quotes: enough to locate the divergence, few enough to read. */
const QUOTED_ERRORS = 4

/** Why an operation's answers could not be held to its document, or how the first one departed from it. */
type Judged = { exchange: Exchange; errors: string[] } | { exchange: Exchange; unchecked: string }

/**
 * Every 2xx answer of an entity's item read and listing must fit the schema the document declares
 * for its status, as `schema.success-response-matches-document` holds the create's. A read that
 * answers the record under another key than documented, or with fields the document does not
 * describe, breaks every client generated from it. The check judges the answers the run already
 * drew and sends nothing; a sparse-fieldset answer, asked for less than the record, is not held to
 * the record's schema, and a body the transcript holds only by its hash is not validated at all.
 */
export const readSchemaHonoured: Check<{ validator: SchemaValidator }> = defineCheck<{ validator: SchemaValidator }>({
	plan: (ctx) => {
		const { validator } = ctx
		if (validator === undefined || (ctx.readOp === undefined && ctx.listOp === undefined)) return cannot()
		return ready({ validator })
	},
	id: READ_SCHEMA,
	judgesTranscript: true,
	needs: "an item read or a listing with a documented success schema",
	subjects: subjectsOf.readAndList,
	async run(ctx, { validator }): Promise<Outcome> {
		const { judged, departed, unseen } = await survey(ctx, validator)
		const note = [...unseen]
			.map(
				([operationId, bytes]) =>
					`${operationId} answered ${bytes} bytes, over the in-memory limit; its body was not validated`,
			)
			.join("; ")
		if (judged.size === 0) return standDown(note || "a 2xx answer of this entity's item read or listing")
		ctx.judged?.([...judged])
		let outcome: Outcome = ASSERTED
		for (const [operationId, found] of departed) outcome = reportDeparture(ctx, operationId, found) ?? outcome
		if (note === "") return outcome
		return outcome.kind === "finding" ? { ...outcome, note } : asserted(note)
	},
})

/** What the run's answers say: the operations judged, the first departure of each, and each held only by reference with its size. */
interface Survey {
	judged: Set<string>
	departed: Map<string, Judged>
	/* Said, never skipped silently: a body past the inline limit is held by its hash alone. */
	unseen: Map<string, number>
}

async function survey(ctx: CheckContext, validator: SchemaValidator): Promise<Survey> {
	const found: Survey = { departed: new Map(), judged: new Set(), unseen: new Map() }
	for (const listed of ctx.client.exchangesForEntity(ctx.entityName)) {
		const op = readOf(ctx, listed)
		if (op === undefined || found.departed.has(op.operationId)) continue
		const raw = ctx.model.rawOperations.get(op.operationId)
		if (raw === undefined || !validator.documents(raw, listed.status)) continue
		const exchange = await ctx.client.hydrate(listed)
		if (isEventStream(exchange, op)) continue
		if (isBodyRef(exchange.responseBody)) {
			if (!found.unseen.has(op.operationId)) found.unseen.set(op.operationId, exchange.responseBody.bytes)
			continue
		}
		found.judged.add(op.operationId)
		const result = validator.validate(op.operationId, raw, exchange)
		if (result.unchecked !== undefined) found.departed.set(op.operationId, { exchange, unchecked: result.unchecked })
		else if (!result.ok) found.departed.set(op.operationId, { errors: result.errors, exchange })
	}
	return found
}

/** One operation's departure, reported: a spec finding, whose outcome is returned, or a gap for a schema that cannot compile. */
function reportDeparture(ctx: CheckContext, operationId: string, found: Judged): Outcome | undefined {
	const findings = ctx.findings.attributed([operationId])
	const { exchange } = found
	if ("unchecked" in found) {
		findings.gap(READ_SCHEMA, ctx.entityName, {
			summary: `${operationId} ${exchange.status} has a schema that cannot be compiled`,
			detail: `AJV refused the documented schema, so the body was not validated: ${found.unchecked}`,
		})
		return undefined
	}
	return findings.spec(READ_SCHEMA, ctx.entityName, {
		summary: `${operationId} answered a body its documented schema does not describe`,
		detail:
			`${operationId} returned ${exchange.status} with a body that fails the declared schema: ` +
			`${found.errors.slice(0, QUOTED_ERRORS).join("; ")}. Either the handler answers other than it ` +
			"promises or the document is out of date — both break generated clients.",
		evidence: [exchange],
	})
}

/**
 * The read an exchange judges: this entity's item read or listing, graded by this run, answered 2xx
 * to an ordinary request for the whole record. A probe's answer is the security checks' to judge,
 * and an answer asked again after a refresh or a wait is not the backend's verdict.
 */
function readOf(ctx: CheckContext, exchange: Exchange): OperationModel | undefined {
	const operationId = exchange.operationId
	if (operationId === undefined || (operationId !== ctx.readOp?.operationId && operationId !== ctx.listOp?.operationId))
		return undefined
	if (exchange.status < 200 || exchange.status >= 300 || exchange.superseded === true) return undefined
	if (!judges(READ_SCHEMA, exchange)) return undefined
	const op = ctx.model.byOperationId.get(operationId)
	if (op === undefined || !graded(ctx, op) || projected(op, exchange)) return undefined
	return op
}

/** Whether the request asked for a sparse fieldset: `select=…`, or `fields[resource]=…` under a bracketed grammar. */
function projected(op: OperationModel, exchange: Exchange): boolean {
	const parameter = op.conventions.select
	if (parameter === undefined) return false
	const names = [...new URL(exchange.url, "http://oat.invalid").searchParams.keys()]
	return names.some((name) => name === parameter || name.startsWith(`${parameter}[`))
}
