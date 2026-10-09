# oat — How oat reads a document

[← back to the overview](../README.md)

## How the model is derived

`oat plan` is this model. Checks never see raw paths; they see entities, actions, and query **roles**.

### Entity name and action

**Explicit:** `x-entity: { name, action, identity? }` on the operation.

**Heuristic** (when the tag is absent):

1. Split the path on `/`. Ignore `{param}` segments.
2. The last non-parameter segment is the noun. `v1` / `v2` / `vN` is never a noun.
3. Singularise that noun (`stores` → `store`, `batches` → `batch`). Irregulars include `people→person`, `categories→category`, `campuses→campus`, `statuses→status`, `children→child`, `companies→company`, `addresses→address`, `indices→index`, `queries→query`, `properties→property`, `entities→entity`, `inboxes→inbox`. Endings `us|ss|is|os|as|ics|ews|ess|ous|sis` are left alone (`status` stays `status`).
4. If a non-parameter segment follows the noun (`/rows/aggregate`, `/tables/{id}/restore`), action is `action`.
5. Otherwise: `GET` collection → `list`, `GET` item → `read`, `POST` collection → `create`, `POST` item → `action`, `PUT`/`PATCH` → `update`, `DELETE` → `delete`.

If no noun can be found, the operation is untracked and `doctor` records an `x-entity` gap.

`--only` and report entity names are these singular names.

### Identity

`x-entity.identity` wins. Else the first of `id`, `uuid`, `slug`, `key`, `name` that is **required** on the item schema, else the first of those that exists, else the trailing path-param suffix (`{table_id}` → `id`). Without an identity the entity is not trackable.

### Read surface

The set of `GET` routes through which an instance is visible.

- Declared: every `"METHOD /path"` in any `x-invalidate` that refers to this entity.
- Inferred: sibling collection and item routes on the same path prefix as a mutator.

`invalidation.declared-route-changes` only runs when a mutator's `x-invalidate` names **another** entity's route.

### Generated / immutable / soft-delete / tenant

