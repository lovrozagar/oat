/*
 * A probe body nothing can be delivered to: a broken API that applies it anyway must not mail a real
 * inbox or call a real webhook. Every email-format value becomes an identity no account holds, at RFC
 * 2606's `.invalid` domain (`nonexistentIdentity`), and every URL-format value a URL on an `.invalid`
 * host, which never resolves. Only a string is replaced: a value of another type stays as it is.
 */

import { nonexistentIdentity } from "../../../nonexistent-identity.ts"

const EMAIL: ReadonlySet<string> = /* @__PURE__ */ new Set(["email", "idn-email"])
const URL_FORMATS: ReadonlySet<string> = /* @__PURE__ */ new Set([
	"uri",
	"url",
	"iri",
	"uri-reference",
	"iri-reference",
])

type Schema = Record<string, unknown>

/** `value` with every address its `schema` declares, at any depth, replaced by one that reaches nothing. */
export function undeliverable(value: unknown, schema: unknown, nonce: string): unknown {
	if (schema === null || typeof schema !== "object") return value
	const node = schema as Schema
	if (typeof value === "string") return addressed(value, node, nonce)
	if (Array.isArray(value)) return value.map((item) => undeliverable(item, node.items, nonce))
	const properties = node.properties
	if (value === null || typeof value !== "object" || properties === null || typeof properties !== "object") return value
	return Object.fromEntries(
		Object.entries(value).map(([name, item]) => [
			name,
			undeliverable(item, (properties as Record<string, unknown>)[name], nonce),
		]),
	)
}

/* A string as its format would have it delivered to nowhere. */
function addressed(value: string, schema: Schema, nonce: string): string {
	const format = typeof schema.format === "string" ? schema.format : ""
	if (EMAIL.has(format)) return nonexistentIdentity({ name: "email", schema }, nonce)
	return URL_FORMATS.has(format) ? `https://oat-nonexistent-${nonce}.invalid/` : value
}
