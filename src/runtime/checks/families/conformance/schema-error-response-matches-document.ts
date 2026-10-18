import { defineCheck } from "../../core/define.ts"
import type { OperationModel } from "../../../../spec/graph/types.ts"
import type { OperationObject } from "../../../../spec/types.ts"
import type { Exchange } from "../../../exchange.ts"
import { isDocumentedFeatureGateDenial } from "../../../feature-gate.ts"
import { fillPath } from "../../../fill-path.ts"
import { ASSERTED, type FindingCollector, type Outcome, standDown } from "../../../finding.ts"
import type { SchemaValidator } from "../../../validate.ts"
import type { CheckContext } from "../../core/context.ts"
import { cannot, ready } from "../../core/plan.ts"
import { absentId } from "../../payloads/identity.ts"
import { asProbe } from "../../planning/refusal.ts"
import { graded, itemParamFor, ownOps, subjectsOf } from "../../planning/subjects.ts"

export const errorSchemaHonoured = defineCheck<{
	readOp: OperationModel
	validator: SchemaValidator
	raw: OperationObject
}>({
	plan: (ctx) => {
		const { readOp, validator } = ctx
		if (readOp === undefined || validator === undefined) return cannot()
		const raw = ctx.model.rawOperations.get(readOp.operationId)
		return raw === undefined ? cannot() : ready({ raw, readOp, validator })
	},
	id: "schema.error-response-matches-document",
	judgesTranscript: true,
	needs: "a documented error schema on the item route",
	subjects: (entity, model) => [
		...new Set([
			...subjectsOf.readAndGated(entity, model),
			...ownOps(entity, model, (op) => op.unique !== null && op.unique.length > 0),
		]),
	],
	async run(ctx, { raw, readOp, validator }): Promise<Outcome> {
		/* An empty list has no id to miss. Probing one would grade the get without a row. */
		if (ctx.createOp === undefined && ctx.records.length === 0) return standDown("the list returned no id")
		const judge: ErrorJudge = { check: this.id, ctx, validator }
		const judged: string[] = []
		if (graded(ctx, readOp)) {
			await probeMissingItemError(judge, readOp, raw)
			judged.push(readOp.operationId)
		}
		judged.push(...(await judgeExpectedRefusals(judge)))
		ctx.judged?.([...new Set(judged)])
		return ASSERTED
	},
})

/** What judging an error body needs: the check, its context, and the validator. */
interface ErrorJudge {
	check: string
	ctx: CheckContext
	validator: SchemaValidator
}

/** An error body's operation, and where a schema that cannot compile and a drifted body are reported. */
interface ErrorSubject {
	operationId: string
	raw: OperationObject
	gaps: FindingCollector
	drift: FindingCollector
}

/**
 * Expected refusals are coverage for the check that drew them, not for the error schema: a
 * documented feature-gate 403 or a unique-conflict 409 still has to carry the body the document
 * declares. Judged here, over everything this entity's run drew; returns the operations judged.
 */
async function judgeExpectedRefusals(judge: ErrorJudge): Promise<string[]> {
	const { ctx } = judge
	const judged: string[] = []
	for (const listed of ctx.client.exchangesForEntity(ctx.entityName)) {
		/* Error bodies are what this judges; one moved out of memory is read back. */
		const exchange = listed.status >= 400 ? await ctx.client.hydrate(listed) : listed
		if (exchange.superseded === true) continue
		const op = exchange.operationId === undefined ? undefined : ctx.model.byOperationId.get(exchange.operationId)
		if (op === undefined || op.entity !== ctx.entityName || !graded(ctx, op)) continue
		const gated = isDocumentedFeatureGateDenial(op, exchange.status, exchange.responseBody)
		const conflict = exchange.status === 409 && op.unique !== null && op.unique.length > 0
		if (!gated && !conflict) continue
		judged.push(op.operationId)
		errorBodyDrift(judge, op, exchange)
	}
	return judged
}

/** Reports an error body that fails the schema its operation declares for that status. */
function errorBodyDrift(judge: ErrorJudge, op: OperationModel, exchange: Exchange): void {
	const raw = judge.ctx.model.rawOperations.get(op.operationId)
	if (raw === undefined || !judge.validator.documents(raw, exchange.status)) return
	const findings = judge.ctx.findings.attributed([op.operationId])
	judgeErrorBody(judge, { drift: findings, gaps: findings, operationId: op.operationId, raw }, exchange)
}

/** Asks for an id no record holds, and judges the error body that comes back. */
async function probeMissingItemError(judge: ErrorJudge, readOp: OperationModel, raw: OperationObject): Promise<void> {
	const { ctx } = judge
	const missing = absentId(ctx)
	if (missing === null) return
	const params = { ...ctx.scope, ...itemParamFor(ctx, missing) }
	const exchange = await asProbe(ctx).client.get(fillPath(readOp.path, params), { headers: ctx.auth() })
	if (exchange.status < 400 || !judge.validator.documents(raw, exchange.status)) return
	const subject = {
		drift: ctx.findings.attributed([readOp.operationId]),
		gaps: ctx.findings,
		operationId: readOp.operationId,
		raw,
	}
	judgeErrorBody(judge, subject, exchange)
}

/** Validates an error body against its documented schema: a gap when that cannot compile, else drift. */
function judgeErrorBody(judge: ErrorJudge, subject: ErrorSubject, exchange: Exchange): void {
	const { check, ctx, validator } = judge
	const { operationId } = subject
	const result = validator.validate(operationId, subject.raw, exchange.status, exchange.responseBody)
	if (result.unchecked !== undefined) {
		subject.gaps.gap(
			check,
			ctx.entityName,
			`${operationId} ${exchange.status} has a schema that cannot be compiled`,
			`AJV refused the documented schema, so the body was not validated: ${result.unchecked}`,
		)
		return
	}
	if (result.ok) return
	subject.drift.spec(
		check,
		ctx.entityName,
		`${exchange.status} error body does not match its documented schema`,
		`${operationId} returned ${exchange.status} with a body that fails the schema the ` +
			`document declares for it: ${result.errors.join("; ")}. Clients that parse errors ` +
			"from the spec will not understand this response.",
		[exchange],
	)
}
