/* Network failures as Node / undici raise them. */

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
