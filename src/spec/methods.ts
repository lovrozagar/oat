/**
 * The HTTP methods a document can declare, and every set oat reads them by. A list of methods
 * written anywhere else drifts: one module once missed QUERY, another counted OPTIONS as a write.
 */

/** The operation fields of an OAS 3.2 Path Item, in the order the specification lists them. */
export const PATH_ITEM_METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace", "query"] as const

/** A method as a path item names it. */
export type HttpMethod = (typeof PATH_ITEM_METHODS)[number]

/** RFC 9110 §9.2.1, with QUERY (the safe method with a body): asking changes nothing on the server. */
export const SAFE_METHODS = ["GET", "HEAD", "OPTIONS", "TRACE", "QUERY"] as const

/** A method that cannot change server state. */
export type SafeMethod = (typeof SAFE_METHODS)[number]

export const SAFE: ReadonlySet<string> = /* @__PURE__ */ new Set<string>(SAFE_METHODS)

/** RFC 9110 §9.2.2: sending one twice does what sending it once does. */
export const IDEMPOTENT: ReadonlySet<string> = /* @__PURE__ */ new Set([...SAFE_METHODS, "PUT", "DELETE"])

/** Every declarable method that is not safe: what may change state. */
export const MUTATING: ReadonlySet<string> = /* @__PURE__ */ new Set(
	/* @__PURE__ */ PATH_ITEM_METHODS.map((method) => method.toUpperCase()).filter((method) => !SAFE.has(method)),
)

/** The safe method that carries its question in a body. */
export const BODY_READS: ReadonlySet<string> = /* @__PURE__ */ new Set(["QUERY"])

/**
 * Methods that read the target's representation. OPTIONS asks what the target supports and TRACE
 * echoes the request, so neither shows a record's state.
 */
export const READS: ReadonlySet<string> = /* @__PURE__ */ new Set(
	/* @__PURE__ */ SAFE_METHODS.filter((method) => method !== "OPTIONS" && method !== "TRACE"),
)

/** The reads with no body: one may be sent again as it was, since there is no body stream to replay. */
export const BODILESS_READS: ReadonlySet<string> = /* @__PURE__ */ new Set(
	/* @__PURE__ */ [...READS].filter((method) => !BODY_READS.has(method)),
)

/** Methods oat lists but never sends, with the reason. */
export const UNSENDABLE: ReadonlyMap<string, string> = /* @__PURE__ */ new Map([
	["TRACE", "fetch refuses TRACE (a cross-site tracing guard), so oat lists the operation but never sends it"],
])

/** Why `method` is never sent, or `null` when it can be. */
export function unsendableReason(method: string): string | null {
	return UNSENDABLE.get(method.toUpperCase()) ?? null
}
