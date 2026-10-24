import { type DefectName, DEFECTS } from "../../reference/defects/table.ts"
import { DIALECTS } from "../../reference/dialect/presets.ts"
import type { Backend } from "./engines.ts"

/**
 * Defects only the SQL-backed reference can exhibit.
 *
 * The in-memory store has no physical column names, so a DDL/read naming mismatch has nowhere
 * to happen. Every other defect is defined above the stores and runs on every engine.
 */
export const SQL_ONLY: ReadonlySet<DefectName> = /* @__PURE__ */ new Set<DefectName>(["COLUMN_NAME_MISMATCH"])

/* Only a create that takes the client's id can ignore or overwrite it: the client-ids shape runs these. */
export const CLIENT_ID_ONLY: ReadonlySet<DefectName> = /* @__PURE__ */ new Set<DefectName>([
	"CLIENT_ID_IGNORED",
	"CLIENT_ID_OVERWRITES",
])

/**
 * The only defects a remote D1 can say anything an in-process engine cannot.
 *
 * Every statement against D1 is a network round trip, so a full pass costs minutes. The defects
 * worth paying that for are the ones whose behaviour comes from the *engine build* — collation,
 * type affinity, NULL ordering, LIKE escaping, identifier resolution. Everything else is decided
 * in the request handler, where D1 would re-derive a result `node:sqlite` already gave for free.
 * The lost update is not among them: the handler holds the write open on purpose, so it is real on
 * any engine and runs on the in-memory one only (`ONE_ENGINE`).
 */
export const ENGINE_SENSITIVE: ReadonlySet<DefectName> = /* @__PURE__ */ new Set<DefectName>([
	"COLLATION_INCONSISTENT",
	"COLUMN_NAME_MISMATCH",
	"LIKE_UNESCAPED",
	"NEQ_DROPS_NULLS",
	"NUMERIC_COMPARED_AS_TEXT",
	"SORT_DESC_DROPS_NULLS",
	"UNSTABLE_SORT",
])

/**
 * Defects that need cursor pagination to exist at all. A dialect that pages only by number
 * cannot exhibit them, so reporting a miss there would be reporting the absence of a feature.
 */
/**
 * Dialects that publish a cursor. Named rather than inferred, because "which defects can this
 * shape even exhibit" is a property of the fixture, and a new dialect that forgets to declare
 * itself here shows up as missed detections rather than as silent exclusions.
 */
export const DIALECTS_WITH_CURSOR: ReadonlySet<string> = /* @__PURE__ */ new Set(["postgrest"])

/**
 * Dialects that report a total. A shape publishing no count cannot publish a wrong one, so the
 * count defects have nowhere to happen — the same reasoning that excuses cursor defects on a
 * cursorless API, and not an excuse for a check that merely failed to fire.
 */
export const DIALECTS_WITH_TOTAL: ReadonlySet<string> = /* @__PURE__ */ new Set([
	"postgrest",
	"classic",
	"jsonapi",
	"template",
])

/**
 * Dialects whose filtering is an expression language rather than one parameter per field.
 *
 * Equality-per-field has no expression to malform, no unknown *field* distinct from an unknown
 * query parameter, and no way to write a pattern — so the defects that live inside a filter
 * grammar have nowhere to happen.
 */
export const DIALECTS_WITH_FILTER_EXPRESSION: ReadonlySet<string> = /* @__PURE__ */ new Set([
	"postgrest",
	"classic",
	"linked",
	"jsonapi",
	"template",
])

/** Defects that need a filter expression language to exist at all. */
export const EXPRESSION_ONLY: ReadonlySet<DefectName> = /* @__PURE__ */ new Set<DefectName>([
	"ERROR_500_ON_BAD_FILTER",
	/* Per-field equality has no declared filter *expression* to overclaim: an unrecognised
	 * parameter is simply ignored, which is conventional rather than a broken promise. */
	"SPEC_OVERCLAIMS_FILTERABLE",
	"FILTER_IGNORED",
	"LIKE_UNESCAPED",
	"NEQ_DROPS_NULLS",
	"NUMERIC_COMPARED_AS_TEXT",
	"FILTER_ILLEGAL_OP_IGNORED",
	/* Per-field equality has no operator or conjunction to leave out of a term. */
	"IGNORES_MALFORMED_FILTER",
	"FILTER_GTE_IS_GT",
	"FILTER_LTE_IS_LT",
	"FILTER_LT_IS_LTE",
	/* The overclaimed operator is `like`, which per-field equality cannot write. */
	"SPEC_OVERCLAIMS_FILTER_OP",
])

