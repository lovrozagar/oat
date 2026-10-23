/**
 * What an operation's parameters promise a request: the values its required parameters declare, how
 * each is written, and an idempotency key.
 */

import { CREDENTIAL_HEADERS } from "../../security/credential-names.ts"
import type { OperationObject, ParameterObject } from "../types.ts"

/** Where a parameter goes. */
export type ParamIn = ParameterObject["in"]

/** How the document says to write a parameter: its OAS `style`, `explode` and `allowReserved`. */
export interface ParamStyle {
	style?: string
	explode?: boolean
	allowReserved?: boolean
}

/** Each parameter's non-default style, by location and name. */
export type ParamStyles = Partial<Record<ParamIn, Record<string, ParamStyle>>>

/** The value a parameter's document gives it: an example first, then a const, enum, or default. */
function declaredValue(param: ParameterObject): unknown {
	const schema = param.schema ?? {}
	const named = param["examples"]
	const fromNamed =
		named !== null && typeof named === "object"
			? Object.values(named as Record<string, { value?: unknown }>).find((entry) => entry?.value !== undefined)?.value
			: undefined
	const listed = Array.isArray(schema["examples"]) ? (schema["examples"] as unknown[])[0] : undefined
	const enumerated = Array.isArray(schema["enum"]) ? (schema["enum"] as unknown[])[0] : undefined
	return [param["example"], fromNamed, listed, schema["example"], schema["const"], enumerated, schema["default"]].find(
		(candidate) => candidate !== undefined && candidate !== null,
	)
}

/* Required parameters in one location and the value the document declares for each, kept whole. */
function readRequired(parameters: readonly ParameterObject[], where: ParamIn): Record<string, unknown> {
	const out: Record<string, unknown> = {}
	for (const param of parameters) {
		if (param.in !== where || param.required !== true) continue
		const value = declaredValue(param)
		if (value !== undefined) out[param.name] = value
	}
	return out
}

/**
 * Required query parameters and the value the document declares for each; an object or array is
 * kept whole for its style to write. A parameter with no declared value is left to the caller,
 * never invented.
 */
export function readRequiredQuery(parameters: readonly ParameterObject[]): Record<string, unknown> {
	return readRequired(parameters, "query")
}

/* OAS 3.1 §4.8.12: a header parameter named Accept, Content-Type or Authorization is ignored. A
 * credential header is the operation's security to send, never a parameter's example. */
const IGNORED_HEADERS: ReadonlySet<string> = /* @__PURE__ */ new Set(["accept", "content-type", ...CREDENTIAL_HEADERS])

/**
 * Required header parameters and their declared values. Never the idempotency key, which the run
 * mints per request, nor a header OAS ignores or a credential carries.
 */
export function readRequiredHeaders(op: OperationObject): Record<string, unknown> {
	const key = idempotencyHeader(op)
	const all = readRequired(op.parameters ?? [], "header")
	return Object.fromEntries(
		Object.entries(all).filter(([name]) => name !== key && !IGNORED_HEADERS.has(name.toLowerCase())),
	)
}

/** Required cookie parameters and their declared values. */
export function readRequiredCookies(parameters: readonly ParameterObject[]): Record<string, unknown> {
	return readRequired(parameters, "cookie")
}

/* What OAS writes a parameter as when it says nothing: form exploded in query and cookie, else simple. */
const defaultStyle = (where: ParamIn): string => (where === "query" || where === "cookie" ? "form" : "simple")

/* The parts of `param`'s declared style that differ from its location's default, or null when none do. */
function styleOf(param: ParameterObject): ParamStyle | null {
	const out: ParamStyle = {}
	const declared = typeof param["style"] === "string" ? param["style"] : undefined
	const style = declared ?? defaultStyle(param.in)
	if (style !== defaultStyle(param.in)) out.style = style
	const explode = param["explode"]
	if (typeof explode === "boolean" && explode !== (style === "form")) out.explode = explode
	if (param["allowReserved"] === true) out.allowReserved = true
	return Object.keys(out).length === 0 ? null : out
}

/** Each parameter's style, explode and allowReserved where they differ from the OAS default. */
export function readParamStyles(parameters: readonly ParameterObject[]): ParamStyles {
	const out: ParamStyles = {}
	for (const param of parameters) {
		const style = styleOf(param)
		if (style !== null) (out[param.in] ??= {})[param.name] = style
	}
	return out
}

/**
 * The required query, header and cookie parameters a request cannot carry: the document declares no
 * value for them, and the run supplies none itself (the idempotency key, a credential, a header OAS
 * ignores). An operation with one cannot be sent whole, so its answer judges the request.
 */
export function unfilledRequired(op: OperationObject): string[] {
	const parameters = op.parameters ?? []
	const declared: Record<Exclude<ParamIn, "path">, Record<string, unknown>> = {
		cookie: readRequiredCookies(parameters),
		header: readRequiredHeaders(op),
		query: readRequiredQuery(parameters),
	}
	const key = idempotencyHeader(op)
	const supplied = (name: string): boolean => name === key || IGNORED_HEADERS.has(name.toLowerCase())
	return parameters
		.filter(
			(param): param is ParameterObject & { in: Exclude<ParamIn, "path"> } =>
				param.required === true && param.in !== "path",
		)
		.filter(({ in: where, name }) => !Object.hasOwn(declared[where], name) && !(where === "header" && supplied(name)))
		.map(({ name }) => name)
}

/** The header parameter `op` accepts as an idempotency key, when it declares one. */
export function idempotencyHeader(op: OperationObject): string | null {
	return (
		(op.parameters ?? []).find(
			(p) => p.in === "header" && /^(x-)?idempotenc(y|e)([-_]?key)?$/i.test(p.name.replace(/\s/g, "")),
		)?.name ?? null
	)
}

/**
 * Header names the operation's success response declares.
 *
 * Pagination facts do not always live in the body — `Link` is the obvious case — so a header the
 * document publishes is part of the response contract and has to be read as such.
 */
export function successResponseHeaders(op: OperationObject): string[] {
	const responses = (op.responses ?? {}) as Record<string, { headers?: Record<string, unknown> }>
	const names = new Set<string>()
	for (const [status, response] of Object.entries(responses)) {
		if (!/^2\d\d$/.test(status)) continue
		for (const name of Object.keys(response?.headers ?? {})) names.add(name)
	}
	return [...names]
}
