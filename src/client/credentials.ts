/**
 * The credential source a run's clients use: an actor resolved against the operation's security,
 * over the run's credential store.
 *
 * The first alternative the principal can satisfy, in document order, is sent; `satisfy` decides that
 * offline from the principal's effective recipes, and the store acquires each scheme of it. A secondary
 * origin's adapter reads its own document, and `mapping` (the config's `origins[].security`) names the
 * primary scheme whose credential each origin scheme sends. That value is placed where the origin's
 * scheme puts it, by the origin scheme's own template: the primary recipe's `format` and `placements`
 * belong to the primary scheme's place. An origin scheme with no mapping has no credential.
 */

import { effectiveRecipe, own } from "../credentials/effective.ts"
import { probeOwner } from "../credentials/probe-principal.ts"
import { sendsFor } from "../credentials/placement.ts"
import type { PrincipalsConfig, Recipe, SecurityConfig } from "../config/types/security.ts"
import type { Sends } from "../credentials/ports.ts"
import { satisfy } from "../credentials/satisfy.ts"
import type { Credential, CredentialKey, Held } from "../credentials/store.ts"
import { messageOf } from "../errors/message.ts"
import type { PlacedSecrets } from "../security/redact.ts"
import type { OperationModel } from "../spec/graph/types.ts"
import type { Requirement } from "../spec/security/requirements.ts"
import type { SecurityScheme } from "../spec/security/schemes.ts"
import type { Exchange } from "../runtime/exchange.ts"
import type { Actor, CredentialRequest, CredentialSource, Resolution, Sending } from "./credential-source.ts"

/** What the adapter asks of the run's credential store. */
export interface CredentialStorePort {
	acquire(key: CredentialKey): Promise<Held>
	refresh(request: CredentialKey & { sentValue: string }): Promise<Held>
	block(key: CredentialKey, reason: string): void
}

export interface CredentialSourceOptions {
	store: CredentialStorePort
	/** The document this client's requests are operations of. */
	model: {
		byOperationId: ReadonlyMap<string, Pick<OperationModel, "security">>
		schemes: ReadonlyMap<string, SecurityScheme>
	}
	security: SecurityConfig
	principals: PrincipalsConfig
	/** A secondary origin's `origins[].security`: origin scheme to the primary scheme whose credential it sends. */
	mapping?: Readonly<Record<string, string>>
	/** The recipes no primary scheme declares: an origin's scheme is theirs, so their format and placements apply there. */
	originOnly?: ReadonlySet<string>
}

const ANONYMOUS: Resolution = { kind: "anonymous" }

/** A credential source over the run's store, for one document. */
export function createCredentialSource(options: CredentialSourceOptions): CredentialSource {
	return { resolve: (request) => resolve(options, request) }
}

async function resolve(ctx: CredentialSourceOptions, request: CredentialRequest): Promise<Resolution> {
	const { actor } = request
	if ("anonymous" in actor) return ANONYMOUS
	if ("forged" in actor) return forge(ctx, actor.forged)
	if ("value" in actor) return hold(ctx, actor)
	const offered = alternativesFor(ctx, request, actor)
	if ("unsatisfied" in offered) return { kind: "unsatisfied", reason: offered.unsatisfied }
	const recipesFor = (scheme: string): Partial<Recipe> | undefined => recipeOf(ctx, actor.principal, scheme)
	const chosen = satisfy(offered, recipesFor)
	if ("unsatisfied" in chosen) return { kind: "unsatisfied", reason: chosen.unsatisfied }
	if (chosen.alternative.length === 0) return ANONYMOUS
	return settle(ctx, { alternative: chosen.alternative, principal: actor.principal })
}

/* A principal acting through its own credentials. */
type Acting = Exclude<Actor, { anonymous: true } | { forged: unknown } | { value: string }>

/*
 * What the principal may send: the named scheme, else the operation's security, else for a URL a
 * response gave it what that response's request sent. A principal's request that matches no operation
 * and names no scheme is refused rather than sent bare, so a 401 is never graded as the backend's.
 */
function alternativesFor(
	ctx: CredentialSourceOptions,
	request: CredentialRequest,
	actor: Acting,
): { alternatives: Requirement[][] } | { unsatisfied: string } {
	const { operationId } = request
	const operation = operationId === undefined ? undefined : ctx.model.byOperationId.get(operationId)
	if ("scheme" in actor) {
		const asked = operation?.security.alternatives.flat().find((requirement) => requirement.scheme === actor.scheme)
		return { alternatives: [[{ scheme: actor.scheme, scopes: asked?.scopes ?? [] }]] }
	}
	if (operation !== undefined) return { alternatives: operation.security.alternatives }
	if ("via" in actor) return { alternatives: [continued(ctx, actor.via)] }
	return {
		unsatisfied: `no documented operation matches ${request.route}: name its scheme with as: { principal, scheme }`,
	}
}

/* The alternative the originating exchange sent, with the scopes its operation asked of it when that is known. */
function continued(ctx: CredentialSourceOptions, via: Exchange): Requirement[] {
	const schemes = via.schemes ?? []
	const origin = via.operationId === undefined ? undefined : ctx.model.byOperationId.get(via.operationId)
	const sent = origin?.security.alternatives.find(
		(alternative) =>
			alternative.length === schemes.length &&
			alternative.every((requirement, index) => requirement.scheme === schemes[index]),
	)
	return sent ?? schemes.map((scheme) => ({ scheme, scopes: [] }))
}

interface Settling {
	principal: string
	alternative: Requirement[]
	/** The values a refused request carried, by scheme: set to renew them rather than acquire. */
	renew?: Readonly<Record<string, string>>
}

