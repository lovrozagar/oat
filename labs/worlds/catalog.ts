import type { Entity, Field, World } from "../kit/types.ts"

const NAME: Field = {
	filterable: true,
	maxLength: 128,
	name: "name",
	required: true,
	searchable: true,
	sortable: true,
	type: "string",
}
const STATUS: Field = {
	enum: ["active", "draft", "archived"],
	filterable: true,
	name: "status",
	sortable: true,
	type: "string",
}
const POSITION: Field = { filterable: true, name: "position", sortable: true, type: "integer" }
const NOTE: Field = { maxLength: 256, name: "note", nullable: true, searchable: true, type: "string" }
/** Two values so filter composition can pick a proper subset. */
const KIND: Field = {
	enum: ["red", "blue"],
	filterable: true,
	name: "kind",
	required: true,
	sortable: true,
	type: "string",
}

export function resource(name: string, plural: string, extra: Partial<Entity> = {}): Entity {
	return {
		identity: "id",
		name,
		plural,
		...extra,
		fields: extra.fields ?? [NAME, STATUS, POSITION, NOTE, KIND],
	}
}

export const TINY: World = {
	entities: [
		resource("article", "articles", {
			fields: [
				{
					filterable: true,
					maxLength: 128,
					name: "title",
					required: true,
					searchable: true,
					sortable: true,
					type: "string",
				},
				{ filterable: true, maxLength: 64, name: "slug", nullable: true, searchable: true, sortable: true, type: "string" },
				{ enum: ["draft", "published", "archived"], filterable: true, name: "status", sortable: true, type: "string" },
				{ maxLength: 2000, name: "body", nullable: true, searchable: true, type: "string" },
				POSITION,
				KIND,
			],
			invite: true,
			softDelete: true,
		}),
	],
	id: "tiny",
	title: "labs/tiny — one collection",
}

export const SHOP: World = {
	entities: [
		resource("store", "stores", {
			derived: [
				{ from: "product", name: "product_count", op: "count" },
				{ from: "order", name: "order_count", op: "count" },
			],
			invite: true,
			softDelete: true,
		}),
		resource("product", "products", {
			derived: [{ from: "review", name: "review_count", op: "count" }],
			fields: [
				NAME,
				STATUS,
				{ filterable: true, name: "price", sortable: true, type: "number" },
				POSITION,
				NOTE,
				KIND,
			],
			parent: "store",
		}),
		resource("customer", "customers", {
			fields: [
				NAME,
				{ filterable: true, maxLength: 128, name: "email", searchable: true, sortable: true, type: "string" },
				STATUS,
				NOTE,
				KIND,
			],
		}),
		resource("order", "orders", {
			fields: [
				NAME,
				{ enum: ["open", "paid", "shipped"], filterable: true, name: "status", sortable: true, type: "string" },
				{ filterable: true, name: "total", sortable: true, type: "number" },
				NOTE,
				KIND,
			],
			parent: "store",
		}),
		resource("review", "reviews", {
			fields: [
				NAME,
				{ filterable: true, name: "rating", sortable: true, type: "integer" },
				NOTE,
				KIND,
			],
			parent: "product",
		}),
	],
	id: "shop",
	title: "labs/shop — store, product, order, review",
}

export const CAMPUS: World = {
	entities: [
		resource("campus", "campuses", {
			derived: [
				{ from: "building", name: "building_count", op: "count" },
				{ from: "ticket", name: "ticket_count", op: "count" },
				{ from: "course", name: "course_count", op: "count" },
			],
			invite: true,
		}),
		resource("building", "buildings", {
			derived: [{ from: "room", name: "room_count", op: "count" }],
			parent: "campus",
		}),
		resource("room", "rooms", {
			derived: [{ from: "booking", name: "booking_count", op: "count" }],
			parent: "building",
		}),
		resource("staff", "staff"),
		resource("booking", "bookings", { parent: "room" }),
		resource("ticket", "tickets", { parent: "campus", softDelete: true }),
		resource("equipment", "equipment", { parent: "building" }),
		resource("announcement", "announcements", { parent: "campus" }),
		resource("course", "courses", {
			derived: [{ from: "enrollment", name: "enrollment_count", op: "count" }],
			parent: "campus",
		}),
		resource("enrollment", "enrollments", { parent: "course" }),
	],
	id: "campus",
	title: "labs/campus — ten nested campus resources",
}

