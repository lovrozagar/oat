# oat — Assumptions

[← back to the overview](../README.md)

oat tests a backend against its own document, and where the document is silent it has to assume
something. This page lists every such assumption, what oat does when an API does not fit it, and
how to declare the exception. An assumption that does not hold should never become a false
finding: it should become a skip, an inconclusive verdict or a coverage gap that names the tag that
would settle it. If one of these produces a finding against a correct backend, that is an oat bug.

## Shape of the API

| oat assumes                                                                                              | when it does not hold                                                                                                                                       | declare                                                                                                         |
| -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| A resource is a noun in the path: `/tables`, `/tables/{id}`                                              | the operation is untracked; `doctor` names the gap                                                                                                          | [`x-entity`](tags.md#x-entity) `{ name, action }`                                                               |
| An instance is identified by `id`, `uuid`, `slug`, `key` or `name`, or by the trailing path parameter    | the entity is not trackable, and checks that need a record stand down                                                                                       | `x-entity.identity`                                                                                             |
| A single-record answer is the record, or wraps it in `data` / `item` / `result` / `record` (create only) | fields are compared against the wrong object, or an update's `{ success, id }` reads as every field dropped                                                 | [`x-entity.recordPath`](tags.md#x-entity) per operation                                                         |
| A list's rows are its one array of objects                                                               | with two (`data` beside `fields`) the list is not treated as a collection; `doctor` names the gap                                                           | `x-entity.recordPath` on the list (`$.data`)                                                                    |
| Creating is `POST` to the collection, and the response carries the created record                        | the cohort cannot be seeded; dependent checks are blocked                                                                                                   | [`x-async`](tags.md#x-async) for a receipt, `x-entity` for a create elsewhere                                   |
| A create that answers without the record (`{ success: true }`) kept the id the client chose              | the record is not tracked: oat leaves it behind rather than delete an id it only sent                                                                       | an item read (`x-entity` action `read`): oat tracks the id once that read shows it with every submitted field   |
| An identifier looks like the identity: an integer, a uuid, or a token (`oat-absent-…`) for a bare string | a probe for a record that does not exist is answered 400 for its format, not 404; one that cannot meet a string identity's pattern or length does not apply | type the route parameter, or the identity property (it wins over a route parameter documented as a bare string) |
| A client-chosen identity names no record the collection already holds                                    | oat avoids every listed id and every id its own records hold; with no free id left, the create is not sent and the check reports a gap                      | `x-unique` on the identity, so a duplicate id is a graded 409                                                   |
| A record oat created can be deleted by its item route                                                    | teardown reports what it left behind                                                                                                                        | [`x-cleanup`](tags.md#x-cleanup)                                                                                |
| Path parameters oat cannot create are supplied                                                           | the entity cannot be reached                                                                                                                                | [`x-root`](tags.md#x-root), or `roots` in the config                                                            |
| A list answers with an array, or an object holding one                                                   | list checks stand down                                                                                                                                      | the collection schema                                                                                           |

## Lists and paging

| oat assumes                                                                                                                                                                          | when it does not hold                                              | declare                                                                     |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| Paging parameters carry recognisable names (`limit`, `page`, `offset`, `cursor`, …)                                                                                                  | the role is unresolved and the paging checks do not apply          | the parameter's name or default, or [`x-query`](tags.md#x-query) `maxLimit` |
| A set has ended when a page is empty, shorter than a full page already seen, or the envelope says so — and, when the envelope carries both a total and a more-pages flag, they agree | oat keeps reading; it never takes the requested page size as proof | nothing: a server may serve fewer rows than asked for                       |
| A server pages by one mechanism consistently                                                                                                                                         | a read that sees pages repeat stops and is unresolved              | —                                                                           |
| A set larger than 500 records is too large to compare whole                                                                                                                          | checks that need the whole set are unresolved, not failed          | smaller cohorts, or a filtered scope                                        |

## Queries

| oat assumes                                                                                                                                       | when it does not hold                                                                                | declare                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Filtering is written in a grammar the document demonstrates (PostgREST, colon, equality), or one declared as a template                           | filter checks do not apply; a free-text filter whose grammar is not recognised gets no terms         | `x-query.grammar` (preset or template), config `query.grammar` |
| Sorting is written in a grammar the document demonstrates (dotted, prefixed, colon, spaced), or one declared as a template                        | the inferred grammar is used                                                                         | `x-query.sortGrammar`, config `query.sortGrammar`              |
| Unknown operators, sort directions and malformed terms are probed only on a declared grammar                                                      | those checks do not apply                                                                            | `x-query.grammar` / `sortGrammar`                              |
| Without `x-query`, every scalar property can be filtered, sorted and selected                                                                     | probes reach fields the backend never indexed; findings name the guess                               | `x-query` `filterable` / `sortable` / `selectable`             |
| A declared operator is accepted for a value of the field's own type                                                                               | —                                                                                                    | per-field `ops` and `type` in `x-query`                        |
| Only 400 and 422 mean "this capability is not supported"                                                                                          | 401, 403, 404 and 429 leave the check unresolved; a 5xx is a finding                                 | —                                                              |
| A free-text search parameter is named `q`, `search`, `query_text`, `term`, `keyword`, `text`, or `searchTerm` / `search_term`                     | search checks do not apply                                                                           | `x-query.searchable`                                           |
| Paging is by page number, by rows skipped (`offset`, `skip`, `start`, `from`) or by cursor; a total alone (`totalCount`) is enough to stop a walk | paging checks do not apply                                                                           | —                                                              |
| A page size of 0 or past the maximum may be refused or clamped                                                                                    | the out-of-range check does not apply                                                                | `x-query.limitOutOfRange: reject`                              |
| A create answers the record, or wraps it under `data` / `item` / `result` / `record` beside an id                                                 | the record is the object holding what was sent; its identity comes from it or from the envelope's id | —                                                              |
| An alias of an allowed operator is allowed                                                                                                        | —                                                                                                    | `x-query.aliases`                                              |

## Ordering

| oat assumes                                                                                                     | when it does not hold                                | declare                    |
| --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- | -------------------------- |
| Numbers sort numerically                                                                                        | `sort.numeric-order-is-numeric` reports text order   | —                          |
| Text sorts by one consistent collation — binary, case-insensitive or locale — whichever the backend shows first | a sequence sorted under none of them is a finding    | `x-query.sortCollation`    |
| Nulls sit together at one end, the same end every time                                                          | nulls in the middle, or switching ends, is a finding | `x-query.sortDefaultNulls` |
| Descending is ascending reversed, up to ties                                                                    | —                                                    | —                          |
| Tied records may come back in any order unless a tiebreak is declared                                           | —                                                    | `x-query.stableTiebreak`   |

## Writes

| oat assumes                                                           | when it does not hold                              | declare                                                          |
| --------------------------------------------------------------------- | -------------------------------------------------- | ---------------------------------------------------------------- |
| `PATCH` changes only the fields it names                              | the minimality and lost-update checks report it    | —                                                                |
| `PUT` replaces the whole record                                       | partial-update checks stand down on a PUT-only API | the update operation's method                                    |
| A field the server owns is marked `readOnly` or generated             | oat would try to write it                          | `readOnly`, or [`x-generated`](tags.md#x-immutable--x-generated) |
| A field that must never change after create is declared               | not tested                                         | [`x-immutable`](tags.md#x-immutable--x-generated)                |
| A `writeOnly` field is accepted and not returned                      | —                                                  | `writeOnly`                                                      |
| A header named like `Idempotency-Key` promises replay                 | the replay check does not apply                    | the header's name                                                |
| A unique column set is declared, and a duplicate is refused with 409  | —                                                  | [`x-unique`](tags.md#x-unique)                                   |
| A deleted record leaves the default listing, unless it is a tombstone | —                                                  | [`x-soft-delete`](tags.md#x-soft-delete)                         |

## Errors and statuses

| oat assumes                                                                                                  | when it does not hold                                                              | declare                                    |
| ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- | ------------------------------------------ |
| A refusal of invalid input is 400 or 422; of a wrong content type, 415 (when documented); of a conflict, 409 | any other refusal leaves the check unresolved                                      | —                                          |
| A 5xx is never the right answer to bad input                                                                 | it is a finding                                                                    | —                                          |
| Every status an operation returns is documented, ranges (`2XX`) and `default` included                       | the status check reports the gap, apart from what deliberately invalid probes drew | the response                               |
| A documented feature gate answers 403 with `vars.type: feature_gate`                                         | the 403 is a backend failure                                                       | [`x-feature-gate`](tags.md#x-feature-gate) |

## Isolation and authorization

| oat assumes                                                             | when it does not hold                                                             | declare                                                |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------ |
| A second principal with different `roots` is another tenant             | isolation checks do not apply                                                     | `principals`                                           |
| The tenant is a path parameter, or declared                             | an inferred tenant makes a cross-tenant read an ambiguity, not a security finding | [`x-tenant`](tags.md#x-tenant)                         |
| A denial does not depend on whether the record exists                   | —                                                                                 | —                                                      |
| Higher `rank` can do everything a lower rank can                        | a lower rank seeing more is a finding                                             | `rank` on principals                                   |
| An invite grants nothing until accepted, and a revoke takes access away | —                                                                                 | [`x-invite`](tags.md#x-invite) and a peer's `inviteAs` |

## Async work, effects and pacing

| oat assumes                                                                          | when it does not hold                                                    | declare                                                                  |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| A write is complete when it answers                                                  | —                                                                        | [`x-async`](tags.md#x-async), [`x-wait`](tags.md#x-wait)                 |
| A write affects only its own entity and the routes it declares                       | other entities' changes are not tested                                   | [`x-invalidate`](tags.md#x-invalidate), [`x-effects`](tags.md#x-effects) |
| Entities that share no parent, invalidated route or effect cannot observe each other | they are tested side by side                                             | the shared relation, declared                                            |
| A rate the document declares is the rate the backend enforces                        | a 429 under it is a finding; a config-supplied rate is only paced around | [`x-rate-limit`](tags.md#x-rate-limit--pacing-oats-own-traffic)          |

## What oat never assumes

- That your data has a ground truth. Every oracle compares the API with itself.
- That the requested page size is the size served.
- That a field absent from the cohort cannot exist: a declared field is probed with a value of its
  own type.
- That an unanswered question is a pass: a check that cannot conclude says why, and a check that
  does not apply says what it needs.
