# oat — Checks and verdicts

[← back to the overview](../README.md)

## Checks

99 checks. A check that cannot run says so (`did not apply` + `needs`). A check that depends on a broken primitive is `BLOCKED`. A check that ran and stopped is inconclusive, not a pass.

Order is fixed (foundations first) so cascade suppression has a cause to point at. Mutating checks run alone; read-only checks may share in-flight requests under `maxInFlight`.

`depends` is the `dependsOn` list: if any of those already failed **for this entity**, this check is `BLOCKED` rather than reported as a second defect. Suppression is transitive.

| id                                              | asserts                                                                                                                                    | needs                                                                | depends                                 |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------- | --------------------------------------- |
| `list.read-after-write`                         | a just-created record appears on the list                                                                                                  | create + a seeded record                                             | —                                       |
| `create.persists-submitted-fields`              | every writable field sent on create is echoed                                                                                              | create that echoes the record                                        | `list.read-after-write`                 |
| `payload.string-survives`                       | a documented-valid string is stored exactly; 4xx after an ASCII control is a fail                                                          | update or create+delete, item GET, unconstrained string              | `list.read-after-write`                 |
| `create.status-matches-document`                | create status is one the document declared                                                                                                 | create                                                               | —                                       |
| `response.status-is-documented`                 | every non-create exchange returns a status that operation names (`default` ≠ 201)                                                          | a modeled non-create operation oat invoked                           | —                                       |
| `schema.success-response-matches-document`      | create body validates against the success schema                                                                                           | success schema on create                                             | `create.status-matches-document`        |
| `schema.error-response-matches-document`        | an error body validates against the documented error schema                                                                                | error schema on the item route                                       | —                                       |
| `pagination.limit-bounds-page-size`             | page size ≤ the requested limit                                                                                                            | page-size _role_ (aliases include `limit`, `per_page`, …)            | `list.read-after-write`                 |
| `pagination.limit-respects-documented-max`      | requesting more than `maxLimit` does not return more                                                                                       | declared `maxLimit` and a larger cohort                              | `pagination.limit-bounds-page-size`     |
| `pagination.has-more-is-accurate`               | `hasMore` / `Link rel=next` matches whether another page exists                                                                            | page-forward + `hasMore` or `Link rel=next`                          | `pagination.limit-bounds-page-size`     |
| `pagination.page-walk-covers-set`               | walking pages covers the collection with no gaps or dupes                                                                                  | page or offset + ≥3 records                                          | `pagination.limit-bounds-page-size`     |
| `pagination.bounds-handled`                     | a zero, negative, fractional or non-numeric page size, and a page past the end, are refused or served sanely — never a 5xx or a repeat     | page-size or page-number parameter + ≥1 record                       | `pagination.page-walk-covers-set`       |
| `pagination.cursor-agrees-with-page`            | cursor walk and page walk yield the same set                                                                                               | both cursor and page                                                 | `pagination.limit-bounds-page-size`     |
| `filter.unknown-field-rejected`                 | a filter on a field that does not exist is not silently ignored                                                                            | a filter expression                                                  | —                                       |
| `filter.equality-selects-exactly-one`           | `id.eq.<one>` returns that one record                                                                                                      | equality on the identity                                             | `list.read-after-write`                 |
| `filter.zero-match-returns-none`                | a filter that matches nothing returns an empty page, not the whole set                                                                     | same                                                                 | `list.read-after-write`                 |
| `filter.negation-partitions-the-set`            | `eq` ∪ `neq` = whole set, intersection empty                                                                                               | eq and neq                                                           | `list.read-after-write`, equality       |
| `filter.and-composes-as-intersection`           | `and(A,B)` = A ∩ B                                                                                                                         | two filterable fields + AND                                          | equality / list                         |
| `filter.or-composes-as-union`                   | `or(A,B)` = A ∪ B                                                                                                                          | `or()` — **postgrest grammar only**                                  | equality / list                         |
| `filter.like-metacharacters-escaped`            | `%` `_` `*` in a value are literals, not wildcards                                                                                         | like operator                                                        | `list.read-after-write`                 |
| `filter.numeric-comparison-is-numeric`          | `gt`/`lt` on a number uses numeric order, not TEXT (`1,10,2`)                                                                              | numeric field + a filter param                                       | `list.read-after-write`, unknown-field  |
| `filter.in-is-union-of-eq`                      | `in.(a,b)` = `eq.a` ∪ `eq.b`                                                                                                               | field allows `in`; ≥2 distinct values                                | equality                                |
| `filter.nin-complements-in`                     | `in` ∩ `nin` empty; union = set minus nulls                                                                                                | field allows `in` and `nin`                                          | `in`                                    |
| `filter.gte-is-gt-or-eq`                        | `gte.x` = `gt.x` ∪ `eq.x`                                                                                                                  | field allows `gte` and `gt`; ordered type                            | numeric comparison                      |
| `filter.lte-is-lt-or-eq`                        | `lte.x` = `lt.x` ∪ `eq.x`                                                                                                                  | field allows `lte` and `lt`                                          | numeric comparison                      |
| `filter.ordered-triple-partitions`              | `lt` ∪ `eq` ∪ `gt` = set minus nulls; pairwise disjoint                                                                                    | field allows all three                                               | numeric comparison                      |
| `filter.ilike-is-case-insensitive`              | case-flipped value: `ilike` matches; `like` does not (unresolved if both match)                                                            | field allows both                                                    | like                                    |
| `filter.is-null-selects-nulls`                  | `is.null` = nulls; `is.notnull` = complement                                                                                               | field allows `is`; cohort has a null                                 | foundations                             |
| `filter.contains-membership`                    | `contains.<el>` = records whose array value includes `el`                                                                                  | array field or ops include `contains`                                | foundations                             |
| `filter.nested-and-or-distributes`              | `and(A,or(B,C))` = (A∩B) ∪ (A∩C)                                                                                                           | postgrest grammar; ≥2 filterable fields                              | `and` / `or`                            |
| `filter.alias-matches-canonical`                | each declared alias token selects the same id-set as its target                                                                            | `aliases` non-empty                                                  | equality                                |
| `filter.illegal-op-rejected`                    | one op **not** in that field's `ops` is 4xx                                                                                                | closed `ops` list                                                    | unknown-field                           |
| `filter.empty-in`                               | `in.()` is 4xx (`reject`) or zero rows (`match-none`)                                                                                      | `emptyIn` set; field allows `in`                                     | `in`                                    |
| `filter.in-over-limit-rejected`                 | `in` list of `maxInValues+1` is 4xx                                                                                                        | `maxInValues` set                                                    | foundations                             |
| `filter.condition-cap-rejected`                 | `maxFilterConditions+1` `eq` terms is 4xx                                                                                                  | `maxFilterConditions` set                                            | foundations                             |
| `spec.declared-filterable-ops-accepted`         | every declared field × every op in that field's `ops` returns <400                                                                         | closed `ops`                                                         | declared-filterable                     |
| `error.malformed-filter-not-5xx`                | garbage filter text is 4xx, never 5xx                                                                                                      | a filter expression                                                  | —                                       |
| `query.filter-selects-from-whole-set`           | a filter is applied to the collection, not to the current page                                                                             | filterable + ≥3 records                                              | list / walk                             |
| `sort.order-is-applied`                         | requesting a sort actually rearranges the page                                                                                             | order + a sortable field                                             | `pagination.limit-bounds-page-size`     |
| `sort.reverse-symmetry`                         | desc is the reverse of asc (nulls included)                                                                                                | order + asc/desc                                                     | order-is-applied                        |
| `sort.unknown-field-rejected`                   | `order` on an undeclared field is 4xx, not silent ignore                                                                                   | order param                                                          | —                                       |
| `sort.numeric-order-is-numeric`                 | `1,10,2` sorts as numbers, not text                                                                                                        | numeric sortable field whose lexical order disagrees                 | order-is-applied                        |
| `sort.nulls-first-last`                         | `nullsfirst` / `nullslast` put nulls at the start / end of asc                                                                             | declared nulls token; dotted grammar; cohort has a null              | order + reverse                         |
| `sort.multi-key-tiebreak`                       | ties on the first key are ordered by the second                                                                                            | ≥2 sortable fields; `maxKeys` absent or ≥2                           | order + reverse                         |
| `sort.default-order-applied`                    | omitting `order` matches `defaultOrder`                                                                                                    | `defaultOrder` set; walk complete                                    | order + walk                            |
| `sort.stable-tiebreak`                          | the same `order` twice yields the same sequence                                                                                            | `stableTiebreak` set                                                 | order-is-applied                        |
| `spec.declared-sortable-nulls-accepted`         | each declared nulls token returns <400                                                                                                     | some field/global declares `nulls`                                   | order-is-applied                        |
| `search.q-narrows-result`                       | a search term that matches one record does not return the whole set                                                                        | search param + searchable fields                                     | `list.read-after-write`                 |
| `search.tokens-and`                             | `q=a b` = intersection (AND). Sameness of AND and OR passes                                                                                | searchable fields; two tokens that split the cohort                  | `q-narrows`                             |
| `search.case-insensitive`                       | case-flipped token matches the same set (unresolved if the backend is case-sensitive)                                                      | searchable field with a letter                                       | `q-narrows`                             |
| `search.empty-q`                                | `q=` is ignore / match-all / reject as declared                                                                                            | `searchEmpty` set                                                    | `q-narrows`                             |
| `search.mode-accepted`                          | each declared `searchModes` value is <400 on the mode param                                                                                | `searchModes` set and a mode role                                    | —                                       |
| `select.projection-honoured`                    | `select=id,name` does not return undeclared fields                                                                                         | select param                                                         | —                                       |
| `select.requested-fields-present`               | every name in `select=` appears on each returned item                                                                                      | select param; ≥1 selectable field                                    | projection                              |
| `select.unknown-field-rejected`                 | unknown select name is 4xx (`reject`) or dropped (`ignore`)                                                                                | `select.unknown` set                                                 | projection                              |
| `select.nested-honoured`                        | `rel(col)` returns `rel` as an object/array carrying only `col`                                                                            | `select.nested` and a named relation                                 | projection                              |
| `count.consistent-with-returned-page`           | envelope total ≥ rows on this page, and is not zero when the page is not                                                                   | envelope total                                                       | `list.read-after-write`                 |
| `count.matches-filtered-set`                    | filtered total equals the size of the filtered walk                                                                                        | total + a filter                                                     | list, equality                          |
| `query.axes-compose`                            | filter + sort together: filter still holds on the sorted page                                                                              | filterable + sortable                                                | filter + sort foundations               |
| `query.filter-and-select-compose`               | filter + select together                                                                                                                   | filterable + select                                                  | same                                    |
| `query.search-and-filter-compose`               | search + filter together                                                                                                                   | filterable + search                                                  | same                                    |
| `query.filter-sort-select-compose`              | filter + sort + select                                                                                                                     | filter + sort + select                                               | same                                    |
| `query.filter-search-sort-compose`              | filter + search + sort                                                                                                                     | filter + search + sort                                               | same                                    |
| `query.filter-search-select-compose`            | filter + search + select                                                                                                                   | filter + search + select                                             | same                                    |
| `query.sort-and-select-compose`                 | sort + select: order holds; extras dropped; requested fields present                                                                       | sortable + selectable                                                | sort + select                           |
| `query.search-and-select-compose`               | search + select: search membership holds; extras dropped                                                                                   | searchable + selectable                                              | search + select                         |
| `query.search-and-sort-compose`                 | search + sort: search membership holds; remaining rows ordered                                                                             | searchable + sortable                                                | search + sort                           |
| `query.filter-search-sort-select-compose`       | all four: filter ∩ search; order holds; extras dropped                                                                                     | all four axes declared                                               | the triples                             |
| `query.unknown-parameter-consistent`            | an undocumented query parameter is either refused or ignored — it never silently changes the set                                           | a listing + ≥1 record                                                | `pagination.page-walk-covers-set`       |
| `spec.declared-filterable-is-filterable`        | every `x-query.filterable` field actually accepts a filter                                                                                 | `x-query` naming filterable fields                                   | filter foundations                      |
| `spec.declared-sortable-is-sortable`            | every `x-query.sortable` field actually accepts a sort                                                                                     | `x-query` naming sortable fields                                     | sort foundations                        |
| `spec.declared-selectable-is-selectable`        | every `x-query.selectable` field actually accepts a select                                                                                 | `x-query` naming selectable fields                                   | select                                  |
| `tenant.item-not-readable-cross-tenant`         | principal B cannot GET principal A's item                                                                                                  | second principal, different `roots`, and a tagged or inferred tenant | —                                       |
| `tenant.item-not-writable-cross-tenant`         | principal B cannot update or delete principal A's item                                                                                     | second principal in another tenant, create, and update or delete     | `tenant.item-not-readable-cross-tenant` |
| `tenant.denial-does-not-reveal-existence`       | 404 vs 403 (or equivalent) does not distinguish "exists other tenant" from "missing"                                                       | second principal, and a tagged or inferred tenant                    | `tenant.item-not-readable-cross-tenant` |
| `tenant.filter-does-not-bypass-scope`           | `filter=id.eq.<other tenant>` does not return that row                                                                                     | second principal, a filter, and a tagged or inferred tenant          | `query.filter-selects-from-whole-set`   |
| `tenant.parent-not-reachable-from-another-root` | a nested collection does not accept another tenant's parent under the caller's own tenant                                                  | second tenant, a collection nested below the tenant                  | `tenant.item-not-readable-cross-tenant` |
| `auth.rank-is-monotonic`                        | a lower rank cannot do what a higher rank is denied                                                                                        | two same-tenant principals at different `rank`                       | `list.read-after-write`                 |
| `auth.rank-is-monotonic-on-writes`              | a lower rank cannot create, update or delete where a higher rank is denied                                                                 | two same-tenant principals at different `rank`, and a create         | `auth.rank-is-monotonic`                |
| `auth.invite-grants-then-revokes`               | invite → accept grants; revoke takes it back                                                                                               | `x-invite` + peer with `inviteAs`                                    | list, cross-tenant                      |
| `create.unique-conflict-rejected`               | a second create colliding a documented unique set is 409, not 2xx; the list does not grow                                                  | `x-unique` with a probeable create body column and a known row       | —                                       |
| `update.unique-conflict-rejected`               | PATCHing a **different** row onto another row's unique-set values is 409, not 2xx                                                          | `x-unique`, update, two known rows; skip all-`x-immutable` sets      | —                                       |
| `patch.immutable-field-rejected`                | PATCHing an `x-immutable` field is rejected or ignored                                                                                     | `x-immutable`                                                        | —                                       |
| `softdelete.absent-from-default-list`           | a soft-deleted row is gone from the default list                                                                                           | `x-soft-delete`                                                      | `list.read-after-write`                 |
| `invalidation.declared-route-changes`           | after a write, the other entity's listed route actually changes                                                                            | `x-invalidate` naming another entity                                 | list, persist                           |
| `effects.declared-effect-occurs`                | `x-effects` cardinality delta is observed on the named list (`count` exact, `min` at-least; nested child lists bind the created parent id) | `x-effects`                                                          | `list.read-after-write`                 |
| `effects.side-effect-arrives`                   | after the write, the named GET’s JSON path is occupied before `timeoutMs`                                                                  | `x-wait`                                                             | `list.read-after-write`                 |
| `async.reaches-terminal-state`                  | `x-async` reaches `until` (poll, or a terminal SSE frame) before `timeoutMs`                                                               | `x-async`                                                            | —                                       |
| `async.receipt-identifies-the-job`              | `idFrom` on the receipt (JSON object or SSE event JSON) resolves to a pollable job                                                         | `x-async` + `idFrom`                                                 | —                                       |
| `patch.minimality`                              | PATCH `{ name }` does not clear other writable fields                                                                                      | update + item route                                                  | —                                       |
| `idempotency.replay-does-not-duplicate`         | same Idempotency-Key + same body does not create a second row                                                                              | create + documented Idempotency-Key header                           | list, persist                           |
| `delete.absent-record-returns-404`              | DELETE of a missing id is 404, not 200                                                                                                     | delete                                                               | —                                       |
| `concurrency.no-lost-update`                    | two PATCHes to different fields do not clobber each other                                                                                  | update + two writable strings                                        | persist + patch                         |
| `validation.enum-enforced`                      | a value outside the enum is rejected                                                                                                       | enum in the request schema                                           | —                                       |
| `validation.max-length-enforced`                | a string over `maxLength` is rejected                                                                                                      | maxLength                                                            | —                                       |
| `validation.required-enforced`                  | omitting a required field is rejected                                                                                                      | required field                                                       | —                                       |
| `validation.content-type-enforced`              | a wrong Content-Type is 415 when 415 is documented                                                                                         | documented 415                                                       | —                                       |
| `spec.declared-rate-limit-is-honoured`          | no 429 arrives while oat paces under the rate `x-rate-limit` declares                                                                      | `x-rate-limit` with a rate                                           | —                                       |
| `consistency.projections-agree`                 | list, item, and filtered views of the same field agree                                                                                     | item route + a comparable field                                      | list + persist + filter                 |

