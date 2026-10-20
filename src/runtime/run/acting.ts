/*
 * Who a principal is, and what it would send on an operation, resolved over the run's store as the
 * client would resolve it: what a hook is told in place of the headers it used to get. A hook can
 * decode the credential, or send it where its scheme places it, and never sees another header.
 */

import { createCredentialSource } from "../../client/credentials.ts"
import type { Sends } from "../../config/types/hooks.ts"
import type { Acting } from "../contract/types.ts"
import type { RunContext } from "./context.ts"
import { boundOf } from "./identity.ts"

/** `principal`'s identity, and the credential each operation would carry as it. */
export function actingOf(ctx: Pick<RunContext, "model" | "options" | "store">, principal: string): Acting {
	const { model, options, store } = ctx
	const source = createCredentialSource({
		model,
		principals: store.principals,
		security: options.security ?? {},
		store,
	})
	return {
		identity: boundOf(store.identityOf(principal)).identity,
		sending: async (operationId) => {
			const op = model.byOperationId.get(operationId)
			const route = op === undefined ? operationId : `${op.method.toUpperCase()} ${op.path}`
			const resolved = await source.resolve({ actor: { principal }, operationId, route })
			if (resolved.kind !== "sends") return undefined
			/* An alternative of two schemes sends both; the first one's value is the credential. */
			const schemes = resolved.schemes.map((scheme) => resolved.sends[scheme] as Sends)
			const sends = schemes.reduce<Sends>(
				(all, one) => ({
					cookies: { ...all.cookies, ...one.cookies },
					headers: { ...all.headers, ...one.headers },
					query: { ...all.query, ...one.query },
				}),
				{ cookies: {}, headers: {}, query: {} },
			)
			return { credential: resolved.sentValues[resolved.schemes[0] as string] as string, sends }
		},
	}
}
