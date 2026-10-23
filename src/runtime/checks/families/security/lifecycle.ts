/*
 * What the credential-lifecycle checks share. A session's issue, refresh and revoke are properties of
 * the credential, not of a route, so each check anchors once per scheme on the operation the actor's
 * recipe names for that step. It proves the credential on one read oat can send whole (`readRoute`).
 * Per-route guard coverage is the missing- and invalid-credential checks'.
 */

import { UnsatisfiedSecurity } from "../../../../client/credential-source.ts"
import type { RecipeAnchors } from "../../../../credentials/anchors.ts"
import { unfilledRequired } from "../../../../spec/graph/parameters.ts"
import type { OperationModel } from "../../../../spec/graph/types.ts"
import type { SafeMethod } from "../../../../spec/methods.ts"
import type { OperationObject } from "../../../../spec/types.ts"
import { SELF_IDENTITY } from "../../../self/operations.ts"
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
	/** The method it is sent with: GET or HEAD. */
	method: SafeMethod
	/** Its path, filled from the scope of the principal the credential is proven as (`acceptorOf`). */
	path: string
	/** The scopes the scheme's alternative asks for, which a minted credential must carry. */
	scopes: string[]
}

/** The safe methods a credential is proven with: neither carries a body. */
const PROVING: ReadonlySet<string> = /* @__PURE__ */ new Set(["GET", "HEAD"])

/**
 * The read a lifecycle probe proves a credential on: a GET or HEAD that takes `scheme` alone and that
 * oat can send whole. Its path is filled from the scope of the principal the probe acts as (the
 * target's creator, which expects acceptance, else the actor), or a path parameter's declared enum;
 * every required query, header and cookie parameter has a declared value (`unfilledRequired`). A
 * read that cannot be sent whole never answers 2xx, and the check could never conclude. Among the
 * reads that can, the first in document order of the best rank (`rankOf`).
 */
export function readRoute(ctx: OperationContext, scheme: string): ReadRoute | undefined {
	const { scope } = acceptorOf(ctx)
	let best: { rank: number; route: ReadRoute } | undefined
	for (const operation of ctx.model.operations) {
		if (!PROVING.has(operation.method.toUpperCase()) || operation.security.source === "none") continue
		const alone = operation.security.alternatives.find((set) => set.length === 1 && set[0]?.scheme === scheme)?.[0]
		if (alone === undefined) continue
		const raw = ctx.model.rawOperations.get(operation.operationId) as OperationObject
		const values = pathValues(operation, raw, scope)
		if (values === undefined || unfilledRequired(raw).length > 0) continue
		const rank = rankOf(operation, raw)
		if (best !== undefined && best.rank <= rank) continue
		const path = fillPath(operation.path, values)
		const method = operation.method.toUpperCase() as SafeMethod
		best = { rank, route: { method, operation, path, scopes: [...alone.scopes] } }
	}
	return best?.route
}

/* Each path parameter's value from the scope, else its declared enum's first; undefined once one has neither. */
function pathValues(
	operation: OperationModel,
	raw: OperationObject,
	scope: Readonly<Record<string, string>>,
): Record<string, string> | undefined {
	const values: Record<string, string> = {}
	for (const name of operation.pathParams) {
		const enumerated = raw.parameters?.find((param) => param.in === "path" && param.name === name)?.schema?.["enum"]
		const value = Object.hasOwn(scope, name) ? scope[name] : Array.isArray(enumerated) ? enumerated[0] : undefined
		if (value === undefined || value === null) return undefined
		values[name] = String(value)
	}
	return values
}

/*
 * Lower is better: a read that needs no parameter at all, then the caller's own read or a list, which
 * any credential of the scheme should be let into, over a read of one record it may not reach.
 */
function rankOf(operation: OperationModel, raw: OperationObject): number {
	const bare = operation.pathParams.length === 0 && !(raw.parameters ?? []).some((param) => param.required === true)
	const open = operation.identity === SELF_IDENTITY || operation.action === "list"
	return (bare ? 0 : 2) + (open ? 0 : 1)
}

/** One scheme a lifecycle check runs for, the read it proves the credential on, and whose credential it is. */
export interface Lifecycle {
	scheme: string
	route: ReadRoute
	/** The principal whose dedicated credential is proven, then revoked or rotated (`acceptorOf`). */
	actor: string
}

/** Why a lifecycle check stands down when no scheme it anchors has a read `readRoute` can send. */
export const NO_READ = "no read this credential protects that oat can send"

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
		return planned.length > 0 ? ready(planned) : cannot(NO_READ)
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
