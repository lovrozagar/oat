import type { Entity, Field, World } from "../kit/types.ts"
import { CAMPUS, HUGE, KIND, NAME, NOTE, PLATFORM, POSITION, resource, SHOP, STATUS, TINY, VAST } from "./base.ts"

export { CAMPUS, HUGE, hugeWorld, PLATFORM, resource, SHOP, TINY, VAST } from "./base.ts"

function pair(id: string, title: string, defects: World["defects"] = []): World {
	const tightLimit = id.includes("page") || id.includes("maxlimit")
	return {
		defects,
		entities: [
			resource("store", "stores", {
				derived: [{ from: "product", name: "product_count", op: "count" }],
				fields: [NAME, STATUS, POSITION, NOTE, KIND],
				maxLimit: tightLimit ? 3 : 100,
			}),
			resource("product", "products", {
				fields: [NAME, STATUS, POSITION, NOTE, KIND],
				maxLimit: tightLimit ? 3 : 100,
				parent: "store",
			}),
		],
		id,
		title,
	}
}

const JOB_STATUS: Field = {
	enum: ["pending", "running", "complete", "failed"],
	filterable: true,
	name: "status",
	sortable: true,
	type: "string",
}

function jobsWorld(id: string, title: string, defects: World["defects"] = []): World {
	return {
		defects,
		entities: [
			resource("job", "jobs", { fields: [NAME, JOB_STATUS, NOTE, KIND] }),
			resource("artifact", "artifacts", { fields: [NAME, STATUS, NOTE, KIND] }),
		],
		id,
		jobs: true,
		title,
	}
}

function withStore(world: World, extra: Partial<Entity>): World {
	return {
		...world,
		entities: world.entities.map((entity) => (entity.name === "store" ? { ...entity, ...extra } : entity)),
	}
}

/** Correct parent/child with a 2-value enum so composition has a proper subset. */
export const OK_PAIR: World = pair("ok-pair", "correct store+product")
/** Child create does not bump store.product_count. */
export const BUG_STALE: World = pair("bug-stale", "stale parent counter", ["stale-parent"])
/** Filters parse and 400, then are ignored. */
export const BUG_NOFILTER: World = pair("bug-nofilter", "filter ignored", ["drop-filter"])
/** Item GET is global by id. */
export const BUG_LEAK: World = pair("bug-leak", "item GET ignores tenant", ["ignore-tenant-get"])
/** Spec lists `ghost` as filterable; the handler rejects it. */
export const BUG_OVERCLAIM: World = pair("bug-overclaim", "spec overclaims filterable", ["overclaim-filter"])
/** Page first, then filter the page. */
export const BUG_PAGEFILTER: World = pair("bug-pagefilter", "filter after pagination", ["filter-after-page"])
/** List advertises nextCursor and ignores it. */
export const BUG_CURSOR: World = pair("bug-cursor", "cursor advertised but ignored", ["ignore-cursor"])
/** PATCH writes the whole row, so concurrent field edits clobber each other. */
export const BUG_LOSTUPDATE: World = pair("bug-lostupdate", "full-row PATCH loses updates", ["clobber-patch"])
/** Invite accept is a no-op. */
export const BUG_INVITE: World = {
	...pair("bug-invite", "invite accept does nothing", ["invite-noop"]),
	entities: pair("bug-invite", "invite accept does nothing", ["invite-noop"]).entities.map((entity) =>
		entity.name === "store" ? { ...entity, invite: true } : entity,
	),
}
/** Same API, classic parameter names. */
export const OK_CLASSIC: World = {
	...pair("ok-classic", "correct, sort/fields/per_page"),
	queryNames: { filter: "filter", limit: "per_page", order: "sort", search: "search", select: "fields" },
}

