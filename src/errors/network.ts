/*
 * What kind of failure a request met before any server answered: no interface, no DNS, refused,
 * reset, timed out, unreachable. A network failure is not a backend status, and every report says
 * which it was.
 */

export type NetworkKind = "offline" | "dns" | "refused" | "reset" | "timeout" | "unreachable" | "unknown"

export class NetworkError extends Error {
	readonly code = "NETWORK" as const
	readonly kind: NetworkKind
	readonly attempts: number
	readonly method: string
	readonly url: string

	constructor(options: {
		kind: NetworkKind
		message: string
		attempts: number
		method: string
		url: string
		cause?: unknown
	}) {
		super(options.message, options.cause === undefined ? undefined : { cause: options.cause })
		this.name = "NetworkError"
		this.attempts = options.attempts
		this.kind = options.kind
		this.method = options.method
		this.url = options.url
	}
}

export function isNetworkError(error: unknown): error is NetworkError {
	return error instanceof NetworkError
}

const DNS: ReadonlySet<string> = /* @__PURE__ */ new Set([
	"ENOTFOUND",
	"EAI_AGAIN",
	"EAI_FAIL",
	"EAI_NODATA",
	"EAI_NONAME",
])
const REFUSED: ReadonlySet<string> = /* @__PURE__ */ new Set(["ECONNREFUSED"])
const RESET: ReadonlySet<string> = /* @__PURE__ */ new Set([
	"ECONNRESET",
	"EPIPE",
	"UND_ERR_SOCKET",
	"UND_ERR_DESTROYED",
])
const TIMEOUT: ReadonlySet<string> = /* @__PURE__ */ new Set([
	"ETIMEDOUT",
	"UND_ERR_CONNECT_TIMEOUT",
	"UND_ERR_HEADERS_TIMEOUT",
	"UND_ERR_BODY_TIMEOUT",
	"TimeoutError",
	"AbortError",
])
const UNREACHABLE: ReadonlySet<string> = /* @__PURE__ */ new Set([
	"ENETUNREACH",
	"ENETDOWN",
	"EHOSTUNREACH",
	"EHOSTDOWN",
])
const OFFLINE: ReadonlySet<string> = /* @__PURE__ */ new Set([
	"ENONET",
	"ERR_NETWORK_CHANGED",
	"ERR_INTERNET_DISCONNECTED",
])
const NOT_NETWORK = /CERT|UNABLE_TO_VERIFY|ERR_TLS|ERR_SSL|ERR_INVALID_URL|ERR_INVALID_ARG/

export function classifyNetworkError(error: unknown): NetworkKind | null {
	const tokens = errorTokens(error)
	if (tokens.some((token) => NOT_NETWORK.test(token))) return null

	const hit = (set: ReadonlySet<string>): boolean => tokens.some((token) => set.has(token))
	if (hit(OFFLINE)) return "offline"
	if (hit(UNREACHABLE)) return "unreachable"
	if (hit(DNS)) return "dns"
	if (hit(REFUSED)) return "refused"
	if (hit(RESET)) return "reset"
	if (hit(TIMEOUT)) return "timeout"

	const text = tokens.join(" ")
	if (/fetch failed|networkerror|failed to fetch|socket hang up|getaddrinfo/i.test(text)) return "unknown"
	return null
}

export function describeNetworkKind(kind: NetworkKind): string {
	switch (kind) {
		case "offline":
			return "this machine has no usable network interface"
		case "dns":
			return "DNS could not resolve the host"
		case "refused":
			return "the host refused the connection"
		case "reset":
			return "the connection was reset"
		case "timeout":
			return "the connection timed out"
		case "unreachable":
			return "no route to the host"
		case "unknown":
			return "the request never reached the server"
	}
}

export function describeNetworkFailure(error: NetworkError, waitedMs = 0): string {
	const wait = waitedMs > 0 ? ` and ${Math.round(waitedMs / 1000)}s waiting for the link` : ""
	return (
		`${error.method} ${error.url} failed (${error.kind}: ${describeNetworkKind(error.kind)}) ` +
		`after ${error.attempts} attempt(s)${wait}. This is not a backend status.`
	)
}

function errorTokens(error: unknown): string[] {
	const tokens: string[] = []
	const seen = new Set<unknown>()
	let current: unknown = error
	while (current !== null && typeof current === "object" && !seen.has(current)) {
		seen.add(current)
		const rec = current as { code?: unknown; cause?: unknown; name?: unknown; message?: unknown }
		if (typeof rec.code === "string" && rec.code !== "") tokens.push(rec.code)
		if (typeof rec.name === "string" && rec.name !== "") tokens.push(rec.name)
		if (typeof rec.message === "string" && rec.message !== "") tokens.push(rec.message)
		current = rec.cause
	}
	if (typeof error === "string") tokens.push(error)
	return tokens
}
