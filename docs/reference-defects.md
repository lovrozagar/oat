# oat — Reference defects

[← back to the overview](../README.md)

## Reference defects (`oat serve --defects`)

Comma-separated. Each is one named lie the demo API can tell. Primary check is what conformance asserts; extras in parentheses are accepted additional symptoms of the same lie.

| defect                                      | primary check                                   | the lie                                                                                         |
| ------------------------------------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `STALE_LIST`                                | `list.read-after-write`                         | create succeeds, list does not show the row                                                     |
| `CREATE_DROPS_FIELD`                        | `create.persists-submitted-fields`              | a submitted field is dropped                                                                    |
| `STRING_PAYLOAD_MANGLED`                    | `payload.string-survives`                       | non-ASCII / surrounding whitespace stripped on write                                            |
| `RESPONSE_STATUS_UNDECLARED`                | `response.status-is-documented`                 | PATCH returns 201 when the document names 200                                                   |
| `CREATED_201_AS_200`                        | `create.status-matches-document`                | create returns 200 when the spec says 201                                                       |
| `RESPONSE_SCHEMA_DRIFT`                     | `schema.success-response-matches-document`      | success body does not match the schema                                                          |
| `ERROR_SCHEMA_DRIFT`                        | `schema.error-response-matches-document`        | error body does not match the schema                                                            |
| `LIMIT_IGNORED`                             | `pagination.limit-bounds-page-size`             | `limit` is accepted and ignored                                                                 |
| `LIMIT_EXCEEDS_MAX`                         | `pagination.limit-respects-documented-max`      | documented max is not capped                                                                    |
| `HASMORE_ALWAYS_FALSE`                      | `pagination.has-more-is-accurate`               | `hasMore` is always false                                                                       |
| `OFF_BY_ONE_PAGE`                           | `pagination.page-walk-covers-set`               | page walk skips or repeats                                                                      |
| `PAGE_PAST_END_REPEATS`                     | `pagination.bounds-handled`                     | a page past the end repeats the last page                                                       |
| `UNSTABLE_SORT`                             | `pagination.page-walk-covers-set`               | default order is not a total order                                                              |
| `CURSOR_DRIFT`                              | `pagination.cursor-agrees-with-page`            | cursor and page disagree                                                                        |
| `FILTER_IGNORED`                            | `filter.unknown-field-rejected`                 | unknown filter field is ignored                                                                 |
| `UNKNOWN_PARAM_EMPTIES_LIST`                | `query.unknown-parameter-consistent`            | an unknown query parameter empties the listing                                                  |
| `FILTER_EQ_NOT_APPLIED`                     | `filter.equality-selects-exactly-one`           | equality filter is ignored                                                                      |
| `EMPTY_RESULT_RETURNS_ALL`                  | `filter.zero-match-returns-none`                | empty match returns the whole set                                                               |
| `NEQ_DROPS_NULLS`                           | `filter.negation-partitions-the-set`            | `neq` drops nulls so the partition leaks                                                        |
| `FILTER_GROUP_COMBINATOR_SWAPPED`           | `filter.and-composes-as-intersection`           | `and`/`or` are swapped                                                                          |
| `LIKE_UNESCAPED`                            | `filter.like-metacharacters-escaped`            | `%`/`_` are wildcards in values                                                                 |
| `NUMERIC_COMPARED_AS_TEXT`                  | `filter.numeric-comparison-is-numeric`          | numbers compared as strings                                                                     |
| `ERROR_500_ON_BAD_FILTER`                   | `error.malformed-filter-not-5xx`                | bad filter is 500                                                                               |
| `FILTER_AFTER_PAGINATION`                   | `query.filter-selects-from-whole-set`           | filter applied after the page is cut                                                            |
| `ORDER_IGNORED`                             | `sort.order-is-applied`                         | sort param is ignored                                                                           |
| `SORT_DESC_DROPS_NULLS`                     | `sort.reverse-symmetry`                         | desc drops nulls                                                                                |
| `SEARCH_IGNORED`                            | `search.q-narrows-result`                       | search param is ignored                                                                         |
| `SELECT_IGNORED`                            | `select.projection-honoured`                    | select param is ignored                                                                         |
| `COUNT_ALWAYS_ZERO`                         | `count.consistent-with-returned-page`           | total is always 0                                                                               |
| `COUNT_IGNORES_FILTER`                      | `count.matches-filtered-set`                    | total ignores the filter                                                                        |
| `FILTER_DROPPED_WHEN_SORTED`                | `query.axes-compose`                            | sort drops the filter                                                                           |
| `FILTER_DROPPED_WHEN_SELECTED`              | `query.filter-and-select-compose`               | select drops the filter                                                                         |
| `FILTER_DROPPED_WHEN_SEARCHED`              | `query.search-and-filter-compose`               | search drops the filter                                                                         |
| `FILTER_DROPPED_WHEN_SORTED_AND_SELECTED`   | `query.filter-sort-select-compose`              | the triple drops the filter                                                                     |
| `FILTER_DROPPED_WHEN_SORTED_AND_SEARCHED`   | `query.filter-search-sort-compose`              | the triple drops the filter                                                                     |
| `FILTER_DROPPED_WHEN_SEARCHED_AND_SELECTED` | `query.filter-search-select-compose`            | the triple drops the filter                                                                     |
| `SPEC_OVERCLAIMS_FILTERABLE`                | `spec.declared-filterable-is-filterable`        | `x-query` lists a field that 400s                                                               |
| `SPEC_OVERCLAIMS_SORTABLE`                  | `spec.declared-sortable-is-sortable`            | same for sort                                                                                   |
| `SPEC_OVERCLAIMS_SELECTABLE`                | `spec.declared-selectable-is-selectable`        | same for select                                                                                 |
| `FILTER_IN_FIRST_ONLY`                      | `filter.in-is-union-of-eq`                      | `in.(a,b)` matches only the first value                                                         |
| `FILTER_GTE_IS_GT`                          | `filter.gte-is-gt-or-eq`                        | `gte` is compiled as `gt`                                                                       |
| `FILTER_ILIKE_IS_LIKE`                      | `filter.ilike-is-case-insensitive`              | `ilike` is compiled as `like`                                                                   |
| `FILTER_IS_NULL_MATCHES_ALL`                | `filter.is-null-selects-nulls`                  | `is.null` matches every row                                                                     |
| `FILTER_ILLEGAL_OP_IGNORED`                 | `filter.illegal-op-rejected`                    | an operator outside the allowlist, or one the grammar does not have, is ignored                 |
| `IGNORES_MALFORMED_FILTER`                  | `filter.malformed-term-rejected`                | a filter term the grammar cannot parse is dropped (200 with the whole set)                      |
| `IGNORES_BAD_SORT_DIRECTION`                | `sort.invalid-direction-rejected`               | an unknown sort direction is read as ascending (`template` dialect, the one declaring its sort) |
| `SORT_NUMERIC_AS_TEXT`                      | `sort.numeric-order-is-numeric`                 | a numeric field is ordered lexicographically                                                    |
| `SORT_MULTI_KEY_IGNORED`                    | `sort.multi-key-tiebreak`                       | the second sort key is ignored                                                                  |
| `TIEBREAK_NOT_APPLIED`                      | `sort.stable-tiebreak`                          | ties are broken by another field than the declared one                                          |
| `RATE_LIMIT_STRICTER_THAN_DECLARED`         | `spec.declared-rate-limit-is-honoured`          | 429 well inside the declared `x-rate-limit` rate                                                |
| `ACTION_CRASHES`                            | `response.no-server-error`                      | starting a job answers 500 instead of starting it                                               |
| `SELECT_FIELD_MISSING`                      | `select.requested-fields-present`               | a requested select field is dropped                                                             |
| `CROSS_TENANT_READ`                         | `tenant.item-not-readable-cross-tenant`         | item GET is global by id                                                                        |
| `CLIENT_ID_IGNORED`                         | `create.keeps-submitted-identity`               | a create stores the record under its own id, not the one the client chose (`client-ids` shape)  |
| `CLIENT_ID_OVERWRITES`                      | `create.unique-conflict-rejected`               | a create with an id the tenant already holds overwrites that record (`client-ids` shape)        |
| `CROSS_TENANT_WRITE`                        | `tenant.item-not-writable-cross-tenant`         | update and delete reach another tenant's record                                                 |
| `EXISTENCE_LEAK_VIA_STATUS`                 | `tenant.denial-does-not-reveal-existence`       | 403 vs 404 reveals the other tenant's row                                                       |
| `TENANT_LEAK_VIA_FILTER`                    | `tenant.filter-does-not-bypass-scope`           | filter drops the tenant predicate                                                               |
| `FOREIGN_PARENT_ACCEPTED`                   | `tenant.parent-not-reachable-from-another-root` | another tenant's parent is accepted under one's own root                                        |
| `ROLE_MONOTONICITY_BROKEN`                  | `auth.rank-is-monotonic`                        | a lower rank can do more                                                                        |
| `ROLE_WRITE_INVERTED`                       | `auth.rank-is-monotonic-on-writes`              | a lower rank can update where a higher rank cannot                                              |
| `INVITE_NEVER_GRANTS`                       | `auth.invite-grants-then-revokes`               | accept does not grant                                                                           |
| `REVOKE_IGNORED`                            | `auth.invite-grants-then-revokes`               | revoke leaves the grant                                                                         |
| `IMMUTABLE_WRITABLE`                        | `patch.immutable-field-rejected`                | immutable fields accept writes                                                                  |
| `SOFT_DELETE_LEAK`                          | `softdelete.absent-from-default-list`           | tombstone stays on the default list                                                             |
| `PARENT_PROJECTION_STALE`                   | `invalidation.declared-route-changes`           | child write does not bump the parent                                                            |
| `EFFECT_NOT_APPLIED`                        | `effects.declared-effect-occurs`                | declared cardinality delta does not happen                                                      |
| `ASYNC_NEVER_COMPLETES`                     | `async.reaches-terminal-state`                  | job stays pending                                                                               |
| `ASYNC_RECEIPT_MISSING_ID`                  | `async.receipt-identifies-the-job`              | receipt has no id                                                                               |
| `PATCH_REPLACES`                            | `patch.minimality`                              | PATCH is implemented as replace                                                                 |
| `IDEMPOTENCY_IGNORED`                       | `idempotency.replay-does-not-duplicate`         | Idempotency-Key is ignored                                                                      |
| `IDEMPOTENT_REPLAY_INSERTS`                 | `idempotency.replay-does-not-duplicate`         | a replay returns the original but inserts another row                                           |
| `UNIQUE_NOT_ENFORCED`                       | `create.unique-conflict-rejected`               | a duplicate unique-set write is 2xx instead of 409                                              |
| `DELETE_MISSING_OK`                         | `delete.absent-record-returns-404`              | DELETE missing returns 200                                                                      |
| `CONCURRENT_WRITE_LOST`                     | `concurrency.no-lost-update`                    | full-row write clobbers a parallel PATCH                                                        |
| `ENUM_NOT_VALIDATED`                        | `validation.enum-enforced`                      | enum is not enforced                                                                            |
| `MAXLENGTH_NOT_VALIDATED`                   | `validation.max-length-enforced`                | maxLength is not enforced                                                                       |
| `REQUIRED_NOT_VALIDATED`                    | `validation.required-enforced`                  | required is not enforced                                                                        |
| `CONTENT_TYPE_NOT_ENFORCED`                 | `validation.content-type-enforced`              | wrong Content-Type is accepted                                                                  |
| `LIST_DETAIL_DISAGREE`                      | `consistency.projections-agree`                 | list and item show different values                                                             |
| `COLUMN_NAME_MISMATCH`                      | `create.persists-submitted-fields`              | SQL identifier does not match the field (SQL backends)                                          |
| `COLLATION_INCONSISTENT`                    | `pagination.cursor-agrees-with-page`            | cursor order ≠ page order (SQL)                                                                 |