/**
 * Defects that need a postgrest-shaped filter writer (`in` / `ilike` / `is`). Colon and
 * equality cannot emit those operators, so injecting the lie there is a miss that names the
 * grammar rather than oat.
 */
export const POSTGREST_OP_ONLY: ReadonlySet<DefectName> = /* @__PURE__ */ new Set<DefectName>([
	"FILTER_IN_FIRST_ONLY",
	"FILTER_ILIKE_IS_LIKE",
	"FILTER_IS_NULL_MATCHES_ALL",
	"FILTER_IN_CAP_IGNORED",
	"FILTER_NIN_FIRST_ONLY",
	"CONTAINS_MATCHES_SUBSTRING",
	/* The alias is `ne`, which only the postgrest-shaped writer spells. */
	"FILTER_ALIAS_MISMAPPED",
	/* Grouping — nested and()/or(), and enough terms in one expression to pass a cap — exists
	 * only in the postgrest-shaped grammar. */
	"FILTER_CONDITION_CAP_IGNORED",
	"FILTER_NESTED_COMBINATOR_LEAKS",
])

/**
 * Defects oat only probes on a declared sort grammar: a direction token is unknown on purpose only
 * when oat knows the grammar's own. The reference declares its sort grammar where it is a template.
 */
export const DECLARED_SORT_ONLY: ReadonlySet<DefectName> = /* @__PURE__ */ new Set<DefectName>([
	"IGNORES_BAD_SORT_DIRECTION",
])

/** Defects that need a search-mode parameter, which only some dialects publish. */
export const SEARCH_MODE_ONLY: ReadonlySet<DefectName> = /* @__PURE__ */ new Set<DefectName>(["SEARCH_MODE_REJECTED"])

/** Defects that need a nulls token in the sort grammar — only the dotted grammar writes one. */
export const NULLS_TOKEN_ONLY: ReadonlySet<DefectName> = /* @__PURE__ */ new Set<DefectName>([
	"SORT_NULLS_MODIFIER_IGNORED",
])

export const DIALECTS_WITH_POSTGREST_FILTER: ReadonlySet<string> = /* @__PURE__ */ new Set([
	"postgrest",
	"linked",
	"jsonapi",
])

/** Defects that need a reported total to exist at all. */
export const COUNT_ONLY: ReadonlySet<DefectName> = /* @__PURE__ */ new Set<DefectName>([
	"COUNT_ALWAYS_ZERO",
	"COUNT_IGNORES_FILTER",
])

export const CURSOR_ONLY: ReadonlySet<DefectName> = /* @__PURE__ */ new Set<DefectName>([
	"CURSOR_DRIFT",
	"COLLATION_INCONSISTENT",
])

/** Defects whose symptom does not depend on the API's query or envelope conventions. */
const DIALECT_INSENSITIVE: ReadonlySet<DefectName> = /* @__PURE__ */ new Set<DefectName>([
	"PATCH_REPLACES",
	"CALLER_UPDATE_DROPPED",
	"PUBLIC_GET_NOT_SUCCESS",
	"TOKEN_EXPIRY_AS_STRING",
	"DISCRIMINATOR_BRANCH_WRONG",
	"ACTION_CRASHES",
	"LISTED_GET_DIFFERS",
	"EXISTENCE_LEAK_VIA_STATUS",
	"UNIQUE_NOT_ENFORCED",
	"IDEMPOTENCY_IGNORED",
	"IDEMPOTENT_REPLAY_INSERTS",
	"IMMUTABLE_WRITABLE",
	"CREATED_201_AS_200",
	"DELETE_MISSING_OK",
	"CROSS_TENANT_READ",
	"CREATE_DROPS_FIELD",
	"READ_DROPS_FIELD",
	"READ_BODY_DIVERGES",
	"STRING_PAYLOAD_MANGLED",
	"ENUM_NOT_VALIDATED",
	"MAXLENGTH_NOT_VALIDATED",
	"REQUIRED_NOT_VALIDATED",
	"CONTENT_TYPE_NOT_ENFORCED",
	"ERROR_SCHEMA_DRIFT",
	"PROBLEM_JSON_MALFORMED",
	"ASYNC_NEVER_COMPLETES",
	"ASYNC_RECEIPT_MISSING_ID",
	"CONCURRENT_WRITE_LOST",
	"ETAG_IGNORED",
	"ROLE_MONOTONICITY_BROKEN",
	"INVITE_NEVER_GRANTS",
	"REVOKE_IGNORED",
	"CREATE_500_ON_NON_ASCII",
	"SIDE_EFFECT_NEVER_ARRIVES",
	"RATE_LIMIT_STRICTER_THAN_DECLARED",
	"PRIVILEGED_FIELD_ON_SIGNUP",
])

