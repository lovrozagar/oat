import type { Check } from "../../core/check.ts"
import { defineCheck } from "../../core/define.ts"
import type { OperationModel } from "../../../../spec/graph/types.ts"
import type { Exchange } from "../../../exchange.ts"
import { fillPath } from "../../../fill-path.ts"
import { ASSERTED, type Outcome } from "../../../finding.ts"
import { idOf } from "../../../world/records.ts"
import type { Actor } from "../../core/context.ts"
import { cannot, ready } from "../../core/plan.ts"
import { itemParamFor, NO_IDENTITY, subjectsOf } from "../../planning/subjects.ts"

/**
 * Privilege must be monotonic in rank: anything a lower-ranked role can do, a higher-ranked
 * role in the same tenant must also be able to do.
 *
 * The oracle needs no ground truth about what "owner" means. Two principals, same tenant,
 * different ranks, one item. If the lower one is served and the higher one is denied, the
 * lattice is upside down — the failure mode of every hand-rolled role table that inverted
 * a comparison or attached the wrong policy to a name.
 */
export const rankIsMonotonic: Check<{ id: string; readOp: OperationModel; home: Actor[] }> = defineCheck<{
	id: string
	readOp: OperationModel
	home: Actor[]
}>({
	plan: (ctx) => {
		const target = ctx.records[0]
		const primary = ctx.actors[0]
		const readOp = ctx.readOp
		if (readOp === undefined || target === undefined || primary === undefined) return cannot()
		const home = ctx.actors.filter((actor) => actor.tenant === primary.tenant)
		if (new Set(home.map((actor) => actor.rank)).size < 2) return cannot()
		const id = idOf(target, ctx.identity)
		return id === undefined ? cannot(NO_IDENTITY) : ready({ home, id, readOp })
	},
	dependsOn: ["list.read-after-write"],
	id: "auth.rank-is-monotonic",
	needs: "two same-tenant principals at different ranks, and an item route",
	subjects: subjectsOf.read,
	async run(ctx, { home, id, readOp }): Promise<Outcome> {
		const seen = new Map<string, Exchange>()
		const probe = async (actor: Actor): Promise<"allow" | "deny" | "error"> => {
			/* Where the record lives: every actor here shares its tenant. */
			const params = { ...ctx.scope, ...itemParamFor(ctx, id) }
			const exchange = await ctx.client.get(fillPath(readOp.path, params), {
				as: { principal: actor.id },
				operationId: readOp.operationId,
			})
			seen.set(actor.id, exchange)
			if (exchange.status < 300) return "allow"
			if (exchange.status === 403 || exchange.status === 404) return "deny"
			return "error"
		}

		const outcomes = new Map<string, "allow" | "deny" | "error">()
		for (const actor of home) {
			outcomes.set(actor.id, await probe(actor))
		}

		for (const lower of home) {
			for (const higher of home) {
				if (lower.rank >= higher.rank) continue
				const lo = outcomes.get(lower.id)
				const hi = outcomes.get(higher.id)
				if (lo !== "allow" || hi !== "deny") continue
				return ctx.findings.backend(this.id, ctx.entityName, {
					summary: "a lower-ranked role can read a record a higher-ranked role cannot",
					detail:
						`${lower.id} (rank ${lower.rank}) was served ${ctx.entityName} ${id}; ` +
						`${higher.id} (rank ${higher.rank}) was denied. Privilege must be ` +
						"monotonic — a member who can see what an owner cannot is the lattice inverted, " +
						"not a finer policy.",
					evidence: [seen.get(lower.id), seen.get(higher.id)].filter((exchange) => exchange !== undefined),
				})
			}
		}
		return ASSERTED
	},
})
