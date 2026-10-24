/** Records and responses: writes, reads, validation, statuses, effects, storage, concurrency and access. */
export const RECORD_DEFECTS = {
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
	/**
	 * A delete answers success and keeps the row. The checks catch it by reading the record back;
	 * teardown, which deleted the same way, lists every record it could not really remove.
	 */
	DELETE_KEEPS_ROW: "a delete answers success but the record stays",
	/** Reads of another tenant's record succeed. */
	CROSS_TENANT_READ: "item route serves records belonging to another tenant",
	/** The page-size parameter is accepted and ignored. */
	LIMIT_IGNORED: "limit is accepted but does not bound the page size",
	/** More rows are returned than the documented maximum allows. */
	LIMIT_EXCEEDS_MAX: "page size exceeds the documented maxLimit",
	/** A page size of 0 or past the maximum is served as the nearest allowed one, though the document says it is refused. */
	LIMIT_OUT_OF_RANGE_SERVED: "an out-of-range page size is served instead of refused",
	/** The more-pages flag is always false, so callers stop after page one. */
	HASMORE_ALWAYS_FALSE: "hasMore is false even when further pages exist",
	/** The sort parameter is accepted and ignored. */
	ORDER_IGNORED: "order is accepted but does not change the result order",
	/** The search parameter is accepted and ignored. */
	SEARCH_IGNORED: "q is accepted but does not filter the result",
	/** A field is accepted at create and silently discarded. */
	CREATE_DROPS_FIELD: "create accepts a field and does not persist it",
	/** The item read leaves out a field the record holds: the list and the store still have it. */
	READ_DROPS_FIELD: "the item read omits a field the record holds",
	/** A table's item read answers a member its documented schema does not declare; its listing does not. */
	READ_BODY_DIVERGES: "the item read answers a member its documented schema does not declare",
	/**
	 * PATCH of the signed-up caller returns 200 and leaves the record unchanged.
	 *
	 * The caller is the record. A success that the next read does not show is a lost update
	 * with nowhere else to look: there is no list and no id.
	 */
	CALLER_UPDATE_DROPPED: "an update to the signed-up caller returns success and does not stick",
	/**
	 * A public read with no id returns 500.
	 *
	 * Nothing is created first and no token is sent. The document named a success status.
	 * A 500 is the server failing that read, not a missing fixture.
	 */
	PUBLIC_GET_NOT_SUCCESS: "a public read with no id returns a server error",
	/**
	 * The token exchange answers `expires_in` as a string where the document declares an integer.
	 *
	 * The credential still works, so every check that only uses it stays quiet. Only the contract
	 * tier holds that body to its schema: auth runs before any check and nothing else grades it.
	 */
	TOKEN_EXPIRY_AS_STRING: "the token exchange answers expires_in as a string, not the documented integer",
	/**
	 * The search answers a card's fields under the bank tag, or a bank account's under the card tag.
	 *
	 * Each field still fits a branch, so only a union pinned by its discriminator rules the body out.
	 * Nothing but the contract tier calls the search, so its call is the one that grades it.
	 */
	DISCRIMINATOR_BRANCH_WRONG: "the search answers a payment method under the other branch's tag",
	/** The get of a listed row returns a different body than the list. */
	LISTED_GET_DIFFERS: "the get of a listed row returns a different body",
	/**
	 * Non-ASCII and surrounding whitespace are stripped on write.
	 *
	 * The realistic shape: a column that is not Unicode, a `.trim()`, a "sanitiser" that drops
	 * anything outside ASCII printable. Create of ordinary English still looks right.
	 */
	STRING_PAYLOAD_MANGLED: "non-ASCII and surrounding whitespace are stripped on write",
	/**
	 * An operation returns a success status the document does not name.
	 *
	 * Not REST (create must be 201). The document said 200 and the handler returned 201, so
	 * generated clients will not treat the response as success.
	 */
	RESPONSE_STATUS_UNDECLARED: "an operation returns a status its document does not declare",
	/** An enum field accepts values outside the declared set. */
	ENUM_NOT_VALIDATED: "enum field accepts a value outside the declared set",
	/** A string longer than maxLength is stored. */
	MAXLENGTH_NOT_VALIDATED: "string exceeding maxLength is accepted",
	/** A create missing a required field succeeds. */
	REQUIRED_NOT_VALIDATED: "create succeeds with a required field missing",
	/** A non-JSON content type is accepted on a JSON endpoint. */
	CONTENT_TYPE_NOT_ENFORCED: "request body is parsed regardless of content type",
	/**
	 * A table's or a row's update skips validation: it applies what parses and drops the rest, so an
	 * invalid body answers 200. Creates and every other entity's update still validate.
	 */
	WRITE_BODY_NOT_VALIDATED: "an update applies what parses of an invalid body instead of refusing it",
	/** Error bodies do not match the documented error schema. */
	ERROR_SCHEMA_DRIFT: "error response does not match its documented schema",
	/** The 412 problem detail names another status than the response's: 400 on a 412. */
	PROBLEM_JSON_MALFORMED: "a problem detail's status disagrees with the response's status",
	/** Success bodies carry fields the schema does not declare. */
	RESPONSE_SCHEMA_DRIFT: "success response carries undeclared fields",
	/** An equality predicate is parsed and then never applied. */
	FILTER_EQ_NOT_APPLIED: "eq predicate is accepted but matches every record",
	/** An empty filtered set is replaced by the unfiltered one. */
	EMPTY_RESULT_RETURNS_ALL: "a filter matching nothing falls back to returning everything",
	/** SQL three-valued logic leaking through: NULL rows vanish from a negated predicate. */
	NEQ_DROPS_NULLS: "neq silently excludes records whose value is null",
	/** The total is computed by a query that disagrees with the one producing the rows. */
	COUNT_ALWAYS_ZERO: "count reports zero while the same body returns records",
	/** Descending order drops the rows an ascending order includes. */
	SORT_DESC_DROPS_NULLS: "descending sort omits records with a null sort key",
	/** An operation declares an effect in the document and does not perform it. */
	EFFECT_NOT_APPLIED: "declared x-effects side effect never happens",
	/** An action crashes: a check that needed it to succeed can only report what it then could not verify. */
	ACTION_CRASHES: "starting a job answers 500 instead of starting it",
	/** An async job never leaves its running state. */
	ASYNC_NEVER_COMPLETES: "async job stays pending forever and never reaches a terminal state",
	/** The receipt for an async job omits the identifier needed to poll it. */
	ASYNC_RECEIPT_MISSING_ID: "async receipt omits the job id the document declares",
	/**
	 * DDL names a physical column differently from every read.
	 *
	 * SQL-store only, and modelled on a real production bug: SQLite resolves an unknown
	 * double-quoted identifier as a *string literal* instead of erroring, so the mismatch
	 * surfaces as every row reporting the column's own name as its value — silent corruption
	 * rather than a loud failure.
	 */
	COLUMN_NAME_MISMATCH: "physical column name differs from the name every read uses",
	/**
	 * Numeric columns compared as text, so `amount > 9` misses 10 and ordering reads
	 * 1, 10, 100, 2. Extremely common wherever query values arrive untyped from a URL.
	 */
	NUMERIC_COMPARED_AS_TEXT: "numeric column is compared and ordered as text",
	/**
	 * The listing and the cursor lookup disagree about collation, so keyset pagination resolves
	 * a boundary the listing never had — rows are skipped or repeated between pages.
	 */
	COLLATION_INCONSISTENT: "cursor resolution uses a different collation than the listing",
	/**
	 * Read-modify-write without locking: the handler reads the row, then writes every column
	 * back. Two concurrent patches to different fields, and the later write reinstates the
	 * earlier field's old value — the classic ORM `save(entity)` lost update.
	 */
	CONCURRENT_WRITE_LOST: "concurrent writes to different fields lose one of them",
	/**
	 * The update ignores If-Match: a write naming an ETag the record has moved past is applied
	 * instead of refused with 412, so optimistic concurrency protects nothing.
	 */
	ETAG_IGNORED: "an update naming a stale ETag in If-Match is applied instead of refused with 412",
	/**
	 * A lower-ranked role can read a record that a higher-ranked role in the same tenant cannot.
	 *
	 * The lattice is inverted on the item route only: a viewer is served, a member is denied,
	 * the owner still reads. Isolation and the write path stay intact; the failure is purely
	 * that privilege is not monotonic.
	 */
	ROLE_MONOTONICITY_BROKEN: "a lower-ranked role can read a record a higher-ranked same-tenant role cannot",
	/** Accept completes but the invitee still cannot read the shared record. */
	INVITE_NEVER_GRANTS: "accepting an invite does not grant access to the record",
	/** Revoke returns success and the invitee can still read. */
	REVOKE_IGNORED: "revoking an invite does not remove access",
} as const
