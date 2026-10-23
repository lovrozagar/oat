import type { OperationCheck } from "../../core/check.ts"
import type { Actor } from "../../core/context.ts"
import { defineCheck } from "../../core/define.ts"
import type { OperationContext, OperationWriteContext, WriteTarget } from "../../core/operation-context.ts"
import { isReadMethod, targetPlan } from "../../core/operation.ts"
import { andThen, cannot, type Plan, ready } from "../../core/plan.ts"
import { ASSERTED, type Outcome } from "../../../finding.ts"
import { noSecurityReason } from "../../../no-security.ts"
import { isRefused, settle, unlessUnsatisfied } from "./lifecycle.ts"
import { BY_VALIDATION, byValidation } from "./probing.ts"
import { currentOf, writableBody } from "./writable.ts"

/** The record written to, what is sent (a delete sends nothing), and the readOnly principal that writes. */
interface RoleProbe {
	target: WriteTarget
	send: { body?: Record<string, unknown> }
	readOnly: Actor
}

/**
 * A read-only role cannot write. Only the config says which principal is read-only (`readOnly: true`);
 * rank alone never does. That principal's write to a record this run created, in its own tenant, with
 * the record's current state cut to what the request body accepts (a delete sends none), must be
 * refused with 401 or 403. Unlike
 * auth.rank-is-monotonic-on-writes this fires when every rank may write, which is still monotonic.
 */
export const roleEnforced: OperationCheck<RoleProbe> = defineCheck<RoleProbe>({
	id: "auth.role-enforced",
	mutates: true,
	needs: "a principal marked readOnly, and a run-created record in its tenant to write to",
	plan: (ctx) => {
		const undeclared = noSecurityReason(ctx.operation)
		if (undeclared !== undefined) return cannot(undeclared)
		if (isReadMethod(ctx.operation)) return cannot("a write method")
		if (ctx.operation.security.alternatives.some((set) => set.length === 0)) {
			return cannot("a write the document secures")
		}
		return andThen(targetPlan(ctx), (target) => {
			const record = currentOf(target)
			const deletes = ctx.operation.method.toUpperCase() === "DELETE"
			if (!deletes && record === undefined) return cannot("the target record's current state, for a harmless body")
			const send = deletes || record === undefined ? {} : { body: writableBody(ctx, record) }
			return andThen(readOnlyOf(ctx, target), (readOnly) => ready({ readOnly, send, target }))
		})
	},
	subject: "operation",
	async run(ctx, planned) {
		return settle([await unlessUnsatisfied(`${planned.readOnly.id}'s write`, () => writeAs(ctx, planned))])
	},
})

const CHECK = "auth.role-enforced"

/* The read-only principal's harmless write to the run's record: refused passes, applied is the finding. */
async function writeAs(ctx: OperationWriteContext, { readOnly, send, target }: RoleProbe): Promise<Outcome> {
	const { method, operationId, requiredQuery: query } = ctx.operation
	const as = { principal: readOnly.id }
	const wrote = await ctx.client.request(method, target.path, { ...send, as, operationId, probe: true, query })
	if (isRefused(wrote.status)) return ASSERTED
	if (byValidation(wrote.status)) {
		return ctx.findings.unresolved(CHECK, ctx.subject, `${readOnly.id}'s write drew ${wrote.status}: ${BY_VALIDATION}`)
	}
	if (wrote.status >= 300) {
		const reason = `${readOnly.id}'s write drew ${wrote.status}, neither a refusal nor a success`
		return ctx.findings.unresolved(CHECK, ctx.subject, reason)
	}
	return ctx.findings.security(CHECK, ctx.subject, {
		detail:
			`${readOnly.id}, marked readOnly in tenant ${String(readOnly.tenant)}, wrote to a record this ` +
			`run created, and ${operationId} answered ${wrote.status}. Roles must be enforced on writes.`,
		evidence: [wrote],
		summary: "a read-only principal's write is accepted",
	})
}

/* The first principal marked readOnly in the target owner's tenant. */
function readOnlyOf(ctx: OperationContext, target: WriteTarget): Plan<Actor> {
	const marked = ctx.principals.filter((actor) => actor.readOnly === true)
	if (marked.length === 0) return cannot("no principal is marked readOnly")
	const owner = ctx.principals.find((actor) => actor.id === target.owner) ?? ctx.actor
	const readOnly = marked.find((actor) => actor.tenant === owner.tenant)
	return readOnly === undefined ? cannot("a readOnly principal sharing the target owner's tenant") : ready(readOnly)
}
