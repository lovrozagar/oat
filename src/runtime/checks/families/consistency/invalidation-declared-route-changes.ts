import { defineCheck } from "../../core/define.ts"
import type { OperationModel } from "../../../../spec/graph.ts"
import { pathParameterNames } from "../../../../spec/extensions.ts"
import type { Exchange } from "../../../exchange.ts"
import { fillPath } from "../../../fill-path.ts"
import { ASSERTED, type Outcome, standDown } from "../../../finding.ts"
import type { CheckContext } from "../../core/context.ts"
import { cannot, ready } from "../../core/plan.ts"
import { requestSchemaOf } from "../../payloads/body.ts"
import { createFresh } from "../../payloads/create.ts"
import { standDownForFeatureGate } from "../../planning/stand-down.ts"
import { graded, subjectsOf } from "../../planning/subjects.ts"
import { forList } from "../../sets/list.ts"
import { readSet } from "../../sets/read.ts"

/**
 * A route the document says a write invalidates must actually change.
 *
 * `x-invalidate` is the tag the whole entity graph is derived from, and until now it was believed
 * rather than tested: oat inverted the claim into a read surface and never asked whether the
 * claim was true. The interesting case is cross-entity — creating a child changes what the
 * *parent* route serves, via a denormalised counter or a cached projection. Those are the writes
 * that go wrong quietly: the write succeeds, the child's own listing is right, and only the other
 * route the document named is stale. Nothing but following the declaration finds it.
 *
 * Only routes belonging to a different entity are probed. This entity's own listing is already
 * covered by read-after-write, and re-asserting it here would report one defect twice.
 */
export const declaredInvalidationHappens = defineCheck<{
	createOp: OperationModel
	foreign: OperationModel[]
	schema: Record<string, unknown>
}>({
	plan: (ctx) => {
		const createOp = ctx.createOp
		if (createOp === undefined) return cannot()
		/* A graded create is judged through every route it declares; a graded route alone is
		 * judged only itself, with the create as support. */
		const createGraded = graded(ctx, createOp)
		const foreign = createOp.invalidates
			.map((route) => ctx.model.byRoute.get(route))
			.filter(
				(op): op is OperationModel =>
					op !== undefined &&
					op.entity !== ctx.entityName &&
					op.method.toUpperCase() === "GET" &&
					(createGraded || graded(ctx, op)),
			)
		if (foreign.length === 0) return cannot()
		const schema = requestSchemaOf(ctx, createOp)
		return schema === null ? cannot("a create operation with a request body") : ready({ createOp, foreign, schema })
	},
	dependsOn: ["pagination.page-walk-covers-set", "list.read-after-write", "create.persists-submitted-fields"],
	id: "invalidation.declared-route-changes",
	mutates: true,
	needs: "a create operation whose x-invalidate names another entity's read route",
	subjects: subjectsOf.createAndForeignReads,
	async run(ctx, { createOp, foreign, schema }): Promise<Outcome> {
		const probes = fillableProbes(ctx, foreign)
		if (probes.length === 0) {
			return ctx.findings.unresolved(
				this.id,
				ctx.entityName,
				"the declared routes need identifiers outside this entity's scope, so they cannot be read",
			)
		}
		const before = await snapshotsBefore(ctx, probes)
		if (before.size === 0) {
			return ctx.findings.unresolved(
				this.id,
				ctx.entityName,
				"none of the declared routes could be read before the write",
			)
		}

		const { exchange: created } = await createFresh(ctx, createOp, schema, ctx.auth())
		if (standDownForFeatureGate(ctx, createOp, created, this.id))
			return standDown("a documented feature gate refused the request")
		if (created.status >= 300) {
			return ctx.findings.unresolved(
				this.id,
				ctx.entityName,
				`the create returned ${created.status}, so nothing was invalidated`,
			)
		}

		const stale = await firstUnchanged(ctx, probes, before)
		if (stale === undefined) return ASSERTED
		return ctx.findings
			.attributed([
				...(graded(ctx, createOp) ? [createOp.operationId] : []),
				...(graded(ctx, stale.probe.op) ? [stale.probe.op.operationId] : []),
			])
			.backend(
				this.id,
				ctx.entityName,
				"a route the document says is invalidated by this write did not change",
				`creating a ${ctx.entityName} declares x-invalidate on "${stale.probe.op.route}", but that ` +
					"route returned a byte-identical body before and after the write. Either it serves " +
					"a value derived from this entity and that value is stale — a denormalised counter " +
					"or a cached projection nobody refreshed — or the declaration is wrong and every " +
					"client following it is invalidating the wrong cache key.",
				[created, stale.after],
			)
	},
})

/** A declared route and the path that reads it in this entity's scope. */
interface Probe {
	op: OperationModel
	path: string
}

/* Only routes whose path can be filled from this entity's scope are probed: a route
 * needing an identifier oat does not hold cannot be read at all. */
function fillableProbes(ctx: CheckContext, foreign: readonly OperationModel[]): Probe[] {
	return foreign
		.filter((op) => pathParameterNames(op.path).every((name) => ctx.scope[name] !== undefined))
		.map((op) => ({ op, path: fillPath(op.path, ctx.scope) }))
}

/* What a route serves, as a comparable snapshot: a collection read whole, since the record
 * the write changed may sit on any page of it. `undefined` when it cannot be read whole. */
async function snapshot(ctx: CheckContext, probe: Probe): Promise<{ text: string; exchange: Exchange } | undefined> {
	if (probe.op.collection !== null) {
		const read = await readSet(forList(ctx, probe.op), {}, { fresh: true })
		if (read.status !== "ok" || !read.complete) return undefined
		return { exchange: read.last.exchange, text: JSON.stringify(read.items) }
	}
	const exchange = await ctx.client.get(probe.path, { headers: ctx.auth() })
	return exchange.status >= 400 ? undefined : { exchange, text: JSON.stringify(exchange.responseBody) }
}

/** Each readable route's snapshot before the write, by path. */
async function snapshotsBefore(ctx: CheckContext, probes: readonly Probe[]): Promise<Map<string, string>> {
	const before = new Map<string, string>()
	for (const probe of probes) {
		const taken = await snapshot(ctx, probe)
		if (taken !== undefined) before.set(probe.path, taken.text)
	}
	return before
}

/** The first route read on both sides of the write whose body did not change, with its after-read. */
async function firstUnchanged(
	ctx: CheckContext,
	probes: readonly Probe[],
	before: ReadonlyMap<string, string>,
): Promise<{ probe: Probe; after: Exchange } | undefined> {
	for (const probe of probes) {
		const prior = before.get(probe.path)
		if (prior === undefined) continue
		const taken = await snapshot(ctx, probe)
		if (taken === undefined) continue
		if (taken.text !== prior) continue
		return { after: taken.exchange, probe }
	}
	return undefined
}
