/**
 * One request's credential: resolved for every attempt, placed on it, and renewed at most once.
 *
 * Every attempt asks the source again, so a credential that went stale during a wait is renewed by
 * the store before it is sent; one that lapses during the attempt's own slot and rate waits is
 * resolved once more after them (`lapsed`, in `request.ts`). A 401 renews what that attempt sent,
 * once per request, and the retry sends the renewal; a renewal that failed leaves the 401 as the
 * answer. A refusal of a value a renewal issued goes to the run's control read (`control.ts`)
 * instead, and is renewed only when the control judges it lapsed. A probe expects the refusal, and
 * a forged value is one, so neither is renewed, and the control read's own answer is its verdict.
 * What a principal's credential places registers on the run's redactor; a forged value is no secret.
 */

import type { Exchange } from "../runtime/exchange.ts"
import { headerValue } from "../runtime/headers.ts"
import type { Redactor } from "../security/redact.ts"
import type { ControlRead, Controls } from "./control.ts"
import {
	type Actor,
	CredentialCollision,
	type CredentialSource,
	type Resolution,
	type SendsByScheme,
	UnsatisfiedSecurity,
} from "./credential-source.ts"

/** What one attempt placed: whose credential, under which schemes, and what each scheme sends. */
export interface Placement {
	principal?: string
	schemes: string[]
	forged: boolean
	sends: SendsByScheme
}

/** An attempt that carries no credential. */
export const NOTHING_PLACED: Placement = /* @__PURE__ */ Object.freeze({ forged: false, schemes: [], sends: {} })

export interface RequestCredential {
	/** What the next attempt places. Raises `UnsatisfiedSecurity` when the request's security cannot be met. */
	next(): Promise<Placement>
	/** After a 401: renews what the last attempt sent, once per request. Whether the request should be sent again. */
	renew(): Promise<boolean>
	/** Whether what the last attempt placed is no longer current (renewed since, or stale); never for a probe. Never awaits. */
	lapsed(): boolean
	/**
	 * The request was refused and not renewed: when it carried a value a renewal issued, the control
	 * read (`send`, once per value) judges it. Whether it should be sent again: the value lapsed after
	 * it was accepted, and its renewal, shared with every request refused on it, issued a credential.
	 */
	refused(send: (read: ControlRead) => Promise<Exchange>): Promise<boolean>
	/** The request was answered 2xx: a value a renewal issued that it carried is proven, so a later refusal may be a lapse. */
	accepted(): void
}

/** A request's actor, as the client hands it to the source. */
export interface Acting {
	actor: Actor
	/** `<METHOD> <path>`: what a refusal names. */
	route: string
	operationId?: string | undefined
	probe?: boolean | undefined
	/** The client's own control read: its answer is the verdict, so it is never renewed or judged. */
	control?: true | undefined
}

/** The credential of one request, over the client's source. */
export function requestCredential(
	wire: { controls: Controls; credentials: CredentialSource | undefined; redactor: Redactor },
	acting: Acting,
): RequestCredential {
	const probe = acting.probe === true || "forged" in acting.actor
	const request = {
		actor: acting.actor,
		route: acting.route,
		...(acting.operationId === undefined ? {} : { operationId: acting.operationId }),
		probe,
	}
	let last: Resolution | undefined
	let renewal: Resolution | undefined
	let renewed = false
	/* Renews what `sent` carried and places the renewal on the next attempt; false when the store blocked it. */
	const renewFrom = async (sent: Resolution & { kind: "sends" }): Promise<boolean> => {
		renewed = true
		const next = await sent.refresh()
		/* A renewal the store BLOCKED sends nothing more: the refusal this request got is its answer. */
		if (next.kind !== "sends") return false
		wire.controls.renewed(next)
		renewal = next
		return true
	}
	const judged = (sent: Resolution | undefined): sent is Resolution & { kind: "sends" } =>
		acting.control !== true && sent?.kind === "sends" && wire.controls.renewal(sent)
	return {
		accepted: () => {
			if (judged(last)) wire.controls.accepted(last)
		},
		next: async () => {
			last = renewal ?? (await resolveWith(wire.credentials, request))
			renewal = undefined
			return placementOf(last, { actor: acting.actor, redactor: wire.redactor })
		},
		/* A probe sends what it resolved, as it renews nothing: the refusal it expects is the answer. */
		lapsed: () => !probe && last?.kind === "sends" && last.lapsed(),
		refused: async (send) => {
			/* Only a value a renewal issued is judged: any other refusal is the answer as it stands. */
			if (!judged(last)) return false
			const verdict = await wire.controls.confirm(last, send)
			return verdict === "lapsed" && !renewed && !probe && renewFrom(last)
		},
		renew: async () => {
			if (renewed || probe || acting.control === true || last?.kind !== "sends" || wire.controls.renewal(last))
				return false
			return renewFrom(last)
		},
	}
}

/** What `request` would send, resolved by `source`, with nothing sent; a client without one has nothing to place. */
export function resolveWith(
	source: CredentialSource | undefined,
	request: { actor: Actor; route: string; operationId?: string; probe: boolean },
): Promise<Resolution> {
	if (source !== undefined) return source.resolve(request)
	if ("anonymous" in request.actor) return Promise.resolve({ kind: "anonymous" })
	return Promise.resolve({ kind: "unsatisfied", reason: "this client holds no credentials" })
}