```bash
oat serve --defects STALE_LIST,PATCH_REPLACES
oat run --config labs/local.config.ts --base-url <url>
```

`COLUMN_NAME_MISMATCH` is SQL-only in conformance (the in-memory store has no physical column names). `CONCURRENT_WRITE_LOST` runs on the in-memory engine only: the race it times does not depend on the store.

The `template` dialect (`oat serve --dialect template`) speaks a grammar oat knows only from its declaration: `where=and_status_eq_active`, repeated once per term, `ne` for not-equal, `and_x_is_null` / `and_x_isn_null`, comma-joined `in` lists, `_` in a value written `~`, `like` as a bare substring, and sort keys `name_ascending` / `name_descending`. Its document declares both grammars as templates on `x-query`; the reference parses them with its own expressions, never oat's renderer.

`CLIENT_ID_IGNORED` and `CLIENT_ID_OVERWRITES` exist only behind the `client-ids` shape, where the client picks a table's integer id (1–999), the create answers `{ "success": true }`, and tables are already present before oat arrives. The shape is a correct backend; its recall pass runs these two on top of the common defects.

### What every conformance case also asserts

Besides its defect, every case — clean baseline or injected defect — fails when oat:

- leaves a record behind after teardown (baselines),
- deletes or changes a record that existed before the run (`touched N record(s) it did not create`), or
- ledgers for teardown an id the server never issued or stored (`ledgered N id(s) the server never created`) — an id oat only sent, say. An id a defective server handed back without storing the record counts as issued.

A defect that by design rewrites other rows would be listed in `DAMAGES_BYSTANDERS` (`src/reference/defects.ts`) with its reason; none is today.
