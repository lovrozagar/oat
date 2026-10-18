import { defineCheck } from "../../core/define.ts"
import { owningEntityOf } from "../../../../spec/graph/roots.ts"
import type { Exchange } from "../../../exchange.ts"
import { canFillPath } from "../../../effects/scope.ts"
import { fillPath } from "../../../fill-path.ts"
import { ASSERTED, type Outcome } from "../../../finding.ts"
import { idOf } from "../../../world/records.ts"
import type { WriteContext } from "../../core/context.ts"
import { cannot, ready } from "../../core/plan.ts"
import { encodeOpBody, requestSchemaOf, validBody } from "../../payloads/body.ts"
import { declared, itemParamFor } from "../../planning/subjects.ts"
import { pageSize, q } from "../../query/capabilities.ts"
import { setOf } from "../../sets/compare.ts"
import { ids, list } from "../../sets/list.ts"
import { readSet } from "../../sets/read.ts"
import { tenantBoundary } from "./tenant.ts"

/**
 * A child collection is reached only through parents the caller owns.
 *
 * The tenant root in a path is checked against the caller; the parents beneath it often are not.
 * Another tenant's parent id placed under the caller's own root — `/projects/mine/tables/{theirs}/
 * rows` — must be as unknown as a parent that never existed. Reading the children through it, or
 * writing a child under it, crosses the boundary one level down from where it is usually guarded.
 */
export const foreignParentRejected = defineCheck<{
	altAuth: () => Record<string, string>
	mixed: Record<string, string>
	tenantParam: string
	parents: string[]
}>({
	plan: (ctx) => {
		const { altAuth, altScope } = ctx
		const tenantParam = ctx.listOp.tenantParam ?? undefined
		if (altAuth === undefined || altScope === undefined || tenantParam === undefined) return cannot()
		if (!tenantBoundary(ctx.listOp) || altScope[tenantParam] === undefined) return cannot()
		if (altScope[tenantParam] === ctx.scope[tenantParam]) return cannot()
		const parents = ctx.listOp.pathParams.filter((param) => param !== tenantParam && ctx.scope[param] !== undefined)
		if (parents.length === 0) return cannot("a parent below the tenant in the collection's path")
		/* Both tenants configured with the same parent: under the other root it is that tenant's own. */
		const same = parents.find((param) => altScope[param] === ctx.scope[param])
		if (same !== undefined) return cannot(`the other tenant's ${same} has the same identity as the owner's`)
		/* The owner's parents, under the other tenant's root. */
		const mixed = { ...ctx.scope, [tenantParam]: altScope[tenantParam] as string }
		return ready({ altAuth, mixed, parents, tenantParam })
	},
	dependsOn: ["list.read-after-write", "tenant.item-not-readable-cross-tenant"],
	id: "tenant.parent-not-reachable-from-another-root",
	mutates: true,
	needs: "a second tenant, and a collection nested under a parent below the tenant",
	subjects: (entity) => declared(entity.list, entity.read, entity.create),
	async run(ctx, { altAuth, mixed, parents, tenantParam }): Promise<Outcome> {
		const path = `${ctx.listOp.path} with another tenant's ${parents.join(", ")} under its own ${tenantParam}`
		const breach = (summary: string, detail: string, evidence: Exchange[]): Outcome =>
			ctx.listOp.tenantSource === "tag"
				? ctx.findings.security(this.id, ctx.entityName, summary, detail, evidence)
				: ctx.findings.report({
						check: this.id,
						detail: `${detail} oat inferred the tenant from "${tenantParam}"; declare x-tenant to make this SECURITY.`,
						entity: ctx.entityName,
						evidence,
						summary,
						verdict: "AMBIGUITY",
					})
		/* The other tenant may hold a parent of its own under the owner's parent's identity — a slug
		 * derived from a shared name. Reaching it is the backend being right, not a boundary crossed. */
		const collision = await ownParentOfTheOther(ctx, altAuth, mixed, parents)
		if (collision !== null) return ctx.findings.unresolved(this.id, ctx.entityName, collision)
		const owned = setOf(ctx.records, ctx.identity)

		const listed = await list(ctx, q(ctx, { limit: pageSize(ctx) }), { auth: altAuth, scope: mixed })
		if (listed.exchange.status < 300 && ids(listed.items, ctx.identity).some((id) => owned.has(id))) {
			return breach(
				"another tenant's records are listed through their parent under one's own root",
				`${path} listed ${listed.items.length} record(s), including the owner's.`,
				[listed.exchange],
			)
		}
		const targetId = idOf(ctx.records[0], ctx.identity)
		if (ctx.readOp !== undefined && targetId !== undefined) {
			const read = await ctx.client.get(fillPath(ctx.readOp.path, { ...mixed, ...itemParamFor(ctx, targetId) }), {
				headers: altAuth(),
			})
			if (read.status < 300) {
				return breach(
					"another tenant's record is readable through its parent under one's own root",
					`${path} read ${ctx.entityName} ${targetId} (${read.status}).`,
					[read],
				)
			}
		}
		const createOp = ctx.createOp
		const schema = createOp === undefined ? null : requestSchemaOf(ctx, createOp)
		if (createOp !== undefined && schema !== null) {
			const created = await ctx.client.request("POST", fillPath(createOp.path, mixed), {
				...(await encodeOpBody(ctx, createOp, validBody(ctx, schema))),
				headers: altAuth(),
				operationId: createOp.operationId,
			})
			if (created.status < 300) {
				return breach(
					"a child can be created under another tenant's parent",
					`${path} accepted a create (${created.status}): a record now hangs off a parent the creator ` +
						"cannot otherwise see.",
					[created],
				)
			}
		}
		return ASSERTED
	},
})

