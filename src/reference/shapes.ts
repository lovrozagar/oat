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
	pagination?: "page-total" | "cursor-only"
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

/** The dialect as this shape serves it: the pagination model replaces the dialect's own. */
export function shapedDialect(dialect: Dialect, shape: ReferenceShape): Dialect {
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
