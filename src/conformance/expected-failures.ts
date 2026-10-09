/**
 * Conformance cases known to fail today, and why.
 *
 * Each entry is a correct backend oat still misjudges. The list may only shrink: a listed case
 * that starts passing fails the suite until its entry is removed, so a fix is recorded the moment
 * it lands and a regression cannot hide behind an entry that is no longer needed.
 *
 * Keys are case names as the suite prints them (`shape:<name>`, `recall:<shape>:<defect>`).
 */
export const EXPECTED_FAILURES: Readonly<Record<string, string>> = {}

const UNTAGGED_SORT_GUESSES: readonly string[] = [
	/* The guessed sort is refused, so ordering — and a walk under it — is never observed. These
	 * returned silently before outcomes were typed; they were never passes. */
	"sort.order-is-applied@job",
	"sort.order-is-applied@row",
	"pagination.cursor-agrees-with-page@job",
	"pagination.cursor-agrees-with-page@row",
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
