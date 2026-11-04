/*
 * The control read that tells a dead principal from a route that refuses it. When a credential a
 * renewal issued is refused, the last read that accepted the principal × scheme this run is sent once
 * more, as the client's own control request. Accepted, the refusal belongs to the route, and stands
 * as its answer. Refused there too, it depends on whether any request accepted the value first: one
 * never accepted means the server will not take this principal's credential however often it is
 * renewed, so the pair is BLOCKED; one accepted and refused everywhere now has lapsed, so it is
 * renewed through the store, which BLOCKS it in turn when that renewal is refused. With no such read
 * there is nothing to compare, and nothing is decided. The control runs once per value, and every
 * refusal of it resolves from that one verdict, so a route that refuses the principal never renews it.
 * A write is never a control.
 */

import type { Exchange } from "../runtime/exchange.ts"
import { READS } from "../spec/methods.ts"
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

/** What the control read decided about a refused value: the route refused it, the principal is blocked, or it lapsed. */
export type Verdict = "route" | "blocked" | "lapsed" | "undecided"

/** The run's control reads and their verdicts. */
export interface Controls {
	/** Keeps `read` as its principal × schemes' control when `exchange` shows it accepted the credential. */
	note(exchange: Exchange, read: ControlRead): void
	/** Records the values a renewal issued. */
	renewed(sent: Sent): void
	/** Whether `sent` carried a value a renewal issued: a refusal of it goes to the control, never straight to a renewal. */
	renewal(sent: Sent): boolean
	/** Records that a request carrying `sent`'s values, which a renewal issued, was answered 2xx. */
	accepted(sent: Sent): void
	/**
	 * The verdict on a refused value a renewal issued: the control read is sent once per value, every
	 * other refusal of it awaits the same verdict, and a pair never accepted is BLOCKED when it is refused too.
	 */
	confirm(sent: Sent, send: (read: ControlRead) => Promise<Exchange>): Promise<Verdict>
}

const pairOf = (principal: string, scheme: string): string => `${principal}\u0000${scheme}`

/* Each value `sent` carried, keyed by its principal and scheme. */
const valuesOf = (sent: Sent): string[] =>
	Object.entries(sent.sentValues).map(([scheme, value]) => `${pairOf(sent.principal, scheme)}\u0000${value}`)

/** Controls for one run: none noted, nothing judged. */
export function createControls(): Controls {
	const accepted = new Map<string, ControlRead>()
	const renewals = new Set<string>()
	const proven = new Set<string>()
	const verdicts = new Map<string, Promise<Verdict>>()
	const judge = async (sent: Sent, send: (read: ControlRead) => Promise<Exchange>): Promise<Verdict> => {
		const read = Object.keys(sent.sentValues)
			.map((scheme) => accepted.get(pairOf(sent.principal, scheme)))
			.find((candidate) => candidate !== undefined)
		if (read === undefined) return "undecided"
		const control = await send(read)
		if (control.status !== 401) return "route"
		if (valuesOf(sent).some((value) => proven.has(value))) return "lapsed"
		const named = read.operationId ?? `${read.method} ${read.path}`
		sent.block(`signed in again, and the new credential is refused where the old one was accepted (${named})`)
		return "blocked"
	}
	return {
		accepted(sent) {
			for (const value of valuesOf(sent)) proven.add(value)
		},
		confirm(sent, send) {
			const values = valuesOf(sent)
			const judged = values.map((value) => verdicts.get(value)).find((verdict) => verdict !== undefined)
			if (judged !== undefined) return judged
			const verdict = judge(sent, send)
			for (const value of values) verdicts.set(value, verdict)
			return verdict
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
