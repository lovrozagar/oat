/*
 * The control read that tells a dead principal from a route that refuses it. When a freshly renewed
 * credential is refused, the last read that accepted the principal × scheme this run is sent once more
 * with it, as a normal request. Refused there too, the pair is BLOCKED: the server will not take this
 * principal's credential at all, however often it is renewed. Accepted, the refusal belongs to the
 * route, and stands as its answer. With no such read there is nothing to compare, and nothing is
 * decided. A value a renewal issued is never renewed again: any request it is refused for goes to the
 * control, which runs once per value, so every other refusal of it resolves from that one verdict.
 * A write is never a control.
 */

import type { Exchange } from "../runtime/exchange.ts"
import type { RequestOptions } from "./types.ts"

/** A read that accepted a principal's credential: what a control sends again. */
export interface ControlRead {
	method: string
	path: string
	options: RequestOptions
	operationId: string | undefined
}

/** What a refused request sent: whose credential, its value by scheme, and how to block it. */
export interface Sent {
	principal: string
	sentValues: Readonly<Record<string, string>>
	block(reason: string): void
}

/** The run's control reads and their verdicts. */
export interface Controls {
	/** Keeps `read` as its principal × schemes' control when `exchange` shows it accepted the credential. */
	note(exchange: Exchange, read: ControlRead): void
	/** Records the values a renewal issued. */
	renewed(sent: Sent): void
	/** Whether `sent` carried a value a renewal issued: a refusal of it goes to the control, never to a renewal. */
	renewal(sent: Sent): boolean
	/** Sends the control for a refused, freshly renewed value, once per value; blocks the pair when it is refused too. */
	confirm(sent: Sent, send: (read: ControlRead) => Promise<Exchange>): Promise<void>
}

const READS: ReadonlySet<string> = /* @__PURE__ */ new Set(["GET", "HEAD", "QUERY"])

const pairOf = (principal: string, scheme: string): string => `${principal}\u0000${scheme}`

/* Each value `sent` carried, keyed by its principal and scheme. */
const valuesOf = (sent: Sent): string[] =>
	Object.entries(sent.sentValues).map(([scheme, value]) => `${pairOf(sent.principal, scheme)}\u0000${value}`)

/** Controls for one run: none noted, nothing judged. */
export function createControls(): Controls {
	const accepted = new Map<string, ControlRead>()
	const renewals = new Set<string>()
	const judged = new Set<string>()
	return {
		async confirm(sent, send) {
			const values = valuesOf(sent)
			if (values.some((value) => judged.has(value))) return
			for (const value of values) judged.add(value)
			const read = Object.keys(sent.sentValues)
				.map((scheme) => accepted.get(pairOf(sent.principal, scheme)))
				.find((candidate) => candidate !== undefined)
			if (read === undefined) return
			const control = await send(read)
			if (control.status !== 401) return
			const named = read.operationId ?? `${read.method} ${read.path}`
			sent.block(`signed in again, and the new credential is refused where the old one was accepted (${named})`)
		},
		renewal: (sent) => valuesOf(sent).some((value) => renewals.has(value)),
		renewed(sent) {
			for (const value of valuesOf(sent)) renewals.add(value)
		},
		note(exchange, read) {
			const { principal, schemes, status } = exchange
			if (!READS.has(exchange.method) || status < 200 || status >= 300) return
			if (principal === undefined || exchange.forged === true) return
			for (const scheme of schemes ?? []) accepted.set(pairOf(principal, scheme), read)
		},
	}
}
