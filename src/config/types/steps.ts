/* The steps a sign-in flow or a scenario runs: operation calls, raw requests, out-of-band waits. */

interface StepBase {
	/**
	 * Binds parts of the response into the flow's scope. Later steps interpolate them as
	 * `{name}`, and `rootsFromFlow` can promote them to path parameters.
	 *
	 * Address forms:
	 * - `$.access_token` / `$.orgs.0.id` — JSON body (dot + numeric index only)
	 * - `cookie:<name>` — that cookie on `Set-Cookie` for this hop (and followed hops)
	 * - `header:<name>` — a non-set-cookie response header, case-insensitive
	 *
	 * Missing cookie / header / JSON path fails the auth step closed.
	 */
	saveAs?: Record<string, string>
	/**
	 * Binds values out of a JWT's claims. Tenancy commonly rides in the token rather than the
	 * response body, and a principal that can name its own tenant needs no roots configured. The
	 * signature is not verified — oat is reading its own credential, not trusting a third party.
	 * `token` is a JSON path into the response body (`$.access_token`) or a scope key already
	 * bound by `saveAs` (`credential`).
	 */
	saveClaimsFrom?: { token: string; bind: Record<string, string> }
	/** Literal values bound before the step runs, with `{name}` interpolation. */
	bind?: Record<string, string>
	/** Accepted statuses. Defaults to any 2xx. */
	expect?: number[]
}

/** Calls an operation named in the document. Prefer this — it survives the path moving. */
export interface OperationStep extends StepBase {
	operationId: string
	body?: unknown
	/** One of the request media types the operation documents. Default: oat's preferred one. */
	mediaType?: string
	headers?: Record<string, string>
	query?: Record<string, string>
	/** Named `origins[]` entry. Omit to hit the primary `baseUrl`. */
	origin?: string
}

/** Calls a raw path, for endpoints the document does not describe. */
export interface RequestStep extends StepBase {
	method: string
	/**
	 * Path relative to this origin's `baseUrl`, or an absolute `http://` / `https://` URL.
	 * Absolute URLs are not joined to `baseUrl` — that is how a consume page on the app origin
	 * is a recorded hop when the spec origin is the API.
	 */
	path: string
	body?: unknown
	headers?: Record<string, string>
	query?: Record<string, string>
	/** Named `origins[]` entry. Omit to hit the primary `baseUrl`. Ignored for absolute URLs. */
	origin?: string
	/**
	 * Redirect policy for this hop. Default `follow` uses a per-request cookie jar so a 303
	 * that sets `Set-Cookie` still leaves that cookie visible to `saveAs`. `manual` stops at
	 * the first 3xx (`expect: [303]` then reads cookies from that response).
	 */
	redirect?: "follow" | "manual"
}

/**
 * A value that never travels over HTTP — an emailed verification token, an OTP, a magic link.
 *
 * oat declares the need and calls `hooks.resolveOutOfBand` to satisfy it, polling with backoff
 * because such stores are usually eventually consistent. That hook is the entire coupling
 * surface between oat and one specific backend. The hook returns a string (a token, or the
 * mailed URL); oat records the consume hop only when a later RequestStep GETs that URL.
 */
export interface OutOfBandStep {
	outOfBand: {
		address: string
		kind: string
		as: string
		/**
		 * The value was sent before this scenario or flow began — by a schedule, or into a seeded
		 * inbox — so no request here triggered it and the hook gets no `since`.
		 */
		sentEarlier?: boolean
	}
}

export type AuthStep = OperationStep | RequestStep | OutOfBandStep

/* ------------------------------------------------------------------ scenarios */

/**
 * The value at `from` in a step's response must equal, contain, or no longer hold the text after
 * `{name}` interpolation. `from` is a JSON path; `[*]` fans out over an array, so
 * `$.items[*].name` passes when any item's name matches.
 */
export interface ScenarioAssert {
	from: string
	equals?: string
	contains?: string
	/** The value must no longer appear at `from` — a removal, proven by a later read. */
	excludes?: string
	/**
	 * No node at `from` may contain this text, an object's JSON text included: what a response must
	 * never carry (`'"token":'` is a key named `token` at any depth). No node at all passes.
	 */
	omits?: string
	/**
	 * The number at `from` must be at least this. A count read from a sampled or eventually
	 * consistent store (a usage chart, an analytics total) promises a floor, not an exact value.
	 */
	atLeast?: number
	/**
	 * Earlier operations this read proves. A passing assert marks each one `verified`, with this
	 * exchange as the observation. The step's own operation always counts.
	 */
	observes?: string[]
}

/** A request in a scenario: an `OperationStep` or `RequestStep`, plus what to check. */
export type ScenarioRequestStep = (OperationStep | RequestStep) & {
	/** What the response must show; a list must all hold on the same exchange. */
	assert?: ScenarioAssert | ScenarioAssert[]
	/** Re-send until the assert passes or `within` (`"30s"`, `"500ms"`, `"2m"`) runs out. */
	poll?: { within: string; everyMs?: number }
	/** Send without the scenario principal's credential. */
	anonymous?: boolean
	/** Send as this config principal instead of the scenario's — an invitee accepting, a peer reading. */
	principal?: string
}

/**
 * Something only a person or a browser can do — pay with a test card, give OAuth consent.
 * oat calls `hooks.external(name, input)` and binds the string it returns to `as`.
 */
export interface ExternalStep {
	external: string
	input?: Record<string, unknown>
	as: string
}

export type ScenarioStep = ScenarioRequestStep | OutOfBandStep | ExternalStep

/**
 * A declared flow for operations the matrix cannot reach on its own: steps run in order as one
 * principal, values flow forward through `{name}`, and each operation in `covers` is graded by
 * what the steps observed. Product knowledge lives here, in the config — not in oat.
 */
export interface Scenario {
	id: string
	/** Operations this scenario grades. Each must be called by one of its steps. */
	covers: string[]
	/** Config principal whose credential the steps send. Default: the first principal. */
	principal?: string
	/**
	 * A configured origin this scenario belongs to: its steps and `covers` are that origin's
	 * operations, and it runs where that origin is graded. Default: the main document.
	 */
	origin?: string
	steps: ScenarioStep[]
}
