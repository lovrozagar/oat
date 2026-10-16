/**
 * Correct API shapes the reference backend can be served in.
 *
 * Every dialect in `dialect.ts` is an API oat was written against. A shape is the opposite: a
 * choice a correct backend is entitled to make that oat was *not* written against — pages without
 * a more-pages flag, UUID identifiers, a mount under a path prefix, PUT instead of PATCH. Each is
 * a server option rather than a proxy, so the backend stays correct by construction and the only
 * thing that can produce a finding is an assumption oat made.
 *
 * The conformance suite runs the clean baseline behind each shape and requires zero findings.
 * Shapes oat does not handle yet are listed in `expected-failures.ts`, which may only shrink.
 */

import type { Dialect } from "./dialect.ts"
import type { QueryConventions } from "./query.ts"

export interface ReferenceShape {
	/** Pagination model, layered over the dialect. */
	pagination?: "page-total" | "cursor-only" | "offset-total"
	/** A page-size ceiling the server applies without documenting it. */
	clampLimit?: number
	/** Records already in the collection before oat arrives, per tenant. */
	prepopulate?: number
	/** Identifier format, with malformed path identifiers rejected as 400. */
	ids?: "uuid" | "integer"
	conventions?: Partial<QueryConventions>
	/** Every route is served under this prefix; the base URL includes it. */
	basePath?: string
	/** The update operation's method. PUT replaces the writable fields wholesale. */
	updateMethod?: "PATCH" | "PUT"
	/** A `writeOnly` secret accepted on create and never returned. */
	writeOnlyField?: boolean
	/** Create accepts `application/x-www-form-urlencoded` only. */
	formCreate?: boolean
	/** Required date-time, a bounded number, a `const`, and one component schema used twice. */
	richSchema?: boolean
	/** Each record carries a large generated field, so one page exceeds 256 KiB. */
	largeRecords?: boolean
	/** Responses documented as `2XX` and `default` rather than exact codes. */
	rangeStatuses?: boolean
	/** `components` before `paths`, path-level `parameters`, and a recursive schema. */
	specLayout?: boolean
	/** The table's identity is an integer the client chooses on create, within these bounds. */
	clientIds?: { min: number; max: number }
	/** The table's create answers `{ success: true }` instead of the record it made. */
	ackCreate?: boolean
	/** Each record's identity is a field of this name (`ID`) instead of `id`. */
	identityField?: string
	/**
	 * Single records travel wrapped: a create answers `{ success, id, message, data }`, a read
	 * `{ data, fields }`, an update or a delete `{ success, id, message }` with no record at all,
	 * and a listing carries a `fields` sidecar beside its rows. The document says where the
	 * record is (`x-entity.recordPath`) and where a create's id is (`createdIdFrom`).
	 */
	recordEnvelope?: boolean
	/** Each record carries a read-only related record with an id of its own: `Status: { ID, Name }`. */
	relatedRecord?: boolean
	/**
	 * Sort keys are `name_ascending` / `name_descending`, several only as the sort parameter
	 * repeated (`?sort=A_descending&sort=B_ascending`), declared as a template with `join: "repeat"`.
	 */
	repeatedSort?: boolean
	/** Route parameters are documented as bare strings, whatever the identity is: some frameworks emit them so. */
	bareIdParams?: boolean
}

export interface NamedShape {
	name: string
	/** What a correct backend is doing differently here, in the reader's terms. */
	why: string
	shape: ReferenceShape
	/**
	 * Checks that cannot apply to this shape at all, and why. Every other check the default
	 * baseline runs must also run here: a check that quietly stops applying is how an unfamiliar
	 * API ends up "clean".
	 */
	cannotRun?: Readonly<Record<string, string>>
	/** Defects with nowhere to happen in this shape: a page-number API cannot drift a cursor. */
	cannotExhibit?: readonly string[]
	/** Defects only this shape can show, run in its recall pass on top of the common ones. */
	exhibits?: readonly string[]
}

