/*
 * A transport that logs each request a run sends as it leaves the process, and the status and body
 * the server answered: what a reference test asserts about the wire without a proxy in front of it.
 */

/** One request on the wire: its method, path with the raw query, headers, and the answer. */
export interface WireEntry {
	method: string
	/** Path and query exactly as sent, e.g. `/v1/styles?range[min]=1`. */
	path: string
	headers: Record<string, string>
	status: number
	/** The answer's text, read from a copy, so the run still reads its own. */
	answer: string
}

export interface WireLog {
	fetch: typeof fetch
	entries: WireEntry[]
}

/** A `network.fetch` for `run()` that forwards to the global fetch and logs every exchange. */
export function wireLog(): WireLog {
	const entries: WireEntry[] = []
	const logged: typeof fetch = async (input, init) => {
		const request = new Request(input, init)
		const response = await fetch(request.clone())
		const url = new URL(request.url)
		entries.push({
			answer: await response.clone().text(),
			headers: Object.fromEntries(request.headers),
			method: request.method,
			path: `${url.pathname}${url.search}`,
			status: response.status,
		})
		return response
	}
	return { entries, fetch: logged }
}

/** The `Authorization` header of each logged request to `path` (no query) answered `status`. */
export function sentTo(log: WireLog, path: string, status = 200): string[] {
	return log.entries
		.filter((entry) => entry.path.split("?")[0] === path && entry.status === status)
		.map((entry) => entry.headers["authorization"] ?? "")
}