On a typical untagged CRUD document (create, list, item, `page`/`limit`, maybe `sort`):

- Foundations, PATCH/delete, and schema checks usually run.
- The query matrix runs when filter/order/select/search roles resolve.
- Isolation runs only if you configured two principals.
- Spec-as-adversary and tagged behaviour never run — `doctor` says so.

Worked examples of what a finding looks like:

```text
BACKEND_BUG   table   created row missing from GET /tables
              list.read-after-write

BACKEND_BUG   product  PATCH { name } cleared description
              patch.minimality

SECURITY      table    GET /tables/{id} readable with the other tenant's key
              tenant.item-not-readable-cross-tenant

SPEC_BUG      table    x-query.filterable lists "ghost"; filter=ghost.eq.x is 400
              spec.declared-filterable-is-filterable

BACKEND_BUG   table    in() is not the union of the equalities it lists
              filter.in-is-union-of-eq

BACKEND_BUG   table    an illegal filter operator is accepted
              filter.illegal-op-rejected

COVERAGE_GAP  batch    no x-async; receipt treated as the result
              async.reaches-terminal-state
```

## Verdicts, skips, and exit codes

| verdict        | meaning                                                              | fails `oat run`? |
| -------------- | -------------------------------------------------------------------- | ---------------- |
| `BACKEND_BUG`  | the handler is wrong                                                 | yes              |
| `SPEC_BUG`     | the document is wrong (or disagrees with the handler)                | yes              |
| `SECURITY`     | isolation/authz failure and `x-tenant` (or equivalent) was declared  | yes              |
| `AMBIGUITY`    | same evidence, but the tenant boundary was only inferred             | yes              |
| `COVERAGE_GAP` | the check could not run; the report names the missing tag or surface | no               |
| `BLOCKED`      | a check this one depends on already failed                           | no               |

Separate from findings:

- **did not apply** — entity never had what `needs` lists (printed in the report, not a pass). Example: no `select` parameter → `select.projection-honoured` did not apply.
- **inconclusive** — the check ran and stopped (empty listing, probe 4xx, no shared filterable field, …). Not a pass. The report prints the reason.

Coverage is split **never** (zero entities could run it) vs **partial** (ran on some entities, skipped on others). A clean run still prints both. "Nothing found" and "nothing was looked for" are different.

Cascade suppression is transitive: one root cause is one finding, not a page of consequences. A blocked check has **not** been verified; re-run after the cause is fixed.

`oat run` exit `1` if any finding has a failing verdict. Gaps and blocked entries do not fail a full run. A targeted run (`--ops`) also exits `1` when any target did not end `held`.

Console (stdout) after a run:

```
  50 checks · 5 entities · 842 requests · 41.2s · p95 90ms · 4 checks did not apply

  BACKEND DEFECTS (1)
    product          PATCH { name } also cleared description
                     patch.minimality

  DID NOT APPLY — no entity had what these need
    async.reaches-terminal-state             needs an operation declaring x-async

  leftover teardown printed next
  report / matrix / graph / progress paths
```