See [OpenAPI meta tags](tags.md#openapi-meta-tags). Fallbacks:

- `readOnly: true` counts as generated (omitted from create bodies).
- No immutability testing without `x-immutable`.
- Tenant param: `x-tenant` or a path param matching `org|organization|tenant|workspace|account|project|app` + optional `_id`/`_slug`. Inferred tenants make a cross-tenant read `AMBIGUITY`, not `SECURITY`. With neither a tag nor an inferred name, the check does not apply.

### Idempotency

No meta tag. If create declares a header matching `Idempotency-Key` / `Idempotence-Key` / `X-Idempotency-Key` (spaces ignored, case-insensitive), `idempotency.replay-does-not-duplicate` runs.

## Seeding

Per entity, oat POSTs the create body built from the request schema (JSON, multipart, or urlencoded).

Default cohort is **7** records, one of each variant, sliced by `cohortSize`:

| variant         | what it is for                                     |
| --------------- | -------------------------------------------------- |
| `baseline`      | `"Quarterly Report N"`                             |
| `lexical-first` | sorts first (`"aaa first alphabetically"`)         |
| `lexical-last`  | sorts last (`"zzz last alphabetically"`)           |
| `null-heavy`    | `null` on every nullable field                     |
| `unicode`       | `"äöüß čćžšđ 日本語 中文 한글 привет مرحبا 🙂"`    |
| `metacharacter` | `"100% _off_ *everything*"` — LIKE / escape probes |
| `boundary`      | empty / maxLength / numeric `maximum`              |

Numbers use the ladder `1, 2, 5, 10, 20, 50, 100` so **lexical order ≠ numeric order** (otherwise a TEXT compare looks correct). Enums walk `index % enum.length`. `readOnly` / `x-generated` fields are omitted. Required fields that cannot be generated get a type fallback (`0`, `false`, `[]`, `{}`, `"value"`). Arrays honour `minItems` (never send `[]` when `minItems ≥ 1`). Nested objects stop at depth 4.

Empty schemas (`{}`, `true`, `additionalProperties: {}`) and cyclic `$ref`s after inlining stop the walk — they become a scalar or `{}`, never another object descent. A `RangeError` during generation is a `COVERAGE_GAP` on that entity naming the operationId and JSON pointer (`fixture generation overflow on table.create (/)`), not `blocked by unknown`.

String fields honour `format`, `pattern`, and `minLength` together: `email` → `oat-{variant}-{index}@example.test`, `uri` / `url` → `https://example.test/...`, `uuid` → a fixed-shape UUID, `pattern` → a string that matches (or the field is omitted / the entity is a gap). A generated string is padded to `minLength` (repeat the last character) without breaking `pattern`. `"Quarterly Report N"` is only used when the document does not constrain the string. `minLength` greater than `maxLength` omits an optional field and records `missingRequired` on a required one.

An operation with `x-invite` is not `entity.create`. oat does not POST a generated invitee. The invite check sends `granteeField` = the peer's `inviteAs`. Missing `inviteAs` is a coverage gap naming the tag.

A create whose `operationId` appears in any principal `auth.steps`, or that declares `x-fresh-principal`, is not seeded. Those rows were provisioned by the auth flow.

Parent path parameters are created first (depth-first through the owning entity's create). Config / principal `roots` fill parameters oat cannot create.

A create that returns `>= 300` on the first variant fails the entity (downstream checks `BLOCKED`). Later variants that fail just shorten the cohort — a partial cohort is still used.

HTTP 429 is retried first — `Retry-After` or exponential backoff, up to five times — on seed, checks, and teardown, whether or not the operation declared `x-rate-limit`. The first 429 is never a seed failure. A leftover 429 after those retries is a gap, not a backend defect.

A 402 / plan-limit (`payment_required`, `*_plan_limit`) on create is not a backend defect when the same-tenant list already has a row — typically an earlier `x-effects` create that filled a free-plan quota. oat reuses that id so children (a `row` after extract created a `table`) can still seed. It does not invent records. Write-path checks on the adopted entity stand down.

A documented feature-gate 403 is the exception: if create declares `x-feature-gate` and the body is `vars.type: feature_gate` (and `vars.feature` matches the tag when present), oat records a `COVERAGE_GAP` naming the tag rather than a seed defect. See [`x-feature-gate`](tags.md#x-feature-gate).

When create is tagged `x-unique`, a first-variant seed **409** with a nonempty same-tenant list **adopts** that row (`world.seed` `COVERAGE_GAP` naming `x-unique` — the create could not insert). Unique-conflict checks still run against that row. Write-path oracles that need a body oat submitted stay skipped. 409 with an empty list stays `BLOCKED` (`could not seed`). A 409 without the tag is still today's seed failure. The seed 409 itself is not `create.unique-conflict-rejected` passing — that check is the explicit second POST. See [`x-unique`](tags.md#x-unique). Later variants that 409 only shorten the cohort. Generated values for unique body columns differ across variants (a suffix) without weakening `maxLength` / `pattern`; if the document cannot express two distinct values, oat records a gap and skips extra variants.

`--seed` / `seed` makes the bodies identical across runs. It does not make server-assigned ids identical.

Teardown DELETEs created rows (or the `x-cleanup` route) newest-first. Failures and missing delete routes are printed as leftovers, not as check findings. `keepFixtures: true` skips this.

## Query roles and grammars

Checks do not look for a parameter _named_ `filter`. They resolve **roles** from aliases, then write values in the grammar the document demonstrates.

| role              | aliases (normalised: case, `_` / `-`, `perPage` → `per_page`)                       |
| ----------------- | ----------------------------------------------------------------------------------- |
| filter            | `filter`, `where`, `query`, `conditions`                                            |
| order             | `order`, `order_by`, `sort`, `sort_by`, `ordering`                                  |
| select            | `select`, `fields`, `field`, `include_fields`, `projection`, `only`                 |
| search            | `q`, `search`, `query_text`, `term`, `keyword`, `text`                              |
| search mode       | `search_mode`, `searchmode`, `search_type`, `mode` (only if a search role exists)   |
| limit (page size) | `limit`, `per_page`, `page_size`, `pagesize`, `count`, `max_results`, `top`, `size` |
| page              | `page`, `page_number`, `pagenum`, `p`                                               |
| offset            | `offset`, `skip`, `start`, `from`                                                   |
| cursor            | `cursor`, `after`, `starting_after`, `next`, `page_token`, `continuation`           |

A bracketed suffix is a _value_ in the name (`fields[articles]`, `filter[status]`), not part of the role. `count` is a page size only when it looks like one (has `maximum` or a default); otherwise it is treated as a total.

A bounded integer with a default that matches no alias is still taken as page size. A 1-based integer with no maximum is taken as page number.

**Filter grammars** — how oat **writes** a term:

| name        | example                                                                                              | `and` / `or`                       |
| ----------- | ---------------------------------------------------------------------------------------------------- | ---------------------------------- |
| `postgrest` | `status.eq.active`, `name.neq.x`, `id.in.(a,b)`, `name.ilike.FOO`, `note.is.null`, `tags.contains.x` | `and(a.eq.1,b.eq.2)`, `or(...)`    |
| `colon`     | `filter=status=eq:active` (comma-joined terms; no grouping)                                          | not expressible; those checks skip |
| `equality`  | `?status=active` (one query param per field). Only `eq` is expressible                               | not expressible                    |

Operators the **postgrest** writer can emit: `eq`, `ne`, `neq`, `gt`, `gte`, `lt`, `lte`, `in`, `nin`, `like`, `ilike`, `is`, `contains`. Colon stays on `eq` / `neq` / `gt` / `gte` / `lt` / `lte` / `like`. Equality is `eq` only. Anything a grammar cannot write becomes **did not apply**, not a failed request.

A check that needs `in`, `ilike`, `is`, `contains`, a search mode, or `nullsfirst` / `nullslast` also needs that capability **declared**. oat does not infer new operators, modes, or nulls tokens onto an API that never listed them.

**Sort grammars:** `name.asc` (dotted), `-name` (prefixed / JSON:API; ascending is the bare name), `name:asc` (colon), `name asc` (spaced). Dotted (PostgREST-shaped) can also emit `name.asc.nullsfirst` / `name.desc.nullslast` when the capability map allows that token. Colon / prefixed / spaced stay as they are.

**Select grammars:** `id,name` (csv) or `fields[table]=id,name` (bracketed). If the parameter is already named `fields[articles]`, that name is used verbatim.

### How a grammar is inferred

`x-query.grammar` wins when it is `postgrest` | `colon` | `equality`.

Otherwise oat concatenates the filter/order/select parameter's `example`, `examples`, and `description`:

- Filter: `/postgrest/i` or `field.op.value` / `status.eq.active` → `postgrest`; `status=eq:` → `colon`; else `equality`. A free-text `filter` string that still looks like equality produces an `x-query` gap telling you to declare the grammar.
- Sort: `name.asc` → dotted; `name:desc` → colon; `name desc` → spaced; leading `-field` → prefixed; else dotted.
- Select: parameter name or description contains `fields[…]` → bracketed; else csv.

Without `x-query`, if a filter/order/select/search role resolves, oat assumes **every scalar** is filterable/sortable/selectable (`string` / `number` / `integer` / `boolean`, including nullable unions). Searchable-without-tag is further narrowed to names matching `name|title|slug|label|description|email`. `doctor` warns. Pagination-only lists stay uncovered.

That heuristic runs **only** for an axis that was not tagged and not set in config. An explicit empty claim — `filterable: []`, `searchable: null`, `selectable: []`, `sortable: []` — is a claim of none. oat will not infer scalars over it.

Searchable / filterable / sortable / selectable from the tag are used as given. `maxLimit` is also taken from a page-size parameter's `schema.maximum` when the tag omits it.

### Declared or skip

Every list check consults one **effective capability map** per entity. Precedence, unchanged in spirit:

| order | source                          | what it contributes                                                                                  |
| ----- | ------------------------------- | ---------------------------------------------------------------------------------------------------- |
| 1     | `x-query` on the list operation | fields, structured rows, operators, modes, caps, harvest                                             |
| 2     | `config.entities[name].query`   | union of fields; overlay of ops / modes / caps                                                       |
| 3     | `config.query`                  | global defaults for the same keys                                                                    |
| 4     | heuristic                       | today's scalars / name-regex searchable — **only if that axis was not tagged and not set in config** |
| 5     | skip                            | the check does not apply                                                                             |

`hooks.resolveQueryCapabilities` runs after 1–3 (and after any `*From` harvest) and may add or replace any axis. Return `null` to keep the merge. Called once per entity after seed, with the seeded parent scope so a follow-up GET can run.

Missing capability → the check does not apply / unresolved. Never `BACKEND_BUG` for an undeclared op, mode, or nulls option.

## Pagination and envelopes

Three page models, all first-class:

- **Page number** (`page` + `limit` roles).
- **Offset** (`offset` + `limit`). Checks that say "page 3" translate to `offset = (page - 1) * size` (size defaults to 20 only for that translation).
- **Cursor** (`cursor` role + envelope `nextCursor` or a `Link: rel=next` header).

`hasMore` is taken from the body (`hasMore`, `has_more`, `hasNextPage`, `more`) **or** from a documented `Link` response header. Under Link pagination, **absence** of `rel="next"` means no more pages.

Collection shape is derived from the success JSON schema, not from hardcoded wrapper names:

- Response `type: array` → the body is the list (`key: null`).
- Otherwise the array property whose items are objects, skipping sidecar names `error(s)`, `warning(s)`, `message(s)`, `meta`, `links`. Resource-named envelopes (`{ tables: [...] }`) work.
- Sibling keys become envelope fields:

| role       | accepted property names                                     |
| ---------- | ----------------------------------------------------------- |
| total      | `count`, `total`, `totalCount`, `total_count`, `totalItems` |
| hasMore    | `hasMore`, `has_more`, `hasNextPage`, `more`                |
| nextCursor | `nextCursor`, `next_cursor`, `cursor`, `next`, `endCursor`  |
| page       | `page`, `pageNumber`, `page_number`, `offset`               |
| limit      | `limit`, `perPage`, `per_page`, `pageSize`, `page_size`     |

Success schema is the first JSON media type on responses `200`, `201`, `202`, `2XX`, or `default`. Request schema is taken from `requestBody` preferring `multipart/form-data`, then `application/x-www-form-urlencoded`, then JSON. A success response that lists `text/event-stream` is a stream: oat consumes it to the end and does not treat the raw body as a JSON schema defect. Media type is the stream tag — there is no `x-stream`.