/** Defects that need a page-number parameter to be seen. */
const PAGE_NUMBER_ONLY: ReadonlySet<DefectName> = /* @__PURE__ */ new Set<DefectName>(["PAGE_PAST_END_REPEATS"])

/** Defects that run on the in-memory engine only: the store plays no part in them. */
const ONE_ENGINE: ReadonlySet<DefectName> = /* @__PURE__ */ new Set<DefectName>([
	"CONCURRENT_WRITE_LOST",
	"CALLER_UPDATE_DROPPED",
	"PUBLIC_GET_NOT_SUCCESS",
	"TOKEN_EXPIRY_AS_STRING",
	"DISCRIMINATOR_BRANCH_WRONG",
	"ACTION_CRASHES",
	"LISTED_GET_DIFFERS",
	/* The register keeps its accounts in the auth state, never the store. */
	"PRIVILEGED_FIELD_ON_SIGNUP",
])

/** Every defect this backend and dialect can exhibit, narrowed to `filter` when one is given. */
export function defectsFor(backend: Backend, dialect: string, filter?: readonly string[]): DefectName[] {
	return (
		(Object.keys(DEFECTS) as DefectName[])
			.filter((name) => filter === undefined || filter.length === 0 || filter.includes(name))
			/* A defect the backend structurally cannot exhibit is not a miss: the in-memory store has
			 * no physical column names, so a DDL/read mismatch has nowhere to happen. */
			.filter((name) => backend !== "memory" || !SQL_ONLY.has(name))
			/* Shape-only defects run in the recall pass of the shape that names them. */
			.filter((name) => !CLIENT_ID_ONLY.has(name))
			/* Likewise a dialect that has no cursor cannot drift one. */
			.filter((name) => DIALECTS_WITH_CURSOR.has(dialect) || !CURSOR_ONLY.has(name))
			/* Likewise a shape with no total cannot report a wrong one. */
			.filter((name) => DIALECTS_WITH_TOTAL.has(dialect) || !COUNT_ONLY.has(name))
			/* And a shape with no filter *expression* cannot malform one. */
			.filter((name) => DIALECTS_WITH_FILTER_EXPRESSION.has(dialect) || !EXPRESSION_ONLY.has(name))
			.filter((name) => DIALECTS_WITH_POSTGREST_FILTER.has(dialect) || !POSTGREST_OP_ONLY.has(name))
			.filter((name) => DIALECTS[dialect]?.params.searchMode !== undefined || !SEARCH_MODE_ONLY.has(name))
			.filter((name) => DIALECTS[dialect]?.sortTemplate !== undefined || !DECLARED_SORT_ONLY.has(name))
			/* A dialect that pages by offset has no page number to ask past the end. */
			.filter((name) => DIALECTS[dialect]?.params.page !== undefined || !PAGE_NUMBER_ONLY.has(name))
			.filter((name) => (DIALECTS[dialect]?.sortGrammar ?? "dotted") === "dotted" || !NULLS_TOKEN_ONLY.has(name))
			/* A fault in writes, auth or validation reads the same under every dialect; the extra
			 * dialect passes are for how a listing is asked for and answered. */
			.filter((name) => dialect === "postgrest" || !DIALECT_INSENSITIVE.has(name))
			/* A store-independent race, timed with a sleep: one engine shows it as well as three. */
			.filter((name) => backend === "memory" || !ONE_ENGINE.has(name))
			/* D1 is a network round trip per statement. Restricting it to the engine-sensitive set
			 * keeps a run to minutes rather than an hour, and drops nothing D1 could uniquely show. */
			.filter((name) => backend !== "d1" || ENGINE_SENSITIVE.has(name))
	)
}