export const SHAPES: readonly NamedShape[] = [
	{
		cannotRun: {
			"pagination.cursor-agrees-with-page": "there is no cursor",
			"pagination.has-more-is-accurate": "there is no more-pages flag to judge",
		},
		cannotExhibit: ["CURSOR_DRIFT", "COLLATION_INCONSISTENT", "HASMORE_ALWAYS_FALSE"],
		name: "page-total",
		shape: { pagination: "page-total" },
		why: "page numbers and a total, with no more-pages flag",
	},
	{
		cannotRun: {
			"pagination.cursor-agrees-with-page": "there is no page number or offset to agree with",
			"pagination.has-more-is-accurate": "there is no more-pages flag to judge",
		},
		cannotExhibit: [
			"OFF_BY_ONE_PAGE",
			"HASMORE_ALWAYS_FALSE",
			"COUNT_ALWAYS_ZERO",
			"COUNT_IGNORES_FILTER",
			/* Both are seen by comparing a cursor walk with a page walk, and there are no pages. */
			"CURSOR_DRIFT",
			"COLLATION_INCONSISTENT",
			/* There is no page number to go past the end with. */
			"PAGE_PAST_END_REPEATS",
		],
		name: "cursor-only",
		shape: { pagination: "cursor-only" },
		why: "a forward cursor and nothing else to page by",
	},
	{
		cannotRun: {
			"pagination.cursor-agrees-with-page": "there is no cursor",
			"pagination.has-more-is-accurate": "there is no more-pages flag to judge",
		},
		cannotExhibit: [
			"CURSOR_DRIFT",
			"COLLATION_INCONSISTENT",
			"HASMORE_ALWAYS_FALSE",
			/* There is no page number to go past the end with. */
			"PAGE_PAST_END_REPEATS",
		],
		name: "offset-total",
		shape: { pagination: "offset-total", prepopulate: 12 },
		why: "rows skipped and taken (skip / take) under a bounded page size, with only a total in a { data, totalCount } envelope",
	},
	{
		cannotRun: {
			"pagination.cursor-agrees-with-page": "there is no cursor",
			"pagination.has-more-is-accurate": "there is no more-pages flag to judge",
			"sort.nulls-first-last": "the sort template has no token that places nulls",
			"spec.declared-sortable-nulls-accepted": "the sort template has no token that places nulls",
		},
		cannotExhibit: [
			"CURSOR_DRIFT",
			"COLLATION_INCONSISTENT",
			"HASMORE_ALWAYS_FALSE",
			"PAGE_PAST_END_REPEATS",
			/* No nulls token to ignore. */
			"SORT_NULLS_MODIFIER_IGNORED",
		],
		name: "wrapped-records",
		shape: {
			identityField: "ID",
			ids: "integer",
			pagination: "offset-total",
			prepopulate: 6,
			recordEnvelope: true,
			relatedRecord: true,
			repeatedSort: true,
			bareIdParams: true,
		},
		why: "an upper-case integer ID, records wrapped on create and read, writes answered without the record, rows beside a fields sidecar, a related record nested in each, and several sort keys as the parameter repeated",
	},
	{
		/* It clamps a page size rather than refusing it, and its document says so. */
		cannotRun: {
			"pagination.limit-bounds-enforced": "the page size is clamped, as the document declares, not refused",
		},
		cannotExhibit: ["LIMIT_OUT_OF_RANGE_SERVED"],
		name: "clamped-limit",
		shape: { clampLimit: 3 },
		why: "the server serves at most 3 per page whatever is asked, and does not document it",
	},
	{
		name: "prepopulated",
		shape: { prepopulate: 230 },
		why: "the collection already holds more records than one page and than oat's walk cap",
	},
	{ name: "uuid-ids", shape: { ids: "uuid" }, why: "UUID identifiers; a malformed one in a path is a 400" },
	{ name: "integer-ids", shape: { ids: "integer" }, why: "integer identifiers; a malformed one in a path is a 400" },
	{
		cannotRun: {
			"create.persists-submitted-fields": "the create answers an acknowledgement, not the record, so there is no echo",
		},
		/* CREATE_DROPS_FIELD: its check compares the create's echo, and there is none here; the lost
		 * field instead fails the read-back that would confirm the record. */
		/* READ_DROPS_FIELD: an acknowledged create is confirmed by the read that drops the field, so
		 * no record is ever confirmed and the seed stops before anything can be judged. */
		cannotExhibit: ["CREATE_DROPS_FIELD", "READ_DROPS_FIELD"],
		exhibits: ["CLIENT_ID_IGNORED", "CLIENT_ID_OVERWRITES"],
		name: "client-ids",
		shape: { ackCreate: true, clientIds: { max: 999, min: 1 }, ids: "integer", prepopulate: 5 },
		why: "the client picks a table's integer id and the create only acknowledges, with tables already present",
	},
	{
		name: "strict-filter-types",
		shape: { conventions: { strictTypes: true } },
		why: "a filter value that is not of the field's type is rejected with 400",
	},
	{ name: "nulls-last", shape: { conventions: { nulls: "last" } }, why: "nulls sort last in ascending order" },
	{
		name: "ci-collation",
		shape: { conventions: { collation: "insensitive" }, prepopulate: 6 },
		why: "text sorts case-insensitively, over mixed-case data",
	},
	{ name: "path-prefix", shape: { basePath: "/api" }, why: "the whole API is mounted under /api" },
	{
		/* PUT replaces by contract, so "a partial update that replaces" has no partial update to break. */
		/* Both are partial-write faults; under PUT the checks that see them stand down. */
		cannotExhibit: ["PATCH_REPLACES", "CONCURRENT_WRITE_LOST"],
		cannotRun: {
			"concurrency.no-lost-update":
				"two concurrent PUTs each replace the whole record; only partial writes can be lost",
			"patch.minimality": "a PUT replaces the record by contract; there is no partial update to keep minimal",
		},
		name: "put-update",
		shape: { updateMethod: "PUT" },
		why: "update is PUT, replacing the record; there is no PATCH",
	},
	{
		name: "write-only-field",
		shape: { writeOnlyField: true },
		why: "create accepts a writeOnly field it never returns",
	},
	{ name: "form-create", shape: { formCreate: true }, why: "create takes a form-encoded body, not JSON" },
	{
		name: "rich-schema",
		shape: { richSchema: true },
		why: "required date-time, a bounded number, a const, and one schema used twice in a body",
	},
	{ name: "large-pages", shape: { largeRecords: true }, why: "one list page is larger than 256 KiB" },
	{
		/* 2XX documents 200 and 201 alike: answering one where the other was meant is permitted. */
		cannotExhibit: ["CREATED_201_AS_200", "RESPONSE_STATUS_UNDECLARED"],
		name: "range-statuses",
		shape: { rangeStatuses: true },
		why: "responses documented as 2XX and default",
	},
	{
		name: "spec-layout",
		shape: { specLayout: true },
		why: "components before paths, path-level parameters, and a recursive schema",
	},
]

