import type { OperationModel } from "../../../spec/graph/types.ts"
import type { ReadClient } from "../../../client/client.ts"
import type { Exchange } from "../../exchange.ts"
import { fillPath } from "../../fill-path.ts"
import { idOf, type Record_, recordsFromList, type RowsAt } from "../../world/records.ts"
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
	const header = exchange.responseHeaders?.["link"] ?? exchange.responseHeaders?.["Link"]
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

/**
 * One page of a list: the context's own, or `op`, read as `principal` (the actor by default) in
 * `scope` (the context's by default).
 */
export async function list(
	ctx: CheckContext,
	query: Query = {},
	{
		principal = ctx.actor.id,
		scope = ctx.scope,
		op = ctx.listOp,
	}: {
		principal?: string | undefined
		scope?: Record<string, string> | undefined
		op?: OperationModel | undefined
	} = {},
): Promise<ListResult> {
	const exchange = await ctx.client.get(fillPath(op.path, scope), {
		as: { principal },
		operationId: op.operationId,
		query,
	})
	const body = exchange.responseBody
	const items = recordsFromList(body, op === ctx.listOp ? rowsAt(ctx) : op.collection)
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

/** Where the context's own list keeps its records: under its collection key, each read at `within`. */
export function rowsAt(ctx: CheckContext): RowsAt {
	return { key: ctx.collectionKey, within: ctx.listOp.collection?.within ?? [] }
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
