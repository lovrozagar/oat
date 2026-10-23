import { NetworkError, type NetworkKind } from "../../src/errors/network.ts"

/* Network failures as Node / undici raise them, for the network tests. */

export { failing, net } from "../../src/runtime/network/__fixtures__/failures.ts"

/** One failed GET attempt of the given kind. */
export function networkError(kind: NetworkKind, message: string): NetworkError {
	return new NetworkError({ attempts: 1, kind, message, method: "GET", url: "http://x.test/" })
}
