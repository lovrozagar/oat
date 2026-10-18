import { defineCheck } from "../../core/define.ts"
import type { OperationModel } from "../../../../spec/graph.ts"
import type { Exchange } from "../../../client.ts"
import { fillPath } from "../../../fill-path.ts"
import { ASSERTED, type Outcome } from "../../../finding.ts"
import type { Record_ } from "../../../world.ts"
import type { WriteContext } from "../../core/context.ts"
import { cannot, ready } from "../../core/plan.ts"
import { readRecord, scratchRecord, updateRequest } from "../../isolation/scratch.ts"
import { changedValue, pickWritableStringField } from "../../payloads/body.ts"
import { declared, itemParamFor } from "../../planning/subjects.ts"
import { tenantBoundary } from "./tenant.ts"

/**
 * Another tenant must not be able to change or remove a record.
 *
 * Isolation used to be tested on reads alone, and a backend that scopes its reads but looks its
 * writes up by id hands every tenant every other tenant's data to edit and delete. The probe runs
 * on a record made for it: the other tenant patches a field, then deletes the record, and the
 * owner reads it back. A refusal of either is right; a change or a deletion that took is the leak.
 */
export const crossTenantItemWrite = /* @__PURE__ */ defineCheck<{
	readOp: OperationModel
	altAuth: () => Record<string, string>
	updateOp: OperationModel | undefined
	deleteOp: OperationModel | undefined
}>({
	plan: (ctx) => {
		const { altAuth, readOp } = ctx
		if (altAuth === undefined || readOp === undefined || ctx.createOp === undefined) return cannot()
		const updateOp = ctx.updateOp !== undefined && tenantBoundary(ctx.updateOp) ? ctx.updateOp : undefined
		const deleteOp = ctx.deleteOp !== undefined && tenantBoundary(ctx.deleteOp) ? ctx.deleteOp : undefined
		if (updateOp === undefined && deleteOp === undefined) return cannot()
		return ready({ altAuth, deleteOp, readOp, updateOp })
	},
	dependsOn: ["list.read-after-write", "tenant.item-not-readable-cross-tenant"],
	id: "tenant.item-not-writable-cross-tenant",
	mutates: true,
	needs: "a second principal in a different tenant, a create, and a tenant-scoped update or delete",
	subjects: (entity) => declared(entity.update, entity.delete),
	async run(ctx, { altAuth, deleteOp, readOp, updateOp }): Promise<Outcome> {
		const made = await scratchRecord(ctx, this.id)
		if ("outcome" in made) return made.outcome
		const { id, record } = made.scratch
		const own = { ...ctx.scope, ...itemParamFor(ctx, id) }
		const probe: Probe = {
			altAuth,
			check: this.id,
			ctx,
			foreign: { ...(ctx.altScope ?? ctx.scope), ...itemParamFor(ctx, id) },
			id,
			readOp,
			record,
			reread: () => ctx.client.get(fillPath(readOp.path, own), { headers: ctx.auth() }),
		}
		const changed = updateOp === undefined ? null : await foreignUpdate(probe, updateOp)
		if (changed !== null) return changed
		const deleted = deleteOp === undefined ? null : await foreignDelete(probe, deleteOp)
		return deleted ?? ASSERTED
	},
})

/** One scratch record, and how the other tenant addresses it. */
interface Probe {
	ctx: WriteContext
	check: string
	id: string
	record: Record_
	readOp: OperationModel
	foreign: Record<string, string>
	altAuth: () => Record<string, string>
	/** The owner's read of the record. */
	reread: () => Promise<Exchange>
}

/** A write that crossed the boundary: SECURITY where the document declares it, AMBIGUITY where oat inferred it. */
function breach(
	{ check, ctx }: Probe,
	op: OperationModel,
	finding: { summary: string; detail: string; evidence: Exchange[] },
): Outcome {
	const { detail, evidence, summary } = finding
	if (op.tenantSource === "tag") {
		return ctx.findings.security(
			check,
			ctx.entityName,
			summary,
			`${detail} The operation declares x-tenant: "${op.tenantParam}".`,
			evidence,
		)
	}
	return ctx.findings.report({
		check,
		detail:
			`${detail} oat inferred tenant scoping from the "${op.tenantParam}" path parameter; ` +
			"declare x-tenant so the same result is SECURITY.",
		entity: ctx.entityName,
		evidence,
		summary,
		verdict: "AMBIGUITY",
	})
}

/** The other tenant changes a field; the breach when the owner then reads the new value, else `null`. */
async function foreignUpdate(probe: Probe, updateOp: OperationModel): Promise<Outcome | null> {
	const { ctx, record } = probe
	const field = pickWritableStringField(ctx, record)
	const value = field === null ? undefined : changedValue(ctx, field, record[field], updateOp)
	if (field === null || value === undefined) return null
	const update = await updateRequest(ctx, updateOp, record, { [field]: value })
	const attempt = await ctx.client.request(update.method, fillPath(updateOp.path, probe.foreign), {
		...update.options,
		headers: probe.altAuth(),
		operationId: updateOp.operationId,
	})
	const after = await probe.reread()
	const now = readRecord(probe.readOp, after)?.[field]
	if (after.status >= 300 || JSON.stringify(now) !== JSON.stringify(value)) return null
	return breach(probe, updateOp, {
		detail:
			`${ctx.entityName} ${probe.id} belongs to one tenant; a principal in another tenant set "${field}" ` +
			`(${attempt.status}) and the owner now reads the new value.`,
		evidence: [attempt, after],
		summary: "a record can be changed by a principal in another tenant",
	})
}

/** The other tenant deletes the record; the breach when the owner can no longer read it, else `null`. */
async function foreignDelete(probe: Probe, deleteOp: OperationModel): Promise<Outcome | null> {
	const { ctx } = probe
	const attempt = await ctx.client.request("DELETE", fillPath(deleteOp.path, probe.foreign), {
		headers: probe.altAuth(),
		operationId: deleteOp.operationId,
	})
	const after = await probe.reread()
	if (attempt.status >= 300 || (after.status !== 404 && after.status !== 410)) return null
	return breach(probe, deleteOp, {
		detail:
			`${ctx.entityName} ${probe.id} belongs to one tenant; a principal in another tenant deleted it ` +
			`(${attempt.status}) and the owner can no longer read it (${after.status}).`,
		evidence: [attempt, after],
		summary: "a record can be deleted by a principal in another tenant",
	})
}
