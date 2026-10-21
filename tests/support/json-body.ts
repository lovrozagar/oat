/** A test server's view of a request body: `{}` when it sent none, and `undefined` when it does not parse, which the server answers 400. */
export function jsonBody(raw: string): Record<string, unknown> | undefined {
	if (raw === "") return {}
	try {
		return JSON.parse(raw) as Record<string, unknown>
	} catch {
		return undefined
	}
}
