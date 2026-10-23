import type { NamedShape } from "./types.ts"

/** Every named shape the conformance suite serves the clean baseline behind. */
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
		name: "wrapped-rows",
		shape: { wrappedRows: true },
		why: "each listed row wraps its record under document beside its highlights, as a search engine answers",
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
		/* CREATE_DROPS_FIELD: the lost field fails the read-back that would confirm the record, so
		 * the seed stops before its check reads the record back. */
		/* READ_DROPS_FIELD: an acknowledged create is confirmed by the read that drops the field, so
		 * no record is ever confirmed and the seed stops before anything can be judged. */
		cannotExhibit: ["CREATE_DROPS_FIELD", "READ_DROPS_FIELD"],
		exhibits: ["CLIENT_ID_IGNORED", "CLIENT_ID_OVERWRITES"],
		name: "client-ids",
		shape: { ackCreate: true, clientIds: { max: 999, min: 1 }, ids: "integer", prepopulate: 5 },
		why: "the client picks a table's integer id and the create only acknowledges, with tables already present",
	},
	{
		cannotRun: {
			"create.unique-conflict-rejected": "the document declares nothing unique",
			"update.unique-conflict-rejected": "the document declares nothing unique",
		},
		/* Nothing is declared unique, so there is no declared uniqueness to stop enforcing. */
		cannotExhibit: ["UNIQUE_NOT_ENFORCED"],
		name: "tenant-slugs",
		shape: { tableKey: "slug" },
		why: "a table is named by a slug derived from its name, unique only within its project",
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