/**
 * Why the owner's parents, placed under the other tenant's root, may name the other tenant's own
 * records — or `null` when they do not. Parents are walked top-down, each one's collection read
 * whole under the other root. The walk stops at the first level holding nothing named like the
 * owner's: from there down the path names the owner's records, and the probe tests a real
 * boundary. A path whose every parent the other tenant also holds tests none.
 */
async function ownParentOfTheOther(
	ctx: WriteContext,
	altAuth: () => Record<string, string>,
	mixed: Record<string, string>,
	parents: readonly string[],
): Promise<string | null> {
	let collision: string | null = null
	for (const param of parents) {
		const value = mixed[param] as string
		const name = owningEntityOf(ctx.model.operations, ctx.listOp.path, param)
		const entity = name === null ? undefined : ctx.model.entities.get(name)
		if (entity === undefined) return null
		const listOp = entity.list === undefined ? undefined : ctx.model.byOperationId.get(entity.list)
		if (listOp === undefined) {
			const readOp = entity.read === undefined ? undefined : ctx.model.byOperationId.get(entity.read)
			if (readOp === undefined || !canFillPath(readOp.path, mixed)) return null
			const read = await ctx.client.get(fillPath(readOp.path, mixed), {
				headers: altAuth(),
				operationId: readOp.operationId,
			})
			if (read.status >= 300) return null
			return `cannot tell whether the other tenant holds its own ${entity.name} ${value}`
		}
		const identity = entity.identity ?? "id"
		const read = await readSet(
			{ ...ctx, identity, listOp, scope: mixed },
			{},
			{ auth: altAuth, fresh: true, scope: mixed },
		)
		if (read.status !== "ok" || !read.complete) {
			return `the other tenant's ${entity.name} list could not be read whole, so a ${entity.name} ${value} of its own is not ruled out`
		}
		if (!ids(read.items, identity).includes(value)) return null
		collision ??= `the other tenant holds a ${entity.name} ${value} of its own, so the owner's ${param} under its root names that ${entity.name}`
	}
	return collision
}
