import type { Principal } from "../../config/types/principals.ts"
import { isSecretHeaderName } from "../../security/credential-names.ts"
import { credentialHeaderNames } from "../../security/strip.ts"
import { createPrincipal, holdHeaders } from "../auth.ts"
import type { Client } from "../../client/client.ts"
import { isNetworkError } from "../network.ts"
import type { Owner } from "../teardown.ts"
import type { Planned, ResolvedPrincipal, RunPrincipals } from "./context.ts"
import { messageOf } from "../../errors/message.ts"
import type { RunFindingId } from "../check-ids.ts"

/**
 * Resolves every configured principal. `null` when the network went away while doing it: the
 * outage is noted, and the run has nobody to act as.
 */
export async function resolvePrincipals(planned: Planned): Promise<ResolvedPrincipal[] | null> {
	const resolved: ResolvedPrincipal[] = []
	try {
		for (const principal of planned.options.principals) resolved.push(await resolvePrincipal(planned, principal))
	} catch (error) {
		if (!isNetworkError(error)) throw error
		await planned.network.note(error, "auth")
		return null
	}
	return resolved
}

/** The resolved principals bound to the run: each exchange names its sender, each create its owner. */
export function adoptPrincipals(planned: Planned, all: ResolvedPrincipal[]): Planned & { principals: RunPrincipals } {
	const { credentials, progress } = planned
	progress.tick({ message: `${all.length} principal(s)`, phase: "auth", requests: progress.requests })
	credentials.nameSenders((sent) => senderOf(all, sent))
	return { ...planned, principals: runPrincipals(planned, all) }
}

function runPrincipals(planned: Planned, all: ResolvedPrincipal[]): RunPrincipals {
	const { ledger, findings } = planned
	const alpha = all[0] as ResolvedPrincipal
	return {
		all,
		alpha,
		fallbackDeleters: (owner) => {
			const creator = all.find((principal) => principal.id === owner.id)
			if (creator === undefined) return []
			return all
				.filter((principal) => principal.id !== creator.id && sameTenant(principal.roots, creator.roots))
				.sort((a, b) => b.rank - a.rank)
				.map(ownerOf)
		},
		ownerOf,
		recordCreated: (entity, id, values, principal) => {
			const sender = principal === undefined ? undefined : all.find((candidate) => candidate.id === principal)
			ledger.record(entity, id, values, ownerOf(sender ?? alpha))
		},
		recorder: (owner) => (entity, id, values) => ledger.record(entity, id, values, owner),
		/*
		 * Proactive refreshes, before each entity and before the credentials are persisted. A
		 * failure is reported — the backend would not renew a session — and the run carries on to
		 * teardown, where an exception here used to end it with every record still in place.
		 */
		refreshAll: async (where) => {
			for (const principal of all) {
				try {
					await principal.runtime?.refreshIfStale()
				} catch (error) {
					findings.blocked(
						"auth.refresh" satisfies RunFindingId,
						where,
						`refreshing the credential of "${principal.id}" failed`,
						messageOf(error),
					)
					return false
				}
			}
			return true
		},
		unidentified: (entity, operationId, exchange) => ledger.unidentified(entity, operationId, exchange),
	}
}

/** Who owns what a principal creates: removed as it, with its credential. */
function ownerOf(principal: ResolvedPrincipal): Owner {
	return { headers: principal.headers, id: principal.id }
}

/**
 * Who sent a request, by the credential it carried. A principal configured with no credential —
 * an API without auth — sent whatever carries none.
 */
function senderOf(all: readonly ResolvedPrincipal[], sent: Record<string, string>): string | undefined {
	const holder = all.find((principal) => {
		const own = principal.headers()
		return Object.keys(own).length > 0 && Object.entries(own).every(([key, value]) => sent[key] === value)
	})
	if (holder !== undefined) return holder.id
	const credentials = credentialHeaderNames(all.flatMap((principal) => Object.keys(principal.headers())))
	const carries = Object.keys(sent).some((name) => credentials.has(name.toLowerCase()) || isSecretHeaderName(name))
	return carries ? undefined : all.find((principal) => Object.keys(principal.headers()).length === 0)?.id
}

/** Two sets of roots name the same tenant when every root either names agrees. */
export function sameTenant(a: Record<string, string>, b: Record<string, string>): boolean {
	const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])]
	return keys.every((key) => a[key] === b[key])
}

/**
 * Resolves a principal to something that can produce headers on demand.
 *
 * Static headers stay static; acquired credentials refresh themselves. Returning a function
 * rather than a snapshot is what lets a long run outlive a short-lived token — a five-minute TTL
 * would otherwise turn the back half of every run into spurious 401s.
 */
async function resolvePrincipal(planned: Planned, principal: Principal): Promise<ResolvedPrincipal> {
	const client = planned.client.view({ purpose: "auth" })
	/* A principal without a flow authenticates by static header — a long-lived API key needs no
	 * acquisition at all, and forcing one would be ceremony. */
	if (principal.auth === undefined) return staticPrincipal(principal, client)
	const { model, hooks, outOfBand, originClients } = planned
	const runtime = await createPrincipal(principal.id, principal.auth, {
		client,
		hooks,
		model,
		outOfBand,
		principalId: principal.id,
		...(originClients.size === 0 ? {} : { originClients }),
	})
	/* A flow that provisions a tenant produces its own roots — the run then needs no fixture
	 * identifiers configured at all. */
	const discovered: Record<string, string> = {}
	for (const [param, key] of Object.entries(principal.rootsFromFlow ?? {})) {
		const value = runtime.scope[key]
		if (value !== undefined) discovered[param] = value
	}
	const headers = (): Record<string, string> => ({ ...principal.headers, ...runtime.headers() })
	planned.credentials.bind({
		headers,
		matches: (sent) => runtime.matches(sent),
		refreshIfStale: runtime.refreshIfStale,
	})
	return {
		...described(principal),
		adoptCredential: (token) => runtime.adoptCredential(token),
		headers,
		roots: { ...discovered, ...principal.roots },
		runtime,
	}
}

function staticPrincipal(principal: Principal, client: Client): ResolvedPrincipal {
	/* A static key is a credential like any other: never written down in clear. */
	for (const [name, value] of Object.entries(principal.headers ?? {})) {
		if (!isSecretHeaderName(name) && !/key|token|secret|auth/i.test(name)) continue
		client.redactor.registerHeader(name)
		client.redactor.registerSecret(value)
	}
	return { ...described(principal), ...holdHeaders(principal.headers, client.redactor), roots: principal.roots ?? {} }
}

function described(principal: Principal): Pick<ResolvedPrincipal, "id" | "inviteAs" | "rank" | "role"> {
	return { id: principal.id, inviteAs: principal.inviteAs, rank: principal.rank ?? 0, role: principal.role }
}
