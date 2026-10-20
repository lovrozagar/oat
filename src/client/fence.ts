/** The fence every hop of a request asks before it is sent. */

import type { Purpose } from "../runtime/exchange.ts"
import type { Fence } from "../runtime/fence.ts"
import type { Placement } from "./placing.ts"

/** Asks the fence about one hop; it throws when the hop is refused. */
export type FenceAsk = (target: URL, method: string, body: unknown) => Promise<void>

export interface Fenced {
	/** The hop's headers as they are when it is asked: redirects strip and add some. */
	headers: Record<string, string>
	purpose: Purpose | undefined
	operationId: string | undefined
	/** The attempt's credential: whose, and under which schemes. */
	placement: Placement
}

/** Asks `fence` with what the request is sending at the time of the ask; no fence lets everything through. */
export function fenceAsker(fence: Fence | undefined, fenced: Fenced): FenceAsk {
	return async (target, method, body) => {
		await fence?.check({
			body,
			headers: { ...fenced.headers },
			method,
			phase: fenced.purpose ?? "request",
			url: target.toString(),
			...(fenced.operationId === undefined ? {} : { operationId: fenced.operationId }),
			...whoSends(fenced.placement),
		})
	}
}

/* Who the credential is, by the names a fence can match without parsing a header; nothing when none is placed. */
function whoSends({ forged, principal, schemes }: Placement): {
	principal?: string
	schemes?: string[]
	forged?: true
} {
	return {
		...(principal === undefined ? {} : { principal }),
		...(schemes.length === 0 ? {} : { schemes }),
		...(forged ? { forged: true } : {}),
	}
}
