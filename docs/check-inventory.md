# Check inventory

What each of the 55 checks needs, versus what an untagged OpenAPI document typically
provides. Dated 2026-08-13. Source: `needs` / `applicable` in `src/runtime/checks.ts`,
plus `readQueryCapability` in `src/spec/extensions.ts`.

This is ROADMAP task **R1**.

## How query capability is inferred

If `x-query` is absent, oat builds a query capability when any of the filter / order /
select / search *roles* resolve, using the same aliases as the checks (`sort`, `fields`,
`q`, `where`, …). Page size (`per_page`, `size`, …) supplies `maxLimit` from its
declared `maximum`. Then it assumes **every scalar property** is filterable, sortable,
and selectable.

Consequences:

- An untagged `?status=active&page=2` API (`plain`) still gets **no** inferred
  `x-query`: pagination and a per-field equality param are not a query grammar.
  Most filter checks stand down. That is honest.
- An untagged API that spells sort as `sort` and projection as `fields` now gets the
  same inferred capability as one that says `order`/`select`. That was the product-path
  hole the floors were already catching in the fixture.
- An untagged API that does expose those roles still has the opposite problem: every
  scalar is probed, including columns the backend never indexed. Doctor warns about
  this; the checks still fire. Spec-adversary checks still require the tag.

`spec.declared-*-is-*` require `query.source === "tag"`. They never run on an
untagged document. That is correct.

## What “fully testable” means today

`doctor` counts an entity as fully testable when it has an identity and at least one
read surface. A read surface can be the **item** route alone. Petstore therefore
reports 3/3 fully testable with **no list operation** on any entity — which means
almost none of the query matrix can run. The bar is too low. Track A should fix the
sentence; do not lower the fixture floors to match it.

## Groups

| Group | Count | Untagged CRUD (create + list + item, no `x-*`) | Notes |
| --- | --- | --- | --- |
| Foundations (write landed, schema, page size) | 8 | usually run | Need create and/or list. `pagination.limit-bounds-page-size` needs a page-size *role*, despite a `needs` string that still says “named `limit`”. |
| Query, single axis | 16 | only if filter/order/select/search roles resolve | Same aliases as the checks. |
| Query, composition (pairs + triples) | 6 | same as single axis | Stand down as a cascade when a pair they depend on is broken or inapplicable. |
| Spec-as-adversary (`x-query` claims) | 3 | **never** | Require the tag. |
| Isolation (two principals) | 3 | only with a second principal in config | Document tags change *verdict* (`SECURITY` vs `AMBIGUITY`), not whether they run. |
| Authorization | 2 | rank: config lattice; invite: **never** | `auth.rank-is-monotonic` needs same-tenant ranks; invite needs `x-invite` + `inviteAs`. |
| Tagged behaviour | 6 | **never** | `x-immutable`, `x-soft-delete`, `x-invalidate`, `x-effects`, `x-async` (×2). |
| Validation / schema | 7 | if the request/response schema has the constraint | Enum, maxLength, required, content-type, error schema, success schema, numeric compare. |
| Other writes | 4 | usually run | PATCH minimality, idempotency header, delete 404, lost update. |

55 = 8 + 16 + 6 + 3 + 3 + 2 + 6 + 7 + 4.

## Per-check

Needs are the check’s own `needs` string. “Untagged?” is whether a typical untagged
CRUD list+item+create document can satisfy `applicable`, assuming the heuristic
fired (a filter/order/select/search role resolved).

### Foundations

| id | needs | untagged? |
| --- | --- | --- |
| `list.read-after-write` | create + a seeded record | yes |
| `create.persists-submitted-fields` | create that echoes the record | yes |
| `create.status-matches-document` | create | yes |
| `schema.success-response-matches-document` | success schema on create | yes, if schema exists |
| `schema.error-response-matches-document` | error schema on the item route | yes, if schema exists |
| `pagination.limit-bounds-page-size` | page-size role | yes, if a limit-like param resolves |
| `pagination.limit-respects-documented-max` | declared maxLimit and a larger cohort | only if `maximum` is on the limit param |
| `pagination.has-more-is-accurate` | page-forward + a more-pages signal | yes, if `hasMore` or `Link rel=next` |

### Query — single axis

