/**
 * Defects the reference backend can be told to exhibit.
 *
 * Each one is a real bug seen in production APIs, reduced to its smallest form. The conformance
 * suite switches them on individually and asserts oat reports exactly that defect and nothing
 * else — which is what turns "oat is smart" into precision and recall numbers.
 *
 * Keep the implementations naive and obvious. If the reference backend grows clever it starts
 * encoding the same assumptions oat does, and the two drift together into agreeing on nonsense.
 */

export const DEFECTS = {
	/** Sort has no total order, so keyset paging silently drops and repeats rows. */
	UNSTABLE_SORT: "sort lacks a tiebreak; page walks drop or duplicate rows",
	/** Writes land in the item store but the list projection serves a stale snapshot. */
	STALE_LIST: "list projection does not reflect writes visible on the item route",
	/** Unrecognised filter fields are dropped instead of rejected. */
	FILTER_IGNORED: "unknown filter field is silently ignored rather than rejected",
	/** Cursor pagination and offset pagination disagree about the underlying set. */
	CURSOR_DRIFT: "cursor pagination yields a different set than offset pagination",
	/** PATCH behaves as PUT, clearing fields the caller never mentioned. */
	PATCH_REPLACES: "PATCH clears fields absent from the request body",
	/** Total count ignores the active filter. */
	COUNT_IGNORES_FILTER: "count reflects the unfiltered set",
	/** The tenant predicate is applied to the list query but not to filter matches. */
	TENANT_LEAK_VIA_FILTER: "filter bypasses the tenant predicate",
	/** Tombstoned records remain in the default listing. */
	SOFT_DELETE_LEAK: "soft-deleted records still appear in the default list",
	/** Server-owned fields accept client writes. */
	IMMUTABLE_WRITABLE: "immutable field accepts a write",
	/** Sparse fieldsets are accepted and ignored. */
	SELECT_IGNORED: "select returns every field regardless of what was requested",
	/** LIKE metacharacters in user input are not escaped. */
	LIKE_UNESCAPED: "unescaped LIKE metacharacters make a filter match everything",
	/** Offset arithmetic is wrong by one row per page. */
	OFF_BY_ONE_PAGE: "page offset is computed one row late",
	/** Create returns a status the document does not declare. */
	CREATED_201_AS_200: "create returns 200 where the document declares 201",
	/** Malformed input crashes instead of being rejected. */
	ERROR_500_ON_BAD_FILTER: "malformed filter produces 500 instead of 400",
	/** Deleting an absent record reports success. */
	DELETE_MISSING_OK: "deleting a nonexistent record returns success instead of 404",
	/** Reads of another tenant's record succeed. */
	CROSS_TENANT_READ: "item route serves records belonging to another tenant",
	/** The page-size parameter is accepted and ignored. */
	LIMIT_IGNORED: "limit is accepted but does not bound the page size",
	/** More rows are returned than the documented maximum allows. */
	LIMIT_EXCEEDS_MAX: "page size exceeds the documented maxLimit",
	/** The more-pages flag is always false, so callers stop after page one. */
	HASMORE_ALWAYS_FALSE: "hasMore is false even when further pages exist",
	/** The sort parameter is accepted and ignored. */
	ORDER_IGNORED: "order is accepted but does not change the result order",
	/** The search parameter is accepted and ignored. */
	SEARCH_IGNORED: "q is accepted but does not filter the result",
	/** A field is accepted at create and silently discarded. */
	CREATE_DROPS_FIELD: "create accepts a field and does not persist it",
	/** An enum field accepts values outside the declared set. */
	ENUM_NOT_VALIDATED: "enum field accepts a value outside the declared set",
	/** A string longer than maxLength is stored. */
	MAXLENGTH_NOT_VALIDATED: "string exceeding maxLength is accepted",
	/** A create missing a required field succeeds. */
	REQUIRED_NOT_VALIDATED: "create succeeds with a required field missing",
	/** A non-JSON content type is accepted on a JSON endpoint. */
	CONTENT_TYPE_NOT_ENFORCED: "request body is parsed regardless of content type",
	/** Error bodies do not match the documented error schema. */
	ERROR_SCHEMA_DRIFT: "error response does not match its documented schema",
	/** Success bodies carry fields the schema does not declare. */
	RESPONSE_SCHEMA_DRIFT: "success response carries undeclared fields",
	/** An equality predicate is parsed and then never applied. */
	FILTER_EQ_NOT_APPLIED: "eq predicate is accepted but matches every record",
	/** An empty filtered set is replaced by the unfiltered one. */
	EMPTY_RESULT_RETURNS_ALL: "a filter matching nothing falls back to returning everything",
	/** SQL three-valued logic leaking through: NULL rows vanish from a negated predicate. */
	NEQ_DROPS_NULLS: "neq silently excludes records whose value is null",
	/** Descending order drops the rows an ascending order includes. */
	SORT_DESC_DROPS_NULLS: "descending sort omits records with a null sort key",
} as const

export type DefectName = keyof typeof DEFECTS

export class DefectSet {
	private readonly enabled: ReadonlySet<string>

	constructor(names: readonly string[] = []) {
		this.enabled = new Set(names)
	}

	static fromEnv(value: string | undefined): DefectSet {
		if (value === undefined || value.trim() === "") return new DefectSet()
		return new DefectSet(value.split(",").map((s) => s.trim()).filter(Boolean))
	}

	has(name: DefectName): boolean {
		return this.enabled.has(name)
	}

	list(): DefectName[] {
		return [...this.enabled] as DefectName[]
	}
}

export function isDefectName(value: string): value is DefectName {
	return Object.hasOwn(DEFECTS, value)
}
