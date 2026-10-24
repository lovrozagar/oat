# oat — How oat reads a document

[← back to the overview](../README.md)

## How a run works

1. **Load** the OpenAPI document (URL or path). Internal `$ref`s are inlined, and a file's relative `$ref`s to files in its own folder are read in. URL `$ref`s are reported, never fetched.
2. **Model** entities by inverting `x-invalidate` (or path heuristics) into a read surface per entity.
3. **Authenticate** every configured principal with the recipe for each scheme the document declares. Credentials refresh on a countdown from `exp` (default 30s buffer) before every dispatch and each async poll.
4. **Seed** a cohort of records per entity, in parent-before-child order, using each entity's create operation.
5. **Test** the matrix entity by entity: foundations first, then composition, writes, isolation, declared effects. Entities that can see each other's writes (a parent and its children, a route one invalidates, an effect one lands on another) run in series; entities that share nothing run side by side. Checks inside an entity stay ordered.
6. **Destructive** operations (`x-destructive`) run as a second user signed up for the purpose, never the suite caller.
7. **Scenarios** run the flows the config declares for operations the matrix cannot reach on its own (a payment, a consent, an invite accepted by a second user).
8. **Floor**: every operation nothing above graded is called once with a request built from its schema. A delete that only answered 2xx is read back once.
9. **Teardown** everything the run created, unless `--keep-fixtures` / `keepFixtures: true`.

Every pass names its tier. `verified`: a later exchange shows a value from the call, such as the read holding the created id, the list without the deleted one, or the session refused after the logout. `contract`: the call got a documented success and its body matched the schema, and nothing later showed more. An operation oat could not call at all stays `untested` with the reason (`unresolved param team_id`, `contract call returned 409 …`); declare a scenario for it.

The first principal is the writer. Isolation needs a second principal with a different `tenant`. A rank lattice needs two or more principals that share a `tenant` and differ in `rank`. Invite checks need `x-invite` plus a peer with `inviteAs`.

oat never needs ground truth about your data. A filter and its negation must partition the set; a page walk must cover the collection; a record read four ways must read the same.

Each operation is sent the credentials its OpenAPI `security` requires, placed where its scheme says, from the config's recipe for that scheme (see [Security recipes](configuration/principals-and-security.md#security-recipes)). The primary origin is `baseUrl`; extra hosts go in `origins[]`, each with its own spec. A request step whose `path` is an absolute `http(s)` URL is a recorded hop on that URL (a mailed consume page), not an `origins[]` entry. Request bodies follow the document: JSON, `multipart/form-data` (scalars plus dummy, pool, `each` or `resolveUpload` files), or `application/x-www-form-urlencoded`. `hooks.resolveInput` can replace a generated JSON field (a Stripe test `pm_…`); `hooks.resolveHeaders` can attach a one-shot header (Turnstile) per request.

## How the model is derived

`oat plan` is this model. Checks never see raw paths; they see entities, actions, and query **roles**.

### Entity name and action

**Explicit:** `x-entity: { name, action, identity? }` on the operation.

**Heuristic** (when the tag is absent):

1. Split the path on `/`. Ignore `{param}` segments.
2. The last non-parameter segment is the noun. `v1` / `v2` / `vN` is never a noun.
3. Singularize that noun (`stores` → `store`, `batches` → `batch`). Irregulars include `people→person`, `categories→category`, `campuses→campus`, `statuses→status`, `children→child`, `companies→company`, `addresses→address`, `indices→index`, `queries→query`, `properties→property`, `entities→entity`, `inboxes→inbox`. Endings `us|ss|is|os|as|ics|ews|ess|ous|sis` are left alone (`status` stays `status`).
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

### Methods

oat reads every operation field of an OAS 3.2 Path Item: `get`, `put`, `post`, `delete`, `options`, `head`, `patch`, `trace` and `query`. `GET`, `HEAD`, `OPTIONS`, `TRACE` and `QUERY` are safe: a read-only check may send them, they never count as writes, and a contract call may send one to any record the run saw. `PUT` and `DELETE` are idempotent too, so a network failure resends them, as it does a safe method. A `QUERY` carries its question in a JSON body like any other request body. A `TRACE` operation is listed but never sent, because fetch refuses the method: the contract call records it as untested with that reason, and the model flags it (`unsendable`).

### Parameters

A required parameter the caller leaves unset is sent with the value the document declares for it (`example`, `examples`, `const`, the first `enum` value, or `default`), in the query, as a header, or as a cookie. An object or array value is kept whole. A header parameter named `Accept`, `Content-Type` or a credential header, and the idempotency key, are never sent from the document. A declared header or cookie under a name the operation's credential is placed in is never sent either; a caller's header there still collides with the credential.

Each value is written in the parameter's OAS `style` and `explode`: `form`, `spaceDelimited`, `pipeDelimited` and `deepObject` in the query and cookies, and `simple`, `label` and `matrix` in the path and headers. The OAS defaults hold when the document says nothing: `form` exploded in the query and cookies, `simple` unexploded in the path and headers. Values are percent-encoded per RFC 3986 unless the parameter sets `allowReserved`; a header is never percent-encoded. A urlencoded body's `encoding` uses the same serializer.