| id | needs | untagged? |
| --- | --- | --- |
| `filter.unknown-field-rejected` | a filter *expression* | no on per-field equality |
| `filter.equality-selects-exactly-one` | equality on the identity field | if filterable |
| `filter.zero-match-returns-none` | same | if filterable |
| `filter.negation-partitions-the-set` | eq and neq | no on equality-only grammars |
| `filter.and-composes-as-intersection` | two filterable fields | if grammar can AND |
| `filter.or-composes-as-union` | `or()` combinator | **postgrest grammar only** |
| `filter.like-metacharacters-escaped` | like operator | no on equality-only |
| `filter.numeric-comparison-is-numeric` | numeric field + a filter param | no on equality-only |
| `sort.reverse-symmetry` | order + asc/desc | if order resolves |
| `sort.order-is-applied` | order + a sortable field | if order resolves |
| `search.q-narrows-result` | search param + searchable fields | if `q`/`search` resolves |
| `select.projection-honoured` | select param | if select resolves |
| `pagination.page-walk-covers-set` | page or offset + ≥3 records | yes |
| `pagination.cursor-agrees-with-page` | both cursor and page | rare outside postgrest-shaped docs |
| `count.consistent-with-returned-page` | envelope total | if a count key resolves |
| `count.matches-filtered-set` | total + a filter | if both resolve |
| `error.malformed-filter-not-5xx` | a filter expression | no on equality-only |
| `query.filter-selects-from-whole-set` | filterable + ≥3 records | if filterable |

### Query — composition

| id | needs | untagged? |
| --- | --- | --- |
| `query.axes-compose` | filterable + sortable | if both resolve |
| `query.filter-and-select-compose` | filterable + select | if both resolve |
| `query.search-and-filter-compose` | filterable + search | if both resolve |
| `query.filter-sort-select-compose` | filter + sort + select | if all three resolve |
| `query.filter-search-sort-compose` | filter + search + sort | if all three resolve |
| `query.filter-search-select-compose` | filter + search + select | if all three resolve |

### Spec-as-adversary

| id | needs | untagged? |
| --- | --- | --- |
| `spec.declared-filterable-is-filterable` | `x-query` naming filterable fields | **no** |
| `spec.declared-sortable-is-sortable` | `x-query` naming sortable fields | **no** |
| `spec.declared-selectable-is-selectable` | `x-query` naming selectable fields | **no** |

### Isolation

| id | needs | untagged? |
| --- | --- | --- |
| `tenant.item-not-readable-cross-tenant` | second principal | config, not spec |
| `tenant.denial-does-not-reveal-existence` | second principal | config |
| `tenant.filter-does-not-bypass-scope` | second principal + a filter | config + filterable |

Without `x-tenant`, a cross-tenant read is `AMBIGUITY`, not `SECURITY`.

### Authorization

| id | needs | untagged? |
| --- | --- | --- |
| `auth.rank-is-monotonic` | two same-tenant principals with ranks | config, not spec |
| `auth.invite-grants-then-revokes` | `x-invite` + peer with `inviteAs` | **no** |

### Tagged only

| id | needs | untagged? |
| --- | --- | --- |
| `patch.immutable-field-rejected` | `x-immutable` | no |
| `softdelete.absent-from-default-list` | `x-soft-delete` | no |
| `invalidation.declared-route-changes` | `x-invalidate` naming another entity | no |
| `effects.declared-effect-occurs` | `x-effects` | no |
| `async.reaches-terminal-state` | `x-async` | no |
| `async.receipt-identifies-the-job` | `x-async` + `idFrom` | no |

### Validation and remaining writes

| id | needs | untagged? |
| --- | --- | --- |
| `patch.minimality` | update + item route | yes |
| `idempotency.replay-does-not-duplicate` | create + Idempotency-Key header | if the header is documented |
| `delete.absent-record-returns-404` | delete | yes |
| `concurrency.no-lost-update` | update + two writable strings | yes |
| `validation.enum-enforced` | enum in the request schema | if present |
| `validation.max-length-enforced` | maxLength | if present |
| `validation.required-enforced` | required field | if present |
| `validation.content-type-enforced` | documented 415 | often absent → stands down |

## What this implies for the adoption bar

On a **typical untagged CRUD OpenAPI** (create, list, item, `page`/`limit`, maybe
`sort`, no `x-*`):

- Foundations, PATCH/delete, and schema checks can run.
- The query matrix runs when filter/order/select/search roles resolve from aliases.
  It still stands down on pagination-only lists.
- Isolation runs only if the user configured two principals.
- Spec-as-adversary and tagged behaviour never run — and doctor already says so
  for the tagged set.

So oat today is **(b)** in ROADMAP A4: useful once roles resolve, and sharper once
tags are present. It is not yet **(a)** “useful on any untagged CRUD document,”
because an untagged list still probes every scalar and spec-adversary checks need
the tag.

Petstore (R2) is the extreme: modelled as testable, no list, query matrix silent.
Anyrow’s published spec is closer to (b): lists exist, `filter`/`order`/`q`/`select`
are present, `x-query` is not, so doctor warns about probing every scalar.