export const BUG_TOMBSTONE: World = withStore(
	pair("bug-tombstone", "soft-deleted rows stay in the list", ["list-tombstone"]),
	{ softDelete: true },
)
export const BUG_RANK: World = pair("bug-rank", "viewer can read a record member cannot", ["invert-rank"])
export const BUG_FILTERLEAK: World = pair("bug-filterleak", "filter drops the tenant predicate", [
	"filter-bypass-tenant",
])
export const BUG_HASMORE: World = pair("bug-hasmore", "hasMore is always false", ["lie-has-more"])
export const BUG_MAXLIMIT: World = pair("bug-maxlimit", "documented maxLimit is not enforced", ["ignore-max-limit"])
export const BUG_SEARCH: World = pair("bug-search", "search term is ignored", ["drop-search"])
export const BUG_SELECT: World = pair("bug-select", "select projection is ignored", ["drop-select"])
export const BUG_SORT: World = pair("bug-sort", "order is accepted and ignored", ["drop-sort"])
export const BUG_IDEM: World = pair("bug-idem", "Idempotency-Key is ignored", ["drop-idempotency"])
export const BUG_IMMUTABLE: World = pair("bug-immutable", "x-immutable fields accept writes", ["accept-immutable"])
export const BUG_ENUM: World = pair("bug-enum", "enum is not enforced", ["skip-enum"])
export const BUG_MAXLEN: World = pair("bug-maxlen", "maxLength is not enforced", ["skip-max-length"])
export const BUG_REQUIRED: World = pair("bug-required", "required fields are not enforced", ["skip-required"])
export const BUG_REVOKE: World = withStore(pair("bug-revoke", "revoke leaves the grant in place", ["revoke-noop"]), {
	invite: true,
})
export const BUG_OFFSET: World = pair("bug-offset", "page/offset is ignored", ["ignore-page"])
export const BUG_ORACLE: World = pair("bug-oracle", "denial status reveals existence", ["oracle-status"])
export const BUG_LIKE: World = pair("bug-like", "LIKE metacharacters are not escaped", ["unescape-like"])
export const OK_JOBS: World = jobsWorld("ok-jobs", "correct async job + declared effect")
export const BUG_ASYNC: World = jobsWorld("bug-async", "job never leaves pending", ["async-stall"])
export const BUG_EFFECT: World = jobsWorld("bug-effect", "declared artifact create does not happen", ["effect-noop"])
export const BUG_OVERSORT: World = pair("bug-oversort", "spec overclaims sortable", ["overclaim-sort"])
export const BUG_OVERSELECT: World = pair("bug-overselect", "spec overclaims selectable", ["overclaim-select"])
export const BUG_RECEIPT: World = jobsWorld("bug-receipt", "job receipt omits the job id", ["omit-receipt-id"])
export const BUG_COUNT: World = pair("bug-count", "list count is always zero", ["lie-count"])
export const BUG_WIDEN: World = pair("bug-widen", "PATCH writes a field the body did not send", ["widen-patch"])
export const BUG_UNKNOWN: World = pair("bug-unknown", "unknown filter field is ignored", ["accept-unknown-filter"])
export const BUG_NEQ: World = pair("bug-neq", "neq is treated as a no-op", ["ignore-neq"])
export const BUG_AND: World = pair("bug-and", "and() is compiled as OR", ["and-as-or"])
export const BUG_OR: World = pair("bug-or", "or() is compiled as AND", ["or-as-and"])
export const BUG_NUMERIC: World = pair("bug-numeric", "numeric compare is lexical", ["text-compare"])
export const BUG_LIMIT: World = pair("bug-limit", "limit does not bound the page", ["ignore-limit"])
export const BUG_DROPFIELD: World = pair("bug-dropfield", "create drops the submitted note", ["drop-create-field"])
export const BUG_STATUS: World = pair("bug-status", "create returns 200 instead of 201", ["create-200"])
export const BUG_DEL404: World = pair("bug-del404", "DELETE of a missing id reports success", ["delete-missing-ok"])
export const BUG_CTYPE: World = pair("bug-ctype", "text/plain is accepted on JSON create", ["skip-content-type"])
export const BUG_500: World = pair("bug-500", "malformed filter returns 500", ["filter-500"])
export const BUG_ERRSCHEMA: World = pair("bug-errschema", "error body omits error_key", ["wrong-error-shape"])

export const WORLDS: Record<string, World> = {
	"bug-500": BUG_500,
	"bug-and": BUG_AND,
	"bug-async": BUG_ASYNC,
	"bug-count": BUG_COUNT,
	"bug-ctype": BUG_CTYPE,
	"bug-cursor": BUG_CURSOR,
	"bug-del404": BUG_DEL404,
	"bug-dropfield": BUG_DROPFIELD,
	"bug-effect": BUG_EFFECT,
	"bug-enum": BUG_ENUM,
	"bug-errschema": BUG_ERRSCHEMA,
	"bug-filterleak": BUG_FILTERLEAK,
	"bug-hasmore": BUG_HASMORE,
	"bug-idem": BUG_IDEM,
	"bug-immutable": BUG_IMMUTABLE,
	"bug-invite": BUG_INVITE,
	"bug-leak": BUG_LEAK,
	"bug-like": BUG_LIKE,
	"bug-limit": BUG_LIMIT,
	"bug-lostupdate": BUG_LOSTUPDATE,
	"bug-maxlen": BUG_MAXLEN,
	"bug-maxlimit": BUG_MAXLIMIT,
	"bug-neq": BUG_NEQ,
	"bug-nofilter": BUG_NOFILTER,
	"bug-numeric": BUG_NUMERIC,
	"bug-offset": BUG_OFFSET,
	"bug-or": BUG_OR,
	"bug-oracle": BUG_ORACLE,
	"bug-overclaim": BUG_OVERCLAIM,
	"bug-overselect": BUG_OVERSELECT,
	"bug-oversort": BUG_OVERSORT,
	"bug-pagefilter": BUG_PAGEFILTER,
	"bug-rank": BUG_RANK,
	"bug-receipt": BUG_RECEIPT,
	"bug-required": BUG_REQUIRED,
	"bug-revoke": BUG_REVOKE,
	"bug-search": BUG_SEARCH,
	"bug-select": BUG_SELECT,
	"bug-sort": BUG_SORT,
	"bug-stale": BUG_STALE,
	"bug-status": BUG_STATUS,
	"bug-tombstone": BUG_TOMBSTONE,
	"bug-unknown": BUG_UNKNOWN,
	"bug-widen": BUG_WIDEN,
	"ok-classic": OK_CLASSIC,
	"ok-jobs": OK_JOBS,
	"ok-pair": OK_PAIR,
	campus: CAMPUS,
	huge: HUGE,
	platform: PLATFORM,
	shop: SHOP,
	tiny: TINY,
	vast: VAST,
}