export function shapeNamed(name: string): NamedShape {
	const found = SHAPES.find((candidate) => candidate.name === name)
	if (found === undefined) {
		throw new Error(`unknown shape "${name}" — expected one of ${SHAPES.map((s) => s.name).join(", ")}`)
	}
	return found
}

/** The dialect as this shape serves it: its pagination model and sort spelling replace the dialect's own. */
export function shapedDialect(dialect: Dialect, shape: ReferenceShape): Dialect {
	const paged = pagedDialect(dialect, shape)
	if (shape.repeatedSort !== true) return paged
	return {
		...paged,
		params: { ...paged.params, order: "sort" },
		sortGrammar: "template",
		sortTemplate: { asc: "ascending", desc: "descending", join: "repeat", term: "{field}_{direction}" },
	}
}

function pagedDialect(dialect: Dialect, shape: ReferenceShape): Dialect {
	if (shape.pagination === undefined) return dialect
	const params = { ...dialect.params }
	const envelope = dialect.envelope === null ? null : { ...dialect.envelope }
	if (shape.pagination === "page-total") {
		delete params.cursor
		delete params.offset
		params.page = params.page ?? "page"
		if (envelope !== null) {
			delete envelope.hasMore
			delete envelope.nextCursor
			envelope.page = envelope.page ?? "page"
			envelope.total = envelope.total ?? "total"
		}
	} else if (shape.pagination === "offset-total") {
		delete params.cursor
		delete params.page
		params.offset = "skip"
		params.limit = "take"
		/* The rows and how many there are in all: nothing says whether more pages follow. */
		return { ...dialect, envelope: { collection: "data", total: "totalCount" }, params }
	} else {
		delete params.page
		delete params.offset
		params.cursor = params.cursor ?? "cursor"
		if (envelope !== null) {
			delete envelope.hasMore
			delete envelope.page
			delete envelope.total
			envelope.nextCursor = envelope.nextCursor ?? "next_cursor"
		}
	}
	return { ...dialect, envelope, params }
}
