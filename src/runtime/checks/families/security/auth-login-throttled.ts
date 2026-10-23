import { defineCheck } from "../../core/define.ts"
import { andThen, cannot, ready } from "../../core/plan.ts"
import type { Exchange } from "../../../exchange.ts"
import { asserted } from "../../../finding.ts"
import { fillPath } from "../../../fill-path.ts"
import { buildCohort, type CohortMember } from "../../../fixture.ts"
import { nonexistentIdentity } from "../../../nonexistent-identity.ts"
import { noSecurityReason } from "../../../no-security.ts"
import { requestContent } from "../../../../spec/collection/request.ts"
import type { JsonSchema, OperationObject } from "../../../../spec/types.ts"
import { anchoredSchemes } from "./lifecycle.ts"

/**
 * The most failed logins the check sends: the reference's threshold (5 failures within a minute)
 * plus 3, so a throttle that counts a little late still answers in time, and one that never does is
 * not hammered.
 */
export const LOGIN_ATTEMPTS = 8

/**
 * The failed login's body: valid by the schema, every string field naming an identity no account can
 * hold. An email-shaped one is at RFC 2606's reserved `.invalid` domain, which never resolves.
 */
function nobodyOf(body: Record<string, unknown>, { nonce, schema }: { nonce: string; schema: JsonSchema }) {
	/* A body drawn from a schema with no properties has no field to map. */
	const properties = schema.properties as Record<string, unknown>
	return Object.fromEntries(
		Object.entries(body).map(([name, value]) => [
			name,
			typeof value === "string" ? nonexistentIdentity({ name, schema: properties[name] }, nonce) : value,
		]),
	)
}

/**
 * Repeated failed logins are throttled. Opt-in (`optIn`, which the security stage enforces), since a
 * throttle that counts by address can slow every login from the machine running oat for a while.
 * Anchored on the login step of a login recipe, it sends failed logins anonymously for one identity
 * no account can hold (`oat-nonexistent-<nonce>`, at `example.invalid` where the field is an email),
 * never a principal's, until the login answers 429 or the cap.
 */
export const loginThrottled = defineCheck<Record<string, unknown>>({
	id: "auth.login-throttled",
	mutates: true,
	mutatesCredentials: true,
	needs: "a login recipe whose login step the document declares, with a request body schema",
	optIn: true,
	plan: (ctx) => {
		const undeclared = noSecurityReason(ctx.operation)
		if (undeclared !== undefined) return cannot(undeclared)
		const { operationId } = ctx.operation
		return andThen(anchoredSchemes(ctx, { kind: "issue", login: true }), () => {
			/* The model holds every operation it lists. */
			const raw = ctx.model.rawOperations.get(operationId) as OperationObject
			const schema = requestContent(raw)?.schema ?? null
			return schema === null
				? cannot(`a request body schema for ${operationId}, to build a failed login from`)
				: ready(schema)
		})
	},
	subject: "operation",
	async run(ctx, schema) {
		const { method, operationId, path } = ctx.operation
		const [drawn] = buildCohort(schema, 0, {
			defs: ctx.model.defs,
			nonce: ctx.nonce,
			operationId,
			variants: ["baseline"],
		}) as [CohortMember]
		const body = nobodyOf(drawn.body, { nonce: ctx.nonce, schema })
		const target = fillPath(path, ctx.actor.scope)
		const sent: Exchange[] = []
		while (sent.length < LOGIN_ATTEMPTS) {
			const attempt = await ctx.client.request(method, target, {
				as: { anonymous: true },
				body,
				operationId,
				probe: true,
			})
			sent.push(attempt)
			if (attempt.status === 429) {
				return asserted(`a login for one identity was throttled (429) after ${sent.length - 1} failures`)
			}
			if (attempt.status < 300) {
				const reason = `a login for an identity that does not exist answered ${attempt.status}, so its failures cannot be counted`
				return ctx.findings.unresolved(this.id, ctx.subject, reason)
			}
		}
		return ctx.findings.security(this.id, ctx.subject, {
			detail:
				`${LOGIN_ATTEMPTS} failed logins for one identity that does not exist, sent to ${operationId} ` +
				"back to back, drew no 429. Without a throttle a password can be guessed at the server's full speed.",
			evidence: sent,
			summary: "repeated failed logins are never throttled",
		})
	},
})
