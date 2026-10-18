import { NetworkError, type NetworkKind } from "../../src/errors/network.ts"

/* Network failures as Node / undici raise them, for the network tests. */

/** A fetch failure whose nested cause carries a Node / undici error `code`. */
export function net(code: string, message = "fetch failed"): TypeError {
	const cause = Object.assign(new Error(message), { code })
	return Object.assign(new TypeError("fetch failed"), { cause })
}

/** A fetch implementation that always fails with `net(code)`. */
export function failing(code: string): () => Promise<Response> {
	return async () => {
		throw net(code)
	}
}

/** One failed GET attempt of the given kind. */
export function networkError(kind: NetworkKind, message: string): NetworkError {
	return new NetworkError({ attempts: 1, kind, message, method: "GET", url: "http://x.test/" })
}