### Discriminated unions

A `oneOf` or `anyOf` of `$ref`s beside a `discriminator` pins each branch to its tag: the `mapping` values that reach the branch's schema, or else its component name. Each branch then requires `propertyName` with one of its own values, so a response whose tag names one branch and whose fields fit another fails its schema, and a generated body carries the tag of the branch it was made from. A union's branch turns with the record's index, as an enum value does, so a cohort makes every branch. A union with a branch that is not a `$ref`, or one oat cannot name, stays as JSON Schema reads it. Not read: the `allOf` inheritance pattern, where a parent schema holds the `discriminator` and each child extends the parent with `allOf`; such a parent's tag is not pinned. A `mapping` value that names a schema in another file falls back to that branch's component name, and the union stays unpinned when no name is left. A tag marked `readOnly` (in a request) or `writeOnly` (in a response) leaves the union unpinned, read from the union and each branch's own `properties`, not from inside an `allOf`.

## Seeding

Per entity, oat POSTs the create body built from the request schema (JSON, multipart, or urlencoded).

An entity with no create of its own — a table's exports, a webhook's deliveries — is read through its list. When that list sits under a parent (`/tables/{table_id}/exports`), oat makes the parent the way it makes any ancestor, sharing the one it already made for this principal, so the entity's checks have a list to read. A path parameter names whatever the collection before it creates, so `/organizations/{organization_id}/webhooks/{id}` finds the webhook even when the model calls it `organization-webhook`.

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

Numbers use the ladder `1, 2, 5, 10, 20, 50, 100` so **lexical order ≠ numeric order** (otherwise a TEXT compare looks correct). Enums walk `index % enum.length`. `readOnly` / `x-generated` fields are omitted. Required fields that cannot be generated get a type fallback (`0`, `false`, `[]`, `{}`, `"value"`). Arrays honor `minItems` (never send `[]` when `minItems ≥ 1`). Nested objects stop at depth 4.

Empty schemas (`{}`, `true`, `additionalProperties: {}`) and cyclic `$ref`s after inlining stop the walk — they become a scalar or `{}`, never another object descent. A `RangeError` during generation is a `COVERAGE_GAP` on that entity naming the operationId and JSON pointer (`fixture generation overflow on table.create (/)`), not `blocked by unknown`.

String fields honor `format`, `pattern`, and `minLength` together: `email` → `oat-{variant}-{index}@example.test`, `uri` / `url` → `https://example.test/...`, `uuid` → a fixed-shape UUID, `pattern` → a string that matches (or the field is omitted / the entity is a gap). A generated string is padded to `minLength` (repeat the last character) without breaking `pattern`. `"Quarterly Report N"` is only used when the document does not constrain the string. `minLength` greater than `maxLength` omits an optional field and records `missingRequired` on a required one.

An operation with `x-invite` is not `entity.create`. oat does not POST a generated invitee. The invite check sends `granteeField` = the peer's `inviteAs`. Missing `inviteAs` is a coverage gap naming the tag.

A create whose `operationId` appears in any principal `auth.steps`, or that declares `x-fresh-principal`, is not seeded. Those rows were provisioned by the auth flow.

