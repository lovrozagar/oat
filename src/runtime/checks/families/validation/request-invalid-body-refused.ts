import type { OperationCheck } from "../../core/check.ts"
/*
 * A write must refuse a body its schema rules out. The validation.*-enforced checks grade creates;
 * this one grades every other write that takes a JSON body, by one invalid body each (`invalidChoice`):
 * any 4xx passes, and a 2xx or a 5xx is BACKEND_BUG.
 *
 * Planned per operation, so the security stage schedules it after the lanes, alone and in order. A
 * write to one record goes only to a record the run created (`ctx.target`), as its creator, with the
 * record's current state as the rest of the body; an action's addresses reach nothing (`undeliverable`).
 * A write outside a record is never sent, since what
 * it does cannot be undone, except a POST open to all (`security: []`) that the document declares a
 * signup (`x-fresh-principal`); any other open POST could be a sign-in, where even a malformed body can
 * count toward a lockout, so it is never sent. The signup goes anonymously, as a probe, so a 2xx is taken as applied, ledgered when its answer names a record that
 * reads back and otherwise reported as a record that may remain. An operation a credential recipe
 * names (a login, a token grant, a refresh, a revoke, a mint) is never sent.
 */

import type { Actor } from "../../../../client/credential-source.ts"
import { messageOf } from "../../../../errors/message.ts"
import { fillPath } from "../../../fill-path.ts"
import { ASSERTED, type Outcome } from "../../../finding.ts"
import { buildCohort, type CohortMember } from "../../../fixture.ts"
import type { Exchange } from "../../../exchange.ts"
import { requestContent } from "../../../../spec/collection/request.ts"
import type { ResolvedSecurity } from "../../../../spec/security/requirements.ts"
import type { OperationObject, JsonSchema } from "../../../../spec/types.ts"
import { defineCheck } from "../../core/define.ts"
import { isReadMethod, targetPlan } from "../../core/operation.ts"
import type { OperationContext } from "../../core/operation-context.ts"
import { andThen, cannot, type Plan, ready } from "../../core/plan.ts"
import { type Address, acceptorOf, send } from "../security/probing.ts"
import { currentOf, writableBody } from "../security/writable.ts"
import { type InvalidChoice, invalidChoice, invalidated } from "./invalid-body.ts"
import { undeliverable } from "./undeliverable.ts"

const ID = "request.invalid-body-refused"

/** Why a write outside a run-created record is not probed. */
export const SIDE_EFFECT = "an action outside a run-created record could apply a side effect the run cannot undo"

/** Why an open POST the document does not declare a signup is not probed. */
export const SIGN_IN =
	"an open POST the document marks x-fresh-principal; any other could be a sign-in, where a malformed body can count toward a lockout"

/** The invalid request: where it goes, who sends it, how its body is wrong, and whether it is an open POST. */
interface InvalidProbe {
	address: Address
	as: Actor
	choice: InvalidChoice
	open: boolean
}

/** The operation's JSON request body: the media type it is sent as, and the choice of what to break. */
interface Subject {
	mediaType: string
	schema: JsonSchema
	choice: InvalidChoice
}

export const invalidBodyRefused: OperationCheck<InvalidProbe> = defineCheck<InvalidProbe>({
	id: ID,
	mutates: true,
	needs: "a write other than a create that takes a JSON request body",
	plan: (ctx) => andThen(subjectPlan(ctx), (subject) => probePlan(ctx, subject)),
	async run(ctx, probe) {
		return judged(ctx, probe, await send(ctx, probe.address, probe.as))
	},
	subject: "operation",
})

/* The operation as a subject: a write with a JSON body, not a create, no credential step, with something to break. */
function subjectPlan(ctx: OperationContext): Plan<Subject> {
	const { model, operation } = ctx
	const { operationId } = operation
	/* The model holds every operation it lists. */
	const content = jsonContent(model.rawOperations.get(operationId) as OperationObject)
	if (isReadMethod(operation) || content === null) return cannot("a write that takes a JSON request body")
	if (ctx.recipeOperations.has(operationId)) {
		return cannot(`an operation no credential recipe names; ${operationId} is a step of one`)
	}
	const entity = operation.entity === null ? undefined : model.entities.get(operation.entity)
	if (entity?.create === operationId) {
		return cannot(`a write other than its entity's create; ${operationId} is ${entity.name}'s create`)
	}
	/* The path names the record and its parents: the server takes those from it, not from the body. */
	const kept = new Set(operation.pathParams)
	if (typeof entity?.identity === "string") kept.add(entity.identity)
	const choice = invalidChoice(content.schema, { kept, merge: operation.method.toUpperCase() === "PATCH" })
	if (choice === null) return cannot("a request schema with a required or typed property")
	return ready({ choice, mediaType: content.mediaType, schema: content.schema })
}

