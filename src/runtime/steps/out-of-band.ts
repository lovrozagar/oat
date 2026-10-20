/*
 * Values delivered outside HTTP: verification tokens, OTPs, magic links. oat asks the
 * `resolveOutOfBand` hook for them, and tells it when the request that triggered the delivery
 * was sent, so an inbox holding older deliveries can tell them apart.
 */

import type { Hooks } from "../../config/types/hooks.ts"
import type { Exchange } from "../exchange.ts"
import { type BackoffConfig, isAbsentValue, pollWithBackoff, resolveBackoff, worstCaseWaitMs } from "../poll.ts"

/** When an exchange's request left: its answer's time less how long it took. */
export function sentAt(exchange: Pick<Exchange, "at" | "durationMs">): number {
	return exchange.at - exchange.durationMs
}

/**
 * When the request a value delivered to `address` answers was sent: the latest of `sent` that names
 * the address in its URL or body, since that request told the backend where to deliver. A later
 * request naming someone else does not move it; when none names the address, oat cannot tell.
 */
export function triggerSentAt(
	sent: readonly Pick<Exchange, "at" | "durationMs" | "requestBody" | "url">[],
	address: string,
): number | undefined {
	if (address === "") return undefined
	const forms = [address, encodeURIComponent(address)]
	const trigger = sent.findLast((exchange) => {
		const body =
			typeof exchange.requestBody === "string" ? exchange.requestBody : JSON.stringify(exchange.requestBody ?? "")
		return forms.some((form) => exchange.url.includes(form) || body.includes(form))
	})
	return trigger === undefined ? undefined : sentAt(trigger)
}

/** What a value is, who is waiting for it, and what the hook is told alongside the address. */
export interface OutOfBandOptions {
	kind: string
	label: string
	outOfBand?: Partial<BackoffConfig>
	scope?: Record<string, string>
	/** When the request this value answers was sent; see `OutOfBandRequest.since`. */
	since?: number
}

/**
 * Out-of-band values usually land in an eventually-consistent store, so the hook is polled with
 * backoff rather than called once. A single read that happens to race the write looks exactly
 * like a broken delivery mechanism.
 */
export async function resolveOutOfBandValue(
	hook: Hooks["resolveOutOfBand"],
	address: string,
	options: OutOfBandOptions,
): Promise<string> {
	const { kind } = options
	if (hook === undefined) {
		throw new Error(
			`oat: ${options.label} needs a "${kind}" value delivered outside HTTP, ` +
				"but the config declares no resolveOutOfBand hook. oat cannot read your mail catcher, " +
				"KV store or webhook sink — supply a function that can.",
		)
	}
	const backoff = resolveBackoff(options.outOfBand)
	const scope = options.scope ?? {}
	const value = await pollWithBackoff(
		(attempt) =>
			hook({
				address,
				attempt,
				kind,
				scope,
				...(options.since === undefined ? {} : { since: options.since }),
			}),
		backoff,
		isAbsentValue,
	)
	if (typeof value === "string" && value !== "") return value
	throw new Error(
		`oat: no "${kind}" value arrived for ${address} after ${backoff.attempts} attempts ` +
			`(~${worstCaseWaitMs(backoff)}ms worst-case wait). The delivery mechanism is ` +
			"either slow beyond the backoff window or not firing at all.",
	)
}