Parent path parameters are created first (depth-first through the owning entity's create). Each principal's `scope` (or a login's `scope.<parameter>` claim, or `hooks.resolvePathValue`) fills parameters oat cannot create.

A create that returns `>= 300` on the first variant fails the entity (downstream checks `BLOCKED`). Later variants that fail just shorten the cohort — a partial cohort is still used.

HTTP 429 is retried first — `Retry-After` or exponential backoff, up to five times — on seed, checks, and teardown, whether or not the operation declared `x-rate-limit`. The first 429 is never a seed failure. A leftover 429 after those retries is a gap, not a backend defect.

A 503 with `Retry-After` is waited out and asked again, up to three times and 60s of waiting, as a well-behaved client would. A 503 that outlasts that, or names no wait, stands. A read (`GET`, `HEAD`) that meets a 502, 503 or 504 — what a gateway answers on its own, without the request reaching the API — is asked once more after a second; a write never is. Every server error left standing fails its operation (`response.no-server-error`); a lasting 503 is reported as the operation being unavailable, any other 5xx as a crash.

A request that times out is a network outcome only when the host has stopped answering. When the origin still answers a probe, the timeout fails that one operation and the run goes on.

A 402 / plan-limit (`payment_required`, `*_plan_limit`) on create is not a backend defect when the same-tenant list already has a row — typically an earlier `x-effects` create that filled a free-plan quota. oat reuses that id so children (a `row` after extract created a `table`) can still seed. It does not invent records. Write-path checks on the adopted entity stand down.

A documented feature-gate 403 is the exception: if create declares `x-feature-gate` and the body is `vars.type: feature_gate` (and `vars.feature` matches the tag when present), oat records a `COVERAGE_GAP` naming the tag rather than a seed defect. See [`x-feature-gate`](tags.md#x-feature-gate).

When create is tagged `x-unique`, a first-variant seed **409** with a nonempty same-tenant list **adopts** that row (`world.seed` `COVERAGE_GAP` naming `x-unique` — the create could not insert). Unique-conflict checks still run against that row. Write-path oracles that need a body oat submitted stay skipped. 409 with an empty list stays `BLOCKED` (`could not seed`). A 409 without the tag is still today's seed failure. The seed 409 itself is not `create.unique-conflict-rejected` passing — that check is the explicit second POST. See [`x-unique`](tags.md#x-unique). Later variants that 409 only shorten the cohort. Generated values for unique body columns differ across variants (a suffix) without weakening `maxLength` / `pattern`; if the document cannot express two distinct values, oat records a gap and skips extra variants.

`--seed` / `seed` makes the bodies identical across runs. It does not make server-assigned ids identical.

A record belongs to the configured principal whose credential its create carried, whatever sent it: a seed, a check, a probe the backend should have refused, a scenario step, a create declared as `PUT`. oat reads every answer as it arrives, and each 2xx from an entity's create is ledgered under that principal, scoped where the create's own path put it — a path value wins over the principal's root of the same name, so a create sent under another tenant's root is removed under that root. A principal configured with no credential owns the requests that carry none. A create sent with a credential no configured principal holds — a scenario's own account — is outside the ledger: the scenario that made it cleans it up. Accounts are never ledgered here: the caller's own account (`x-entity.identity: self`) and the record a sign-up creates belong to the account ledger, which removes each as itself, by an admin, or by `hooks.teardownPrincipal` (see [principals](configuration/reference.md)).

Teardown DELETEs created rows (or the `x-cleanup` route) newest-first, and only by an id the backend gave back: a create's response, a listing, an async receipt, or — for a create that answers only an acknowledgement — the entity's read under the id oat sent, showing that id and every field oat submitted. An id oat merely sent is never recorded, so a server that ignores a client-chosen id cannot make oat delete somebody else's row. A record whose delete is refused counts as removed when a delete on the same path succeeded earlier in the run: a tenant its creator has left can refuse every later request. A write the backend accepted to a key it should have refused — a tenant or parent id — may have moved a record out of every scope oat can reach, so its creator's 404 no longer counts as removal: the record is a leftover, named with the write that moved it. Each record is deleted with its creator's credential first. Failures and missing delete routes are printed as leftovers, each naming the principal that created the record, not as check findings. After each level of deletes, and before the parents above it go, each list is read again with the creator's credential, page by page as the list declares its paging (largest page, at most 50 pages), until it ends or holds every record being looked for: a record still listed after its delete answered 2xx is a leftover too, with that reason. A read that is fenced or cannot be sent verifies nothing and claims nothing; `teardown: { verify: false }` skips it. Every read and listing by a record's creator during the run counts as having seen it; a record its creator never saw is read once with the creator's credential before its delete, and one still unseen after a 2xx delete is a leftover, since nothing HTTP said could have shown it gone — unless the record, or an ancestor of it, was deleted earlier in the run (compared by path segments). An entity with no read makes no such claim. `hooks.verifyRemoved` can settle each record from outside HTTP; see [Proving a record gone](configuration/hooks.md#proving-a-record-gone). `keepFixtures: true` skips teardown altogether.

## Query roles and grammars

Checks do not look for a parameter _named_ `filter`. They resolve **roles** from aliases, then write values in the grammar the document demonstrates.

| role              | aliases (normalized: case, `_` / `-`, `perPage` → `per_page`)                       |
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

A search alias whose declaration says it takes structured input is not free text, and oat passes over it for the next alias: a scalar schema that is not a string, a `pattern` containing `:`, or examples or a description that spell `key:value` (`key1:value2` too). Keycloak's `q`, described as `'key1:value2 key2:value2'`, is an attribute query, so its users list searches by `search`. The rule is kept that narrow: a colon in an example (`role:admin`) or the word "attribute" alone can belong to free text.

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

Without `x-query`, if a filter/order/select/search role resolves, oat assumes **every scalar** is filterable/sortable/selectable (`string` / `number` / `integer` / `boolean`, including nullable unions). Sortable-without-tag leaves out the list's own path parameters (`project_id` under `/projects/{project_id}/tables`): every listed record holds the same value, so ordering by it shows nothing. Searchable-without-tag is further narrowed to names matching `name|title|slug|label|description|email`. `doctor` warns. Pagination-only lists stay uncovered.

A query probe goes only to a parameter the list operation declares. Without a declared order, search or select parameter, that axis is empty, whatever `x-query` or config lists for it. Under one parameter per field (`equality`, or a template with `param: "{field}"`), the guessed filterable fields are cut to those the list declares as query parameters; a field `x-query`, config, a harvest or the hook names is kept. A check that needed what was cut does not apply, and its reason names the missing parameter (``the `id` query parameter, which the list operation does not declare``). `doctor` shows the cut map.

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
