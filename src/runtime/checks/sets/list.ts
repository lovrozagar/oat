import type { OperationModel } from "../../../spec/graph.ts"
import type { ReadClient } from "../../../client/client.ts"
import type { Exchange } from "../../exchange.ts"
import { fillPath } from "../../fill-path.ts"
import { idOf, type Record_ } from "../../world.ts"
import type { CheckContext } from "../core/context.ts"
import { conv, type Query } from "../query/capabilities.ts"

/**
 * Reads a pagination fact by whatever the document calls it — and from wherever it lives.
 *
 * Most APIs put these in the body. Some put them nowhere at all and publish a `Link` header
 * instead, in which case "are there more pages" is answered by the presence of `rel="next"`
 * rather than by a boolean field. Both are answers to the same question, so both are resolved
 * here and every check that asks stays unaware of the difference.
 */
export function envelopeValue(
	ctx: CheckContext,
	result: ListResult,
	role: "total" | "hasMore" | "nextCursor",
): unknown {
	const key = conv(ctx).envelope[role]
	if (key !== undefined) return result.envelope[key]

	const c = conv(ctx)
	if (c.linkHeader === undefined) return undefined
	/* The document declares a Link header, so its *absence* on a given response is meaningful:
	 * no `rel="next"` means there is no next page. Treating a missing header as "unknown" would
	 * let a backend that simply stops emitting links look untestable rather than wrong. */
	const link = linkRelations(result.exchange)
	if (role === "hasMore") return link?.has("next") ?? false
	if (role === "nextCursor") return link?.get("next") ?? null
	return undefined
}

/** Parses RFC 8288 `Link` into rel → URL, or null when the response carries no such header. */
function linkRelations(exchange: Exchange): Map<string, string> | null {
	const header = exchange.responseHeaders?.link ?? exchange.responseHeaders?.Link
	if (typeof header !== "string" || header === "") return null
	const relations = new Map<string, string>()
	for (const part of header.split(",")) {
		const match = /<([^>]+)>\s*;\s*rel\s*=\s*"?([^";]+)"?/.exec(part.trim())
		if (match?.[1] !== undefined && match[2] !== undefined) relations.set(match[2].trim(), match[1])
	}
	return relations.size === 0 ? null : relations
}

export interface ListResult {
	items: Record_[]
	envelope: Record<string, unknown>
	exchange: Exchange
}

export async function list(
	ctx: CheckContext,
	query: Query = {},
	{
		auth = ctx.auth,
		scope = ctx.scope,
		op = ctx.listOp,
	}: {
		auth?: (() => Record<string, string>) | undefined
		scope?: Record<string, string> | undefined
		op?: OperationModel | undefined
	} = {},
): Promise<ListResult> {
	const exchange = await ctx.client.get(fillPath(op.path, scope), {
		headers: auth(),
		operationId: op.operationId,
		query,
	})
	const body = exchange.responseBody
	const items = extractItems(body, op === ctx.listOp ? ctx.collectionKey : (op.collection?.key ?? null))
	return { envelope: (body ?? {}) as Record<string, unknown>, exchange, items }
}

/** The context as another entity's list operation sees it — for reading a set that is not ours. */
export function forList<C extends ReadClient>(ctx: CheckContext<C>, op: OperationModel): CheckContext<C> {
	if (op === ctx.listOp) return ctx
	const entity = ctx.model.entities.get(op.entity ?? "")
	return {
		...ctx,
		collectionKey: op.collection?.key ?? null,
		identity: entity?.identity ?? "id",
		listOp: op,
		query: op.query,
	}
}

/**
 * The records a list body holds: a bare array, or the array under the collection key. A row that
 * is not an object is no record; the response-schema checks report it, and no check reads a field
 * off it.
 */
export function extractItems(body: unknown, key: string | null): Record_[] {
	const rows = Array.isArray(body) ? body : key === null || !isObject(body) ? undefined : body[key]
	return Array.isArray(rows) ? rows.filter(isObject) : []
}

function isObject(value: unknown): value is Record_ {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function ids(records: Record_[], identity: string): string[] {
	return records.flatMap((r) => idOf(r, identity) ?? [])
}

export interface Walk {
	ids: string[]
	/** The records in the order the walk met them, repeats included. */
	items: Record_[]
	/** Every page the walk read. */
	exchanges: Exchange[]
	/** True when the walk stopped at the page cap rather than at the end of the collection. */
	truncated: boolean
}