/* The operation's JSON request content, when it documents one. */
function jsonContent(raw: OperationObject): { mediaType: string; schema: JsonSchema } | null {
	const json = Object.keys(raw.requestBody?.content ?? {}).find((type) =>
		(type.split(";")[0] as string).toLowerCase().includes("json"),
	)
	return json === undefined ? null : requestContent(raw, json)
}

/*
 * Where the invalid body goes: a write whose path names a record (the stage handed it a target, or the
 * actor's scope leaves a parameter unfilled) to the run-created target alone; an open POST anonymously;
 * anything else nowhere.
 */
function probePlan(ctx: OperationContext, subject: Subject): Plan<InvalidProbe> {
	const { choice, mediaType } = subject
	const { actor, operation } = ctx
	if (ctx.target !== undefined || operation.pathParams.some((name) => !Object.hasOwn(actor.scope, name))) {
		return andThen(targetPlan(ctx), (target) => {
			const record = currentOf(target)
			if (record === undefined) return cannot("the target record's current state, for a harmless body")
			const address = {
				body: itemBody(ctx, subject, invalidated(writableBody(ctx, record), choice)),
				contentType: mediaType,
				path: target.path,
			}
			return ready({ address, as: { principal: acceptorOf(ctx).id }, choice, open: false })
		})
	}
	if (!openToAll(ctx.security) || operation.method.toUpperCase() !== "POST") return cannot(SIDE_EFFECT)
	if (!operation.freshPrincipal) return cannot(SIGN_IN)
	return andThen(drawnBody(ctx, subject), (drawn) => {
		const path = fillPath(operation.path, actor.scope)
		const address = { body: invalidated(drawn, choice), contentType: mediaType, path }
		return ready({ address, as: { anonymous: true }, choice, open: true })
	})
}

/*
 * An item body as sent: an action (a POST on the record that is not its entity's update, an invite
 * say) reaches out, so every address it holds is one that reaches nothing.
 */
function itemBody(ctx: OperationContext, { schema }: Subject, body: Record<string, unknown>): unknown {
	const { model, operation } = ctx
	const isUpdate = [...model.entities.values()].some((entity) => entity.update === operation.operationId)
	const action = operation.method.toUpperCase() === "POST" && !isUpdate
	return action ? undeliverable(body, schema, ctx.nonce) : body
}

/* Whether the document declares the operation open to all and to nobody else: `security: []`. */
function openToAll(security: ResolvedSecurity): boolean {
	return security.source !== "none" && security.alternatives.every((alternative) => alternative.length === 0)
}

/* A valid body for the operation, drawn under the run's seed, to break; or why none can be drawn. */
function drawnBody(ctx: OperationContext, { schema }: Subject): Plan<Record<string, unknown>> {
	const { operationId } = ctx.operation
	try {
		const [member] = buildCohort(schema, ctx.seed, {
			defs: ctx.model.defs,
			nonce: ctx.nonce,
			operationId,
			variants: ["baseline"],
		}) as [CohortMember]
		return ready(member.body as Record<string, unknown>)
	} catch (error) {
		/* A schema no body satisfies: buildCohort throws a FixtureOverflow naming why. */
		return cannot(`a valid body for ${operationId} to break: ${messageOf(error)}`)
	}
}

/* The invalid body in the reader's terms. */
function described(choice: InvalidChoice): string {
	return choice.kind === "missing"
		? `a body missing the required property "${choice.field}"`
		: `a body whose "${choice.field}" is ${JSON.stringify(choice.value)}, a type the schema does not allow`
}

/* Any 4xx passes; a 2xx applied invalid input, and a 5xx crashed on it. */
function judged(ctx: OperationContext, probe: InvalidProbe, exchange: Exchange): Outcome {
	const { status } = exchange
	const sent = `${ctx.subject} answered ${status} to ${described(probe.choice)}.`
	if (status >= 400 && status < 500) return ASSERTED
	if (status >= 500) {
		return ctx.findings.backend(ID, ctx.subject, {
			detail: `${sent} Invalid input must be refused with a 4xx, not crash the handler.`,
			evidence: [exchange],
			summary: "an invalid body drew a server error",
		})
	}
	if (status < 200 || status >= 300) {
		const reason = `${ctx.subject} answered ${status} to the invalid body: neither a refusal nor a success`
		return ctx.findings.unresolved(ID, ctx.subject, reason)
	}
	const applied = probe.open
		? " The write is taken as applied: teardown removes what it made, or reports it as a record that may remain."
		: ""
	return ctx.findings.backend(ID, ctx.subject, {
		detail: `${sent} A write must refuse invalid input with a 4xx; this one applied what it could parse.${applied}`,
		evidence: [exchange],
		summary: "a write accepted a body its schema rules out",
	})
}