/* Acquires, or renews, every scheme of the alternative, and places what the store holds. */
async function settle(ctx: CredentialSourceOptions, settling: Settling): Promise<Resolution> {
	const { alternative, principal, renew } = settling
	const held = await Promise.all(
		alternative.map((requirement) => {
			const key = { principal, scheme: primaryOf(ctx, requirement.scheme) as string, scopes: requirement.scopes }
			const sentValue = renew?.[requirement.scheme]
			return sentValue === undefined ? ctx.store.acquire(key) : ctx.store.refresh({ ...key, sentValue })
		}),
	)
	const sending: Sending = {
		block: (reason) => {
			for (const requirement of alternative) {
				ctx.store.block({ principal, scheme: primaryOf(ctx, requirement.scheme) as string }, reason)
			}
		},
		kind: "sends",
		/* A dedicated credential is the owner's own account: the exchange names the owner, never the probe. */
		principal: probeOwner(principal),
		refresh: () => settle(ctx, { alternative, principal, renew: sending.sentValues }),
		schemes: alternative.map((requirement) => requirement.scheme),
		secrets: { cookies: [], headers: [], query: [], values: [] },
		sends: {},
		sentValues: {},
	}
	for (const [index, requirement] of alternative.entries()) {
		const credential = held[index] as Held
		if ("blocked" in credential) return { kind: "blocked", reason: credential.blocked }
		const placed = placeHeld(ctx, requirement.scheme, credential)
		if ("unsatisfied" in placed) return { kind: "unsatisfied", reason: placed.unsatisfied }
		add(sending, requirement.scheme, { ...placed, value: credential.value })
	}
	return sending
}

function add(sending: Sending, scheme: string, placed: { sends: Sends; secrets: PlacedSecrets; value: string }): void {
	const { secrets } = sending
	sending.sends = { ...sending.sends, [scheme]: placed.sends }
	sending.sentValues = { ...sending.sentValues, [scheme]: placed.value }
	sending.secrets = {
		cookies: [...secrets.cookies, ...placed.secrets.cookies],
		headers: [...secrets.headers, ...placed.secrets.headers],
		query: [...secrets.query, ...placed.secrets.query],
		values: [...secrets.values, ...placed.secrets.values],
	}
}

type Placed = { sends: Sends; secrets: PlacedSecrets } | { unsatisfied: string }

/*
 * The store placed it by the primary scheme; an origin places the same value by its own, with the recipe's
 * format and placements only when the recipe is for an origin's scheme rather than a primary one.
 */
function placeHeld(ctx: CredentialSourceOptions, scheme: string, credential: Credential): Placed {
	if (ctx.mapping === undefined) return credential
	const primary = primaryOf(ctx, scheme) as string
	/* A held credential is one the principal had a recipe for. */
	const recipe = ctx.originOnly?.has(primary) === true ? (own(ctx.security, primary) as Partial<Recipe>) : {}
	const placed = place(ctx.model.schemes.get(scheme), { name: scheme, recipe, value: credential.value })
	if ("unsatisfied" in placed) return placed
	const values = [...new Set([...credential.secrets.values, ...placed.secrets.values])]
	return { secrets: { ...placed.secrets, values }, sends: placed.sends }
}

function forge(ctx: CredentialSourceOptions, forged: { scheme: string; value: string; derived?: true }): Resolution {
	const { scheme } = forged
	const placed = placeValue(ctx, forged)
	if ("unsatisfied" in placed) return { kind: "unsatisfied", reason: placed.unsatisfied }
	const forging: Resolution = { kind: "forged", schemes: [scheme], sends: { [scheme]: placed.sends } }
	return forged.derived === true ? { ...forging, secrets: placed.secrets } : forging
}

/* A value the principal holds, sent as given and placed as the scheme places its credential. */
function hold(ctx: CredentialSourceOptions, held: { principal: string; scheme: string; value: string }): Resolution {
	const { principal, scheme } = held
	const placed = placeValue(ctx, held)
	if ("unsatisfied" in placed) return { kind: "unsatisfied", reason: placed.unsatisfied }
	return { kind: "held", principal, schemes: [scheme], secrets: placed.secrets, sends: { [scheme]: placed.sends } }
}

/* A given value, placed by the scheme and its config format: a secondary origin's own scheme takes none. */
function placeValue(ctx: CredentialSourceOptions, given: { scheme: string; value: string }): Placed {
	const { scheme, value } = given
	const recipe = ctx.mapping === undefined ? (own(ctx.security, scheme) ?? {}) : {}
	return place(ctx.model.schemes.get(scheme), { name: scheme, recipe, value })
}

function place(
	spec: SecurityScheme | undefined,
	what: { name: string; recipe: Partial<Recipe>; value: string },
): Placed {
	if (spec === undefined) return { unsatisfied: `the document declares no "${what.name}" scheme` }
	try {
		return sendsFor(spec, what.recipe, what.value)
	} catch (error) {
		return { unsatisfied: messageOf(error) }
	}
}

/* The primary scheme whose recipe and credential `scheme` uses: itself, unless this is an origin's adapter. */
function primaryOf(ctx: CredentialSourceOptions, scheme: string): string | undefined {
	return ctx.mapping === undefined ? scheme : own(ctx.mapping, scheme)
}

function recipeOf(ctx: CredentialSourceOptions, principal: string, scheme: string): Partial<Recipe> | undefined {
	const primary = primaryOf(ctx, scheme)
	if (primary === undefined) return undefined
	return effectiveRecipe(own(ctx.security, primary), own(ctx.principals, principal)?.security?.[primary])
}