/*
 * A principal whose operation's security is `[]` places nothing, yet the exchange is still theirs: what
 * it creates is theirs to tear down.
 */
function placementOf(resolution: Resolution, { actor, redactor }: { actor: Actor; redactor: Redactor }): Placement {
	switch (resolution.kind) {
		case "unsatisfied":
		case "blocked":
			throw new UnsatisfiedSecurity(resolution.kind, resolution.reason)
		case "sends":
			refuseDeferredEnv(resolution.sentValues)
			redactor.registerPlacement(resolution.secrets)
			return { forged: false, principal: resolution.principal, schemes: resolution.schemes, sends: resolution.sends }
		case "held":
			redactor.registerPlacement(resolution.secrets)
			return { forged: false, principal: resolution.principal, schemes: resolution.schemes, sends: resolution.sends }
		case "forged":
			if (resolution.secrets !== undefined) redactor.registerPlacement(resolution.secrets)
			return { forged: true, schemes: resolution.schemes, sends: resolution.sends }
		default:
			return "principal" in actor
				? { forged: false, principal: actor.principal, schemes: [], sends: {} }
				: NOTHING_PLACED
	}
}

/* What `env()` reads as while doctor or plan defers an unset variable. */
const DEFERRED_ENV = /^\$\{[A-Z0-9_]+\}$/

/*
 * A run never defers env, so a `${NAME}` literal here means that rule broke: sending it would put
 * the variable's name on the wire as a credential. A basic pair is `user:pass`, so each half is read.
 */
function refuseDeferredEnv(sentValues: Readonly<Record<string, string>>): void {
	for (const [scheme, value] of Object.entries(sentValues)) {
		const literal = value.split(":").find((part) => DEFERRED_ENV.test(part))
		if (literal !== undefined) {
			throw new Error(
				`oat: the ${scheme} credential is the unset variable ${literal}; a run never defers env, so this is a bug`,
			)
		}
	}
}

/** Where one attempt goes before its credential: the URL, the query the caller named, and its header layers. */
export interface Unplaced {
	url: URL
	/** Query parameters the caller set, which a placed one must not override. */
	callerQuery: ReadonlySet<string>
	/** Globals, then the `resolveHeaders` hook's, then the caller's: later layers win. */
	layers: ReadonlyArray<Readonly<Record<string, string>>>
}

/**
 * The attempt's URL and headers with the credential placed: a header set, a query parameter on a copy
 * of the URL, a cookie merged into the Cookie header. Raises `CredentialCollision` when any layer
 * already sends something under a placed name, which would override or shadow the scheme.
 */
export function placeOn(placement: Placement, unplaced: Unplaced): { url: URL; headers: Record<string, string> } {
	const headers: Record<string, string> = Object.assign({}, ...unplaced.layers)
	if (placement.schemes.length === 0) return { headers, url: unplaced.url }
	refuseCollisions(placement, unplaced)
	const url = new URL(unplaced.url)
	const cookies: string[] = []
	const query: string[] = []
	for (const sends of Object.values(placement.sends)) {
		Object.assign(headers, sends.headers)
		for (const [name, value] of Object.entries(sends.query)) {
			query.push(`${encodeURIComponent(name)}=${encodeURIComponent(value)}`)
		}
		for (const [name, value] of Object.entries(sends.cookies)) cookies.push(`${name}=${value}`)
	}
	/* Appended as written, not through `searchParams`, which would rewrite the whole query as a form
	 * (a space as `+`, a reserved character escaped) and undo each parameter's declared style. No
	 * collision reached here, so appending is setting. */
	if (query.length > 0) url.search = [url.search.slice(1), ...query].filter(Boolean).join("&")
	if (cookies.length > 0) {
		const name = Object.keys(headers).find((key) => key.toLowerCase() === "cookie") ?? "cookie"
		headers[name] = [headers[name], ...cookies].filter(Boolean).join("; ")
	}
	return { headers, url }
}

function refuseCollisions(placement: Placement, unplaced: Unplaced): void {
	const sent = unplaced.layers.flatMap((layer) => Object.keys(layer))
	const cookies = new Set(unplaced.layers.flatMap((layer) => cookieNames(headerValue(layer, "cookie"))))
	for (const [scheme, sends] of Object.entries(placement.sends)) {
		const placed = new Set(Object.keys(sends.headers).map((name) => name.toLowerCase()))
		const header = sent.findLast((name) => placed.has(name.toLowerCase()))
		if (header !== undefined) throw new CredentialCollision("header", { name: header, scheme })
		const query = Object.keys(sends.query).find((name) => unplaced.callerQuery.has(name))
		if (query !== undefined) throw new CredentialCollision("query", { name: query, scheme })
		const cookie = Object.keys(sends.cookies).find((name) => cookies.has(name))
		if (cookie !== undefined) throw new CredentialCollision("cookie", { name: cookie, scheme })
	}
}

function cookieNames(header: string | undefined): string[] {
	return (header ?? "").split(";").map((pair) => pair.replace(/=.*$/s, "").trim())
}

/** The header names and query parameters a placement put on a request, which a hop to another origin must drop. */
export function placedNames(placement: Placement): { headers: string[]; query: ReadonlySet<string> } {
	const sends = Object.values(placement.sends)
	return {
		headers: sends.flatMap((each) => Object.keys(each.headers)),
		query: new Set(sends.flatMap((each) => Object.keys(each.query))),
	}
}