export const PLATFORM: World = {
	entities: [
		resource("workspace", "workspaces", {
			derived: [
				{ from: "project", name: "project_count", op: "count" },
				{ from: "webhook", name: "webhook_count", op: "count" },
				{ from: "member", name: "member_count", op: "count" },
			],
			invite: true,
			softDelete: true,
		}),
		resource("project", "projects", {
			derived: [
				{ from: "board", name: "board_count", op: "count" },
				{ from: "issue", name: "issue_count", op: "count" },
				{ from: "doc", name: "doc_count", op: "count" },
			],
			parent: "workspace",
		}),
		resource("board", "boards", {
			derived: [{ from: "card", name: "card_count", op: "count" }],
			parent: "project",
		}),
		resource("card", "cards", {
			derived: [
				{ from: "comment", name: "comment_count", op: "count" },
				{ from: "attachment", name: "attachment_count", op: "count" },
			],
			parent: "board",
		}),
		resource("comment", "comments", { parent: "card" }),
		resource("label", "labels", { parent: "project" }),
		resource("attachment", "attachments", { parent: "card" }),
		resource("webhook", "webhooks", { parent: "workspace" }),
		resource("member", "members", { parent: "workspace" }),
		resource("sprint", "sprints", { parent: "project" }),
		resource("issue", "issues", {
			derived: [{ from: "review", name: "review_count", op: "count" }],
			parent: "project",
		}),
		resource("doc", "docs", { parent: "project" }),
		resource("review", "reviews", { parent: "issue" }),
		resource("environment", "environments", {
			derived: [{ from: "deployment", name: "deployment_count", op: "count" }],
			parent: "project",
		}),
		resource("deployment", "deployments", { parent: "environment" }),
		resource("flag", "flags", { parent: "project" }),
		resource("secret", "secrets", { parent: "environment" }),
		resource("metric", "metrics", { parent: "project" }),
		resource("audit", "audits", { parent: "workspace" }),
		resource("inbox", "inboxes", { parent: "workspace" }),
	],
	id: "platform",
	title: "labs/platform — twenty workspace resources",
}

/** 20 parents × 9 children = 200 entities. Names singularise by dropping a final `s`. */
export function hugeWorld(size = 200, id = "huge"): World {
	const roots = 20
	const children = Math.max(0, Math.floor((size - roots) / roots))
	/* D1 rejects ~100+ columns. A count per child on vast (99 children) overflows; keep a
	 * bounded set so invalidate still has a derived field to watch. */
	const derivedCap = 16
	const entities: Entity[] = []
	for (let r = 0; r < roots; r++) {
		const parent = `r${String(r).padStart(2, "0")}`
		const derived: Entity["derived"] = []
		for (let c = 0; c < children; c++) {
			if (c < derivedCap) {
				derived.push({ from: `${parent}c${c}`, name: `${parent}c${c}_count`, op: "count" })
			}
		}
		entities.push(resource(parent, `${parent}s`, { derived, softDelete: r === 0 }))
		for (let c = 0; c < children; c++) {
			const name = `${parent}c${c}`
			entities.push(resource(name, `${name}s`, { parent }))
		}
	}
	return {
		entities,
		id,
		title: `labs/${id} — ${entities.length} generated resources`,
	}
}

export const HUGE: World = hugeWorld(200, "huge")
export const VAST: World = hugeWorld(2000, "vast")

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
export const BUG_FILTERLEAK: World = pair("bug-filterleak", "filter drops the tenant predicate", ["filter-bypass-tenant"])
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
export const BUG_REVOKE: World = withStore(
	pair("bug-revoke", "revoke leaves the grant in place", ["revoke-noop"]),
	{ invite: true },
)
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
