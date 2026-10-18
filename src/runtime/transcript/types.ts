/** What is known about a body's bytes as they crossed the wire. */

export interface BodyDigest {
	bytes: number
	sha256: string
}

/** What is already known about a request body as it went out: its size, and its hash when large. */
export interface SentBody {
	bytes?: number
	digest?: BodyDigest | undefined
}

/** What is already known about a response body as it came in: its size, and its hash when large. */
export interface ReceivedBody {
	bytes?: number | undefined
	digest?: BodyDigest | undefined
}

export interface ResponsePayload {
	parsed: unknown
	bodyBytes: number
	/** Size and hash of the bytes as received, for a body too large to keep inline. */
	digest?: BodyDigest
}
