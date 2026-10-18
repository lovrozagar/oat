/** A request and its answer as the reference sees them, whichever transport carried them. */

export type Json = Record<string, unknown>

export interface ReferenceRequest {
	/** Upper-cased. */
	method: string
	/** Below the base path, when the shape mounts one. */
	url: URL
	/** Lower-cased names. */
	headers: Readonly<Record<string, string>>
	/** The body as text; read once, however often asked. */
	text: () => Promise<string>
}

export interface ReferenceResponse {
	status: number
	headers: Record<string, string>
	body: string
}

export function respond(status: number, body: unknown, extraHeaders: Record<string, string> = {}): ReferenceResponse {
	const payload = JSON.stringify(body)
	return {
		body: payload,
		headers: {
			"content-length": String(Buffer.byteLength(payload)),
			"content-type": "application/json",
			...extraHeaders,
		},
		status,
	}
}

/** What a request carries beside its method and URL: its headers, and how to read its body. */
export interface ReferenceInit {
	headers: Readonly<Record<string, string>>
	read: () => Promise<string>
}

/** A request whose body is read at most once. */
export function referenceRequest(method: string, url: URL, { headers, read }: ReferenceInit): ReferenceRequest {
	let body: Promise<string> | undefined
	return { headers, method: method.toUpperCase(), text: () => (body ??= read()), url }
}
