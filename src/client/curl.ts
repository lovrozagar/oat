/**
 * Reproducible `curl` for an exchange — the artifact backend teams actually use.
 *
 * Quoting matters here: anything holding a shell variable must be double-quoted or the script
 * silently runs against a literal `$BASE` with a literal `$TOKEN`. Everything else is
 * single-quoted so JSON bodies and query strings survive untouched.
 */

import { isSecretJsonKey } from "../security/credential-names.ts"
import { REDACTED, type Redactor } from "../security/redact.ts"
import {
	type Exchange,
	type FormSnapshot,
	isBodyRef,
	isFormData,
	isFormSnapshot,
	isRawBytes,
	isURLSearchParams,
} from "../runtime/exchange.ts"

export interface CurlOptions {
	/** The run's redactor: secret header names, and the values it was issued, never print. */
	redactor: Redactor
	/** Header names whose values are replaced by a shell variable reference, in place of the redactor's names. */
	redact?: readonly string[]
	/** Origin to replace with `"$BASE"`, so a script can be pointed at another environment. */
	origin?: string
}

/**
 * What follows `base` in `target`, when `target` lies under it: `/api` holds `/api/x` and `/api?q`,
 * not `/apiv2/x`. `undefined` otherwise.
 */
export function belowBase(target: string, base: string): string | undefined {
	const prefix = base.replace(/\/$/, "")
	if (!target.startsWith(prefix)) return undefined
	const rest = target.slice(prefix.length)
	return rest === "" || /^[/?#]/.test(rest) ? rest : undefined
}

export function toCurl(exchange: Exchange, options: CurlOptions): string {
	const { redactor } = options
	const target = redactor.url(exchange.url)
	const below = options.origin === undefined ? undefined : belowBase(target, options.origin)
	const url = below === undefined ? shellQuote(target) : `"$BASE${shellEscapeDouble(below)}"`
	const parts = [`curl -i -X ${exchange.method} ${url}`]
	for (const [key, value] of Object.entries(exchange.requestHeaders)) parts.push(headerFlag(key, value, options))
	if (exchange.requestBody !== undefined) parts.push(...curlBodyFlags(redactBody(exchange.requestBody, redactor)))
	return parts.join(" \\\n")
}

function headerFlag(key: string, value: string, { redact, redactor }: CurlOptions): string {
	const secret = redact === undefined ? redactor.isSecretHeader(key) : redact.includes(key.toLowerCase())
	if (!secret) return `  -H ${shellQuote(`${key}: ${redactor.text(value)}`)}`
	/* Preserve the scheme prefix ("Bearer ", "ApiKey ") so the variable holds only the secret and
	 * the script stays copy-pasteable. */
	const scheme = /^(\w+)\s+/.exec(value)?.[1]
	const rendered = scheme === undefined ? "$TOKEN" : `${scheme} $TOKEN`
	return `  -H "${shellEscapeDouble(key)}: ${rendered}"`
}

/** A request body with secrets removed, keeping the shape `curlBodyFlags` understands. */
function redactBody(body: unknown, redactor: Redactor): unknown {
	if (typeof body === "string") return redactor.text(body)
	if (isURLSearchParams(body)) {
		const out = new URLSearchParams()
		for (const [key, value] of body) out.append(key, isSecretJsonKey(key) ? REDACTED : redactor.text(value))
		return out
	}
	if (isFormData(body) || isFormSnapshot(body) || isRawBytes(body) || isBodyRef(body)) return body
	return redactor.json(body)
}

function curlBodyFlags(body: unknown): string[] {
	if (isFormData(body)) return formDataFlags(body)
	if (isFormSnapshot(body)) return formSnapshotFlags(body)
	/* Field by field: curl encodes each value itself. Handing it the joined string encoded the
	 * separators too, so the server received one field holding the whole form. */
	if (isURLSearchParams(body))
		return [...body].map(([key, value]) => `  --data-urlencode ${shellQuote(`${key}=${value}`)}`)
	if (typeof body === "string") return [`  -d ${shellQuote(body)}`]
	if (isRawBytes(body) || isBodyRef(body)) return [`  --data-binary @-`]
	return [`  -d ${shellQuote(JSON.stringify(body))}`]
}

function formDataFlags(body: FormData): string[] {
	return [...body.entries()].map(([name, value]) =>
		typeof value === "string"
			? `  -F ${shellQuote(`${name}=${value}`)}`
			: `  -F ${shellQuote(`${name}=@${value.name};type=${value.type || "application/octet-stream"}`)}`,
	)
}

function formSnapshotFlags(body: FormSnapshot): string[] {
	return body.parts.map((part) =>
		"value" in part
			? `  -F ${shellQuote(`${part.field}=${part.value}`)}`
			: `  -F ${shellQuote(`${part.field}=@${part.filename};type=${part.mediaType}`)}`,
	)
}

/** One shell word, whatever it holds: single-quoted, with each `'` closed, escaped and reopened. */
function shellQuote(text: string): string {
	return `'${text.replace(/'/g, `'\\''`)}'`
}

/** Escapes the characters that stay special inside double quotes. */
function shellEscapeDouble(text: string): string {
	return text.replace(/(["\\`])/g, "\\$1")
}
