/*
 * What the credential-lifecycle checks share. A session's issue, refresh and revoke are properties of
 * the credential, not of a route, so each check anchors once per scheme on the operation the actor's
 * recipe names for that step. It proves the credential on one read: the first GET in document order
 * that takes the scheme alone and whose path the actor's scope fills. Per-route guard coverage is the
 * missing- and invalid-credential checks'.
 */

import { UnsatisfiedSecurity } from "../../../../client/credential-source.ts"
import type { RecipeAnchors } from "../../../../credentials/anchors.ts"
import type { OperationModel } from "../../../../spec/graph/types.ts"
import { fillPath } from "../../../fill-path.ts"
import { ASSERTED, asserted, type Outcome, standDown } from "../../../finding.ts"
import { noSecurityReason } from "../../../no-security.ts"
import type { OperationContext } from "../../core/operation-context.ts"
import { isUntested } from "../../core/operation.ts"
import { andThen, cannot, type Plan, ready } from "../../core/plan.ts"
import { acceptorOf } from "./probing.ts"

/** The recipe step a check anchors on. */
export type AnchorKind = "issue" | "refresh" | "revoke"

/** Which step, and whether only a login recipe's counts. */
export interface Anchoring {
	kind: AnchorKind
	login?: true
}

const NAMED: Readonly<Record<AnchorKind, string>> = {
	issue: "documented issuing step",
	refresh: "refresh",
	revoke: "revoke",
}

/* Why this recipe cannot anchor the step at all, or undefined when it names one. */
function refusalOf(recipe: RecipeAnchors, { kind, login }: Anchoring): string | undefined {
	if (login === true && recipe.kind !== "login") return `${recipe.kind} recipes have no login step`
	return recipe[kind] === undefined ? `the ${recipe.kind} recipe declares no ${NAMED[kind]}` : undefined
}

/**
 * The schemes whose recipe, for the actor, names this operation for the step: the check runs here,
 * once for each. Elsewhere it stands down naming where it runs; with no anchor at all, giving each
 * scheme's reason.
 */
export function anchoredSchemes(ctx: OperationContext, anchoring: Anchoring): Plan<string[]> {
	const here: string[] = []
	const elsewhere = new Set<string>()
	const reasons: string[] = []
	for (const scheme of ctx.model.securitySchemes) {
		const recipe = ctx.probe.recipe({ principal: ctx.actor.id, scheme })
		const refused = isUntested(recipe) ? recipe.untested : refusalOf(recipe, anchoring)
		const anchor = isUntested(recipe) ? undefined : recipe[anchoring.kind]
		if (refused !== undefined) reasons.push(`${scheme}: ${refused}`)
		else if (anchor === ctx.operation.operationId) here.push(scheme)
		else elsewhere.add(anchor as string)
	}
	if (here.length > 0) return ready(here)
	if (elsewhere.size > 0) {
		return cannot(`the ${anchoring.kind} operation of a recipe; this check runs on ${[...elsewhere].join(", ")}`)
	}
	return cannot(reasons.length > 0 ? reasons.join("; ") : "a declared security scheme")
}

/** The one read a lifecycle check proves a credential on. */
export interface ReadRoute {
	operation: OperationModel
	/** Its path, filled from the scope of the principal the credential is proven as (`acceptorOf`). */
	path: string
	/** The scopes the scheme's alternative asks for, which a minted credential must carry. */
	scopes: string[]
}

/**
 * The first GET in document order that takes `scheme` alone and whose path the scope fills of the
 * principal a lifecycle probe acts as: the target's creator, which expects acceptance, else the actor.
 */
export function readRoute(ctx: OperationContext, scheme: string): ReadRoute | undefined {
	const { scope } = acceptorOf(ctx)
	for (const operation of ctx.model.operations) {
		if (operation.method.toUpperCase() !== "GET" || operation.security.source === "none") continue
		if (!operation.pathParams.every((name) => name in scope)) continue
		const alone = operation.security.alternatives.find((set) => set.length === 1 && set[0]?.scheme === scheme)?.[0]
		if (alone === undefined) continue
		return { operation, path: fillPath(operation.path, scope), scopes: [...alone.scopes] }
	}
	return undefined
}

/** One scheme a lifecycle check runs for, the read it proves the credential on, and whose credential it is. */
export interface Lifecycle {
	scheme: string
	route: ReadRoute
	/** The principal whose dedicated credential is proven, then revoked or rotated (`acceptorOf`). */
	actor: string
}

/**
 * A lifecycle check's plan: the schemes anchored on this operation, each with its read. A scheme
 * with no such read is left out; with none left, the check stands down naming what it needs.
 */
export function lifecyclePlan(ctx: OperationContext, kind: AnchorKind): Plan<Lifecycle[]> {
	const undeclared = noSecurityReason(ctx.operation)
	if (undeclared !== undefined) return cannot(undeclared)
	const actor = acceptorOf(ctx).id
	return andThen(anchoredSchemes(ctx, { kind }), (schemes) => {
		const planned = schemes.flatMap((scheme) => {
			const route = readRoute(ctx, scheme)
			return route === undefined ? [] : [{ actor, route, scheme }]
		})
		return planned.length > 0
			? ready(planned)
			: cannot(`a GET that accepts ${schemes.join(" or ")} alone and whose path parameters ${actor}'s scope fills`)
	})
}

/** A refusal of a credential: 401, or 403. */
export function isRefused(status: number): boolean {
	return status === 401 || status === 403
}

/** What probing one scheme came to: an outcome, or why that scheme could not be probed. */
export type SchemeOutcome = Outcome | { untested: string }

/**
 * What `work` decided, or untested with why when a credential it sends cannot be: BLOCKED by a failed
 * login, mint or renewal, or none that meets the security. `label` names whose request it was.
 */
export async function unlessUnsatisfied(label: string, work: () => Promise<Outcome>): Promise<SchemeOutcome> {
	try {
		return await work()
	} catch (error) {
		if (!(error instanceof UnsatisfiedSecurity)) throw error
		return { untested: `${label}: ${error.reason}` }
	}
}

/**
 * One outcome for every scheme a check probed: a finding first, then an unresolved run, then a pass
 * that notes what stayed untested. With no scheme tested, the check stands down with every reason.
 */
export function settle(outcomes: readonly SchemeOutcome[]): Outcome {
	const ran = outcomes.filter((outcome): outcome is Outcome => !("untested" in outcome))
	const untested = outcomes.flatMap((outcome) => ("untested" in outcome ? [outcome.untested] : []))
	const decided = ran.find((outcome) => outcome.kind === "finding") ?? ran.find((o) => o.kind === "unresolved")
	if (decided !== undefined) return decided
	if (ran.length === 0) return standDown(untested.join("; "))
	return untested.length > 0 ? asserted(`untested: ${untested.join("; ")}`) : ASSERTED
}
