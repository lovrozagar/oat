/**
 * Conformance cases known to fail today, and why.
 *
 * Each entry is a correct backend oat still misjudges. The list may only shrink: a listed case
 * that starts passing fails the suite until its entry is removed, so a fix is recorded the moment
 * it lands and a regression cannot hide behind an entry that is no longer needed.
 *
 * Keys are case names as the suite prints them (`shape:<name>`, `recall:<shape>:<defect>`).
 */
export const EXPECTED_FAILURES: Readonly<Record<string, string>> = {
	"shape:clamped-limit":
		"a page shorter than the size asked for is read as the end of the set (collectSet), so set checks compare windows",
	"shape:ci-collation":
		"sort.order-is-applied judges order with a binary comparator, and its false finding suppresses 36 checks",
	"shape:cursor-only":
		"collectSet re-requests page 1 when there is no page parameter, so every set looks capped and goes inconclusive",
	"shape:form-create":
		"create.persists-submitted-fields compares form strings with the typed values the response echoes",
	"shape:integer-ids":
		"the absent-id probe is not an integer, so its 400 is compared with a real 404 and reported as an existence oracle",
	"shape:large-pages": "a list response over 256 KiB reaches the check as a hash stub (client.ts), so writes look lost",
	"shape:page-total":
		"walkPages stops when a page carries no more-pages flag, so pages after the first read as missing",
	"shape:prepopulated":
		"single-page reads treat one page as the whole collection: effects, invalidation and comparisons misfire",
	"shape:put-update": "write checks send a hard-coded PATCH, which a PUT-only API answers with 405",
	"shape:range-statuses":
		"documented statuses are parsed with parseInt, so 2XX reads as status 2 and default is dropped",
	"shape:rich-schema": "the fixture generator sends an invalid date-time, so seeding is blocked",
	"shape:strict-filter-types":
		"declared-capability probes send a value of the wrong type and read the 400 as a broken declaration",
	"shape:uuid-ids":
		"the absent-id probe is not a UUID, so its 400 is compared with a real 404 and reported as an existence oracle",
	"shape:write-only-field": "persistence and response-schema checks expect a writeOnly field to be returned",
	/* Behind a base path the create exchange is looked up by its pathname without the prefix, so
	 * every check that judges the create response finds nothing to judge and passes quietly. */
	"recall:path-prefix:CREATED_201_AS_200": "createExchange matches the pathname without the base path",
	"recall:path-prefix:CREATE_DROPS_FIELD": "createExchange matches the pathname without the base path",
	"recall:path-prefix:RESPONSE_STATUS_UNDECLARED":
		"response.status-is-documented maps exchanges to operations by pathname, which misses the base path",
	"recall:path-prefix:RESPONSE_SCHEMA_DRIFT": "createExchange matches the pathname without the base path",
	"recall:path-prefix:ASYNC_RECEIPT_MISSING_ID":
		"async.receipt-identifies-the-job finds the start exchange by pathname, which misses the base path",
}

const UNTAGGED_SORT_GUESSES: readonly string[] = [
	"sort.multi-key-tiebreak@job",
	"sort.reverse-symmetry@job",
	"query.axes-compose@job",
	"query.sort-and-select-compose@job",
	"query.filter-sort-select-compose@job",
	"query.filter-search-sort-compose@job",
	"query.search-and-sort-compose@job",
	"query.filter-search-sort-select-compose@job",
	"sort.multi-key-tiebreak@row",
	"sort.reverse-symmetry@row",
	"query.axes-compose@row",
	"query.sort-and-select-compose@row",
	"query.filter-search-sort-compose@row",
	"query.search-and-sort-compose@row",
	"query.filter-sort-select-compose@row",
	"query.filter-search-sort-select-compose@row",
	"query.search-and-sort-compose@table",
]

/**
 * Inconclusive verdicts a clean baseline may return, per `backend:dialect`, as `check@entity`.
 *
 * A check that cannot decide against a correct backend has not shown that it passes, so any
 * verdict not listed here fails the baseline. Like the list above, this may only shrink.
 */
export const EXPECTED_INCONCLUSIVE: Readonly<Record<string, readonly string[]>> = Object.fromEntries(
	["memory", "sqlite", "postgres"].flatMap((backend) =>
		["postgrest", "classic", "linked", "jsonapi", "plain"].map((dialect) => [
			`${backend}:${dialect}:untagged`,
			/* With every x-* tag stripped, oat guesses that each scalar property sorts; the backend
			 * rightly refuses parent keys. The guess is already reported as an x-query gap. */
			UNTAGGED_SORT_GUESSES,
		]),
	),
)
