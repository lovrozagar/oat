/** A collection's listing, in the dialect's spelling, with the defects that live above storage. */

import { toCanonicalFilter } from "../../dialect/canonical.ts"
import type { ListingRequest } from "../../listing/types.ts"
import { runListing } from "../../listing/run.ts"
import { fieldsWhere } from "../../model/fields.ts"
import type { EntityDef } from "../../model/types.ts"
import { type Row, SqlError } from "../../store-api.ts"
import { equalityFilter, paginated, selectParam, staleWindow, toCanonicalOrder } from "../listing-query.ts"
import { fieldList, present, shown, skewForList, snapshotKey, wraps } from "../records.ts"
import type { ReferenceState } from "../state.ts"
import { type Json, type ReferenceRequest, type ReferenceResponse, respond } from "../wire.ts"
import type { EntityCall } from "./entity.ts"

export async function list(
	state: ReferenceState,
	request: ReferenceRequest,
	call: EntityCall,
): Promise<ReferenceResponse> {
	const { entity } = call
	const { defects } = state
	if (defects.has("RATE_LIMIT_STRICTER_THAN_DECLARED") && !state.throttled.has(entity.name)) {
		state.throttled.add(entity.name)
		return respond(429, { error: "rate limited" }, { "retry-after": "0" })
	}
	const stale = staleListing(state, request.url, call)
	if (stale !== undefined) return stale
	const result = await runListing(state.listingStore, {
		entity,
		request: listingRequest(state, request.url, call),
		options: {
			clampLimit: state.shape.clampLimit,
			conventions: state.conventions,
			/* A row embeds the table it belongs to: `select=id,table(name)`. */
			embed: (relation, row) => embedded(state, call, { relation, row }),
			scope: { ...call.scope, project_id: call.principal.projectId },
			/* Applied to the collection only — the item route never passes through here — so a
			 * skewed field makes the two projections disagree exactly as a stale denormalised
			 * listing does. */
			transform: (record) => shown(state, entity, skewForList(defects, record)),
		},
		defects,
	})
	/* An unknown parameter read as a filter nothing matches. */
	const served =
		defects.has("UNKNOWN_PARAM_EMPTIES_LIST") && unknownGiven(state, request.url, call)
			? { ...result, count: 0, hasMore: false, items: [], nextCursor: null }
			: result
	const listing = paginated({ dialect: state.dialect, entity, url: request.url }, served)
	return respond(200, shaped(state, entity, listing.body), listing.headers)
}

/*
 * A listing's envelope as the shape answers it: under `recordEnvelope` the rows travel beside a
 * second array of objects, and under `wrappedRows` each row wraps its record. A root array, which
 * no document could point inside, stays as it is.
 */
function shaped(state: ReferenceState, entity: EntityDef, body: Json | Row[]): Json | Row[] {
	if (Array.isArray(body)) return body
	const key = state.dialect.envelope?.collection ?? entity.plural
	const rows = body[key] as Row[]
	return {
		...body,
		...(state.shape.wrappedRows === true ? { [key]: rows.map((row) => ({ document: row, highlights: [] })) } : {}),
		...(wraps(state, entity) ? { fields: fieldList(entity) } : {}),
	}
}

/*
 * Under STALE_LIST, the default listing replays the snapshot taken before the first write. Only
 * the default listing: freezing filtered queries too would also swallow filter validation, so the
 * defect would masquerade as several unrelated ones. The stale rows are still paged as asked — the
 * lie is what the listing holds, not how it pages — and paging values the live path would refuse
 * go there to be refused.
 */
function staleListing(state: ReferenceState, url: URL, call: EntityCall): ReferenceResponse | undefined {
	const { dialect } = state
	const plain = [...url.searchParams.keys()].every(
		(k) => k === dialect.params.limit || k === dialect.params.page || k === dialect.params.offset,
	)
	const window = plain ? staleWindow(url, dialect, call.entity) : null
	const frozen = state.staleSnapshot.get(snapshotKey(call.entity, call.scope))
	if (!state.defects.has("STALE_LIST") || window === null || frozen === undefined) return undefined
	const items = frozen.slice(window.offset, window.offset + window.limit).map((row) => shown(state, call.entity, row))
	const page = paginated(
		{ dialect, entity: call.entity, url },
		{
			count: frozen.length,
			hasMore: window.offset + items.length < frozen.length,
			items,
			limit: window.limit,
			nextCursor: null,
			offset: window.offset,
			page: window.page,
		},
	)
	return respond(200, shaped(state, call.entity, page.body), page.headers)
}

function listingRequest(state: ReferenceState, url: URL, call: EntityCall): ListingRequest {
	const { dialect } = state
	const param = (name: string | undefined): string | undefined =>
		name === undefined ? undefined : (url.searchParams.get(name) ?? undefined)
	/* A repeated grammar sends one key per parameter: read them all, in order. */
	const order =
		dialect.sortTemplate?.join === "repeat"
			? url.searchParams.getAll(dialect.params.order).join(",") || undefined
			: param(dialect.params.order)
	return {
		cursor: param(dialect.params.cursor),
		filter: filterOf(state, url, call),
		limit: param(dialect.params.limit),
		offset: param(dialect.params.offset),
		order: toCanonicalOrder(order, dialect),
		page: param(dialect.params.page),
		q: param(dialect.params.search),
		searchMode: param(dialect.params.searchMode),
		select: param(selectParam(dialect, call.entity)),
	}
}

/* The filter in its canonical form. A template grammar repeats its parameter, one term each. */
function filterOf(state: ReferenceState, url: URL, call: EntityCall): string | undefined {
	const { dialect } = state
	const raw =
		dialect.grammar === "equality"
			? equalityFilter(url, call.entity)
			: dialect.grammar === "template"
				? url.searchParams.getAll(dialect.params.filter)
				: url.searchParams.get(dialect.params.filter)
	if (raw === null || raw.length === 0) return undefined
	const canonical = toCanonicalFilter(raw, dialect)
	if (canonical !== null) return canonical
	if (!state.defects.has("IGNORES_MALFORMED_FILTER")) {
		throw new SqlError("invalid_filter", `malformed filter: ${String(raw)}`)
	}
	return undefined
}

async function embedded(
	state: ReferenceState,
	call: EntityCall,
	{ relation, row }: { relation: string; row: Row },
): Promise<Row | null> {
	const declared = call.entity.relations?.[relation]
	const target = state.entities.find((candidate) => candidate.name === declared?.entity)
	const link = declared === undefined ? undefined : row[declared.via]
	if (target === undefined || (typeof link !== "string" && typeof link !== "number")) return null
	const related = await state.store.byId(target, link)
	return related === null ? null : present(state, target, related)
}

function unknownGiven(state: ReferenceState, url: URL, call: EntityCall): boolean {
	const { dialect } = state
	const known = new Set<string>([
		...Object.values(dialect.params).filter((value): value is string => typeof value === "string"),
		dialect.selectGrammar === "bracketed" ? selectParam(dialect, call.entity) : "",
		...(dialect.grammar === "equality" ? fieldsWhere(call.entity, "filterable") : []),
	])
	return [...url.searchParams.keys()].some((key) => !known.has(key))
}
