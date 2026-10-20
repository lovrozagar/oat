import type { PrincipalEntry } from "../../config/types/security.ts"
import type { AuthStep } from "../../config/types/steps.ts"
import { effectiveRecipe } from "../../credentials/effective.ts"
import type { CredentialStore } from "../../credentials/store.ts"
import { recipeKind } from "../../credentials/recipes/acquire.ts"
import { isNetworkError } from "../../errors/network.ts"
import type { RunFindingId } from "../check-ids.ts"
import type { OperationModel } from "../../spec/graph/types.ts"
import type { Owner } from "../teardown/types.ts"
import type { Planned, RunPrincipal, RunPrincipals } from "./context.ts"
import { provision } from "./fresh.ts"
import { boundOf } from "./identity.ts"

/*
 * The principals stage, at run start. A fresh principal is signed up first (D7). Then every login a
 * principal's recipes name is run, before anything is planned, so a tenant or `scope.<param>` its
 * claims bind is what isolation and the parents are planned from; a mint or an OAuth 2 grant waits
 * until a request needs it. A principal whose signup or login fails is BLOCKED: reported once with
 * the reason, and the run goes on without it.
 */

type Blocked = RunPrincipals["blocked"][number]

/**
 * The run's principals, signed in. `null` when the network went away while signing them in (the
 * outage is noted), or when none of them could be: the run has nobody to act as.
 */
export async function resolvePrincipals(planned: Planned): Promise<RunPrincipals | null> {
	const { findings, network, options, progress } = planned
	const all: RunPrincipal[] = []
	const blocked: Blocked[] = []
	for (const [id, entry] of Object.entries(options.principals)) {
		let reason: string | undefined
		try {
			reason = await signIn(planned, id, entry)
		} catch (error) {
			if (!isNetworkError(error)) throw error
			await network.note(error, "auth")
		}
		if (network.outcome !== undefined) return null
		if (reason === undefined) {
			all.push(runPrincipal(planned.store, id))
			continue
		}
		blocked.push({ id, reason })
		findings.blocked("auth.blocked" satisfies RunFindingId, id, {
			summary: `principal "${id}" is BLOCKED`,
			cause: reason,
		})
	}
	progress.tick({ message: `${all.length} principal(s)`, phase: "auth", requests: progress.requests })
	return all.length === 0 ? null : runPrincipals(planned, { all, blocked })
}

/* Signs the principal up when it is fresh, then runs each login it has; the first failure's reason. */
async function signIn(planned: Planned, id: string, entry: PrincipalEntry): Promise<string | undefined> {
	if (entry.fresh === true) {
		const made = await provision(planned, { entry, id, label: id })
		if ("blocked" in made) return made.blocked
	}
	return logIn(planned, id, entry)
}

/** Runs each login the principal's recipes name, as the principals stage does; the first failure's reason. */
export async function logIn(planned: Planned, id: string, entry: PrincipalEntry): Promise<string | undefined> {
	const { options, store } = planned
	const security = options.security ?? {}
	for (const scheme of new Set([...Object.keys(security), ...Object.keys(entry.security ?? {})])) {
		const recipe = effectiveRecipe(security[scheme], entry.security?.[scheme])
		if (recipe === undefined || recipeKind(recipe) !== "login") continue
		const held = await store.acquire({ principal: id, scheme })
		if ("blocked" in held) return held.blocked
	}
	return undefined
}

/**
 * Whether the run made this principal's account, so teardown removes it: a `fresh` one, one declared
 * `created`, or one whose login recipe registers it through the operation the document marks
 * `x-fresh-principal`. Never a configured account, whatever its login binds or answers.
 */
export function createdByRun(planned: Pick<Planned, "model" | "options" | "store">, id: string): boolean {
	const entry = planned.store.principals[id] as PrincipalEntry
	if (entry.fresh === true || entry.created === true) return true
	const signup = planned.model.operations.find((op) => op.freshPrincipal)
	if (signup === undefined) return false
	const security = planned.options.security ?? {}
	return [...new Set([...Object.keys(security), ...Object.keys(entry.security ?? {})])].some((scheme) => {
		const recipe = effectiveRecipe(security[scheme], entry.security?.[scheme])
		return recipe?.login?.steps.some((step) => calls(step, signup)) === true
	})
}

/* A step sends `op` by its operationId, or by its method and path on the primary origin. */
function calls(step: AuthStep, op: OperationModel): boolean {
	if ("operationId" in step) return step.operationId === op.operationId
	if (!("path" in step) || step.origin !== undefined) return false
	return step.method.toUpperCase() === op.method.toUpperCase() && step.path === op.path
}

/** The principal as the store holds it, once its logins bound their claims. */
export function runPrincipal(store: CredentialStore, id: string): RunPrincipal {
	const entry = store.principals[id] as PrincipalEntry
	const { identity, scope, tenant } = boundOf(store.identityOf(id))
	return {
		fresh: entry.fresh === true,
		id,
		identity,
		rank: entry.rank ?? 0,
		scope,
		...(tenant === undefined ? {} : { tenant }),
		...(entry.inviteAs === undefined ? {} : { inviteAs: entry.inviteAs }),
	}
}

function runPrincipals(planned: Planned, signed: { all: RunPrincipal[]; blocked: Blocked[] }): RunPrincipals {
	const { ledger } = planned
	const { all, blocked } = signed
	const alpha = all[0] as RunPrincipal
	const byId = new Map(all.map((principal) => [principal.id, principal]))
	return {
		all,
		alpha,
		blocked,
		byId,
		fallbackDeleters: (owner) => {
			const creator = byId.get(owner.id)
			if (creator === undefined) return []
			return all
				.filter((principal) => principal.id !== creator.id && sameTenant(principal, creator))
				.sort((a, b) => b.rank - a.rank)
				.map(ownerOf)
		},
		ownerOf,
		peerOf: (principal) => all.find((other) => !sameTenant(principal, other)),
		recordCreated: (created, principal) => {
			const sender = principal === undefined ? undefined : byId.get(principal)
			ledger.record(created, ownerOf(sender ?? alpha))
		},
		recorder: (owner) => (entity, id, scope) => ledger.record({ entity, id, scope }, owner),
		sameTenant,
		unidentified: (entity, operationId, exchange) => ledger.unidentified(entity, operationId, exchange),
	}
}

/** Two principals are of one tenant when their tenants agree: no tenant at all is one tenant too. */
function sameTenant(a: RunPrincipal, b: RunPrincipal): boolean {
	return a.tenant === b.tenant
}

/** Who owns what a principal creates: removed as it. */
function ownerOf(principal: RunPrincipal): Owner {
	return { id: principal.id }
}
