# oat — OpenAPI meta tags

[← back to the overview](../README.md)

## OpenAPI meta tags

Vendor-neutral `x-*` extensions. Every one is optional. Precedence: **explicit tag → heuristic → skip with a coverage gap**.

A complete document with every tag in place is shipped as `labs/annotated-openapi.yaml` (also in the npm package). `oat conformance` asserts the derived model matches that file.

```bash
oat plan   --spec node_modules/@lovrozagar/oat/labs/annotated-openapi.yaml
oat doctor --spec node_modules/@lovrozagar/oat/labs/annotated-openapi.yaml
```

What each tag **unlocks** (otherwise the check cannot run):

| tag             | checks unlocked                                                                                                                                                                                               |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `x-async`       | `async.reaches-terminal-state`, `async.receipt-identifies-the-job`                                                                                                                                            |
| `x-effects`     | `effects.declared-effect-occurs`                                                                                                                                                                              |
| `x-immutable`   | `patch.immutable-field-rejected`                                                                                                                                                                              |
| `x-invalidate`  | `invalidation.declared-route-changes` (when the list names another entity)                                                                                                                                    |
| `x-query`       | `spec.declared-filterable-is-filterable`, `spec.declared-sortable-is-sortable`, `spec.declared-selectable-is-selectable`, plus the declared-or-skip catalog checks (`in` / `ilike` / `is` / nulls / caps / …) |
| `x-soft-delete` | `softdelete.absent-from-default-list`                                                                                                                                                                         |
| `x-invite`      | `auth.invite-grants-then-revokes`                                                                                                                                                                             |
| `x-wait`        | `effects.side-effect-arrives`                                                                                                                                                                                 |
| `x-unique`      | `create.unique-conflict-rejected`, `update.unique-conflict-rejected`                                                                                                                                          |

What each tag **sharpens** (the check already runs, but the verdict changes):

| tag        | without it                                                                                                                  |
| ---------- | --------------------------------------------------------------------------------------------------------------------------- |
| `x-query`  | every scalar is probed, including columns you never indexed — expect findings you will dismiss                              |
| `x-tenant` | inferred tenant: a cross-tenant read is `AMBIGUITY`, not `SECURITY`. No tenant tagged or inferred: the check does not apply |

### `x-invalidate`

```yaml
x-invalidate:
  - GET /v1/projects/{project_id}/tables
  - GET /v1/projects/{project_id}/tables/{table_id}
```

`string[]` of `"METHOD /path"`. Colon or brace path params; oat normalises to brace. Method is uppercased.

This is the entity graph. Inverted, it is each entity's read surface. Highest-value tag.

**Fallback:** pair a mutator with sibling collection/item routes on the same path prefix. Misses cross-entity effects.

**Unlocks:** `invalidation.declared-route-changes` (when the list names _another_ entity's route).

### `x-entity`

```yaml
x-entity:
  name: table
  action: create # create | list | read | update | delete | action
  identity: id
```

Overrides path-segment inference. `identity` is required when the item schema has no `id` (or `uuid` / `slug` / `key` / `name`).

**Fallback:** deepest plural segment + HTTP verb. See [How the model is derived](model.md#how-the-model-is-derived).

### `x-invite`

```yaml
x-invite:
  invite: table.invite
  accept: invite.accept
  revoke: table.revoke
  granteeField: key
  tokenPointer: $.token
  grantPointer: $.grant_id
  tokenFrom: response # or outOfBand
  tokenKind: org-invite # only when tokenFrom is outOfBand; default `${entity}-invite`
  acceptFrom: token # default. `link` = GET the OOB URL instead of POSTing accept JSON
  credentialFrom: $.access_token # default. invitee adopts this field from a 2xx accept body
```

Put this on the invite operation. Config must give the invitee `inviteAs`. Defaults if omitted: `granteeField: key`, `tokenPointer: $.token`, `grantPointer: $.grant_id`, `tokenFrom: response`, `acceptFrom: token`. All three of `invite` / `accept` / `revoke` (operationIds) are required or the tag is ignored. `oat doctor` / `oat plan` print the accept mode.

`tokenFrom: response` (default) reads the accept token from the invite HTTP body at `tokenPointer`. Keep this for backends that still put the token in JSON.

`tokenFrom: outOfBand` ignores the response token and calls `resolveOutOfBand({ address: inviteAs, kind, scope, headers })` after the invite POST. `kind` is `tokenKind` or `${entity}-invite` (`org` → `org-invite`, `project` → `project-invite`). Use this when the live profile must accept only the mailed token.

`acceptFrom: token` (default) stuffs that string into the documented accept JSON / path as today. `acceptFrom: link` requires the string to be an absolute `http(s)` URL: oat GETs it (recorded, cookie-jar follow). The `accept` operationId is unused for that hop; `revoke` still uses the documented revoke operation. 2xx/3xx that leaves the grant readable continues the timeline; 4xx, 404, or an unreadable grant is a finding. A config that still POSTs `{ token }` with `tokenFrom: outOfBand` and no `acceptFrom` does not change meaning.

An invite operation is **not** the entity's fixture create, even when it is `POST` on the collection. oat will not seed it with a generated email. The invite check (and only that check) creates the grant, using `inviteAs` as `granteeField`. The check still runs when there is no non-invite create, as long as an item or list route exists.

Timeline asserted: cannot read → invite → still cannot → accept → can → revoke → cannot.

After a 2xx accept, oat reads `credentialFrom` (default `$.access_token`). When that value is a string, the invitee sends it on the later grant read and the post-revoke read. No such field leaves the invitee's existing credential in place, so `{ ok: true }` accepts stay as they are. A `link` accept that returns HTML does not count as a credential.

Accept and revoke send the documented JSON request body when the operation declares one, filled from the invite token / grant id (and other known scope values). A path-only accept (`POST /invites/{token}` with no body) stays path-only — oat does not invent a body.

**Fallback:** the check does not run.

### `x-query`

String arrays still work. Structured rows are optional. Either, not both required.

```yaml
x-query:
  grammar: postgrest # postgrest | colon | equality
  filterable: [id, name, created_at]
  sortable: [name, created_at]
  searchable: [name, slug]
  selectable: [id, name, created_at]
  maxLimit: 100
  defaultOrder: created_at.desc
  stableTiebreak: id

  # structured (optional) — unlocks per-field ops / types / nulls
  filterable:
    - { field: id, type: string, ops: [eq, neq, in, nin] }
    - { field: name, type: string, ops: [eq, neq, like, ilike, in] }
    - { field: created_at, type: date, ops: [eq, gt, gte, lt, lte, is] }
    - { field: tags, type: array, ops: [contains, eq, is] }
  sortable:
    - { field: name, type: string }
    - { field: created_at, type: date, nulls: [first, last] }

  operators: [eq, ne, neq, gt, gte, lt, lte, in, nin, like, ilike, is, contains]
  operatorsByType:
    string:  [eq, ne, neq, like, ilike, in, nin, is]
    number:  [eq, ne, neq, gt, gte, lt, lte, in, nin, is]
    date:    [eq, ne, neq, gt, gte, lt, lte, is]
    enum:    [eq, ne, neq, in, nin, is]
    boolean: [eq, ne, neq, is]
    array:   [contains, eq, is]
  aliases: { ne: neq }
  identityFilter: _id          # filter field when it differs from the JSON identity
  emptyIn: match-none          # reject | match-none; undeclared → empty-in check skips
  maxInValues: 100
  maxFilterConditions: 20
  searchModes: [keyword]       # free-form; undeclared → mode checks skip
  searchEmpty: match-all       # ignore | match-all | reject
  sortNulls: [first, last]
  maxSortKeys: 3
  sortCollation: case-insensitive # binary | case-insensitive | locale; undeclared → any, consistently
  sortDefaultNulls: last       # first | last, with no modifier; undeclared → either end, consistently
  selectNested: true           # `rel(col)` grammar; undeclared → nested check skips
  selectUnknown: reject        # reject | ignore; undeclared → unknown-select check skips

  # harvest any axis from another GET — no baked path
  filterableFrom: { operationId: table.get, path: $.columns[*].name, typePath: $.columns[*].type, typeMap: { text: string, int: number } }
  sortableFrom:   { operationId: table.get, path: $.columns[*].name }
  searchableFrom: { operationId: table.get, path: $.columns[?(@.searchable==true)].name }
  selectableFrom: { operationId: table.get, path: $.columns[*].name }
```

`defaultOrder` / `stableTiebreak` / `maxLimit` stay. Harvest keys are generic JSON paths (`$`, dots, `[n]`, `[*]`, `[?(@.key==value)]`). Absent → no harvest.

String arrays + `operatorsByType` is enough for most APIs. Per-field `ops` / `nulls` close the list that field actually accepts.

**Fallback:** if those roles resolve and the axis was not tagged and not set in config, treat every scalar as capable and warn. Empty tagged `filterable: []` / `searchable: null` / `selectable: []` is an explicit claim of none.

**Unlocks:** `spec.declared-filterable-is-filterable`, `spec.declared-sortable-is-sortable`, `spec.declared-selectable-is-selectable`. Structured extras unlock the matching catalog checks (`in` = union of `eq`, `ilike` vs `like`, `is.null`, illegal op, empty `in`, caps, nulls, search empty/modes, unknown select, nested `rel(col)`). Sharpens every other query check (without the tag they probe columns you may not have indexed).

`oat doctor` prints, per entity, the effective map (all four axes, ops, modes, caps, harvest/hook) and which new checks will apply. Unknown `config.entities` names are ignored and warned.

### `x-async`

```yaml
x-async:
  poll: "GET /v1/projects/{project_id}/batches/{batch_id}"
  idFrom: batch_id # or $.id
  until: "status.in.complete,partial,failed"
  successWhen: "status.eq.complete"
  timeoutMs: 120000
  pollIntervalMs: 2000
```

`x-async` means **POST is a receipt, then poll**. It is not how you mark a stream. A stream is a success response that lists `text/event-stream`.

When the start response is JSON, oat polls `poll` until `until` matches, then treats that payload as the result. `poll` may be an operationId or `"GET /path/{id}"`. Defaults: `timeoutMs: 120000`, `pollIntervalMs: 2000`.

When the start response is `text/event-stream`, oat parses `event:` / `data:` frames. `data` is JSON when it starts with `{` / `[`. `idFrom` is resolved against **each event's JSON `data`**, first hit wins — `$.batch_id` on `event: batch` data `{ "batch_id": "…" }` works. A frame named `complete` / `error`, or one whose `data` matches `until`, is the terminal record; `successWhen` is applied to it and oat does **not** GET the poll route. Poll only if the stream ended without a terminal frame **and** `idFrom` resolved.

A spec may leave both `x-async` and `text/event-stream` on the same operation. The stream is still the result; `x-async` only supplies `idFrom` / `until` / the poll fallback.

`until` / `successWhen` use the same `field.op.value` predicates as filters (`eq`, `in`, …).

**Fallback:** treated as synchronous; async checks are `COVERAGE_GAP`. A 2xx stream without `x-async` is consumed and recorded; async checks do not run.

### `x-effects`

```yaml
x-effects:
  - { entity: table, op: create }
  - { entity: row, op: append, min: 1 }
```

`op`: `create` | `append` | `update` | `delete` | `replace`. Each item is `{ entity, op, count?, min? }`.

- `count` is an **exact** cardinality delta on that entity's list.
- `min` is **at-least** (`delta >= min` and `added.length >= min`). Use this when the child count is data-dependent (an extract that appends 1 / 2 / 5 rows).
- Omit both → `count: 1` (invite / create).
- Set both on one item → rejected at load / `oat doctor` (`x-effects` gap). The item is not checked.

After a write that declares `create` on A, oat binds the new A id from the write response (`table_id`, or the entity identity) or from A's list delta — the same adopt idea as a 402 plan-limit reuse. Later items in **that same** `x-effects` array whose child list is under A (`GET .../tables/{table_id}/rows`) fill the path with that id. `x-wait` after the same write uses the same bound id. No tester hook.

An extract-shaped write (create table + append ≥1 row) fails when the new table's row list is empty, and passes when it has 5.

**Fallback:** derived from `x-entity.action` for this entity only.

### `x-wait`

```yaml
x-wait:
  operationId: inbox.list
  until: $.items.0
  timeoutMs: 30000
  pollIntervalMs: 1000
```

Put this on the **write**. After that write succeeds, oat polls `operationId` until `until` (JSON path `$.items.0` or JSON pointer `/items/0`) is non-empty, or `hooks.awaitSideEffect` returns `true`. Default `timeoutMs` is **30s**. Timeout is a **finding** (`effects.side-effect-arrives`), not a coverage gap.

Use this for queue consumers and webhook inboxes (1–30 s), not for the same request. `x-effects` still asserts cardinality; `x-wait` asserts “this other GET eventually has a body”. If the poll path needs a parent id the write created, oat binds it the same way `x-effects` does.

**Fallback:** the check does not run.

### `x-soft-delete`

```yaml
x-soft-delete: deleted_at
```

On any operation of the entity (commonly DELETE). Tombstone, not remove. Without it, a correct soft-delete looks like a bug (the row is still GET-able).

### `x-immutable` / `x-generated`

```yaml
x-immutable: [id, project_id, created_at]
x-generated: [id, created_at, updated_at]
```

Generated fields are omitted from create bodies and expected in responses. Immutable fields must reject or ignore PATCH.

**Fallback:** `readOnly: true` counts as generated. No immutability testing without the tag.

### `x-tenant`

```yaml
x-tenant: project_id
```

Path parameter that scopes the operation.

**Fallback:** regex over `{organization_id}`, `{project_id}`, `{tenant_id}`, `{workspace_id}`, `{app_slug}`, `{org_id}`, `{account_id}`, … (`org|organization|tenant|workspace|account|project|app` + optional `_id`/`_slug`). Without the tag, a matching path parameter still infers a tenant and a cross-tenant read is `AMBIGUITY`, not `SECURITY`. Omitting `x-tenant` and not naming a tenant path parameter means the check does not apply.

### `x-root`

```yaml
# on a path parameter, not an operation
x-root: true
```

This resource has no create endpoint; supply it in config `roots` / principal `roots`.

**Fallback:** inferred when a path param has no create op; everything beneath is `UNSEEDABLE`.

### `x-cleanup`

```yaml
x-cleanup: "DELETE /v1/projects/{project_id}/tables/{table_id}"
```

Teardown route when the entity has no discoverable delete. Without it, leftover records are reported at end of run.

### `x-cost` / `x-destructive` / `x-idempotent` / `x-fresh-principal`

```yaml
x-cost: high # low | medium | high
x-destructive: true
x-idempotent: true
x-fresh-principal: true
```

`x-cost` and `x-destructive` are consulted by `--profile` (below). `x-idempotent` and `x-fresh-principal` are parsed onto the operation model for the `plan`/`doctor` output but not yet consulted anywhere else. Replay safety is tested from a documented `Idempotency-Key` header (`idempotency.replay-does-not-duplicate`), not from `x-idempotent`.

### `x-feature-gate`

```yaml
x-feature-gate: webhooks # or custom_domain, audit_log, …
```

Plan key this operation is sold behind. Honey/apps emit it as route meta → OpenAPI. `doctor` / `plan` show it. A non-string or missing tag is ignored (`null`).

This is not cost. `--profile cheap` skips expensive operations; a free principal hitting `webhook.create` is the real product. Skipping the op in a profile would hide the gate.

A 403 is a **documented feature-gate denial** only when all of:

1. The operation has `x-feature-gate: <string>`.
2. HTTP status is 403.
3. JSON body `vars.type === "feature_gate"`.
4. `vars.feature` equals the tag **when `vars.feature` is a string**. Absent `vars.feature` is enough together with (3). A string that disagrees with the tag is backend/tag drift — still a seed failure.

`error_key` / `feature_name` / `required_plan` are i18n/product and are not required. A typical body:

```json
{
	"success": false,
	"status": 403,
	"status_key": "forbidden",
	"error_key": "forbidden",
	"vars": {
		"type": "feature_gate",
		"feature": "webhooks",
		"feature_name": "Webhooks",
		"current_plan": "free",
		"required_plan": "pro"
	}
}
```

A gated create is a **coverage gap, not a fail**. oat degrades the entity the same way `--profile` excluding `create` does: `COVERAGE_GAP` on `world.seed` naming `x-feature-gate: <key>` (and the plan vars if present); remaining checks that needed a seeded row `did not apply` / `BLOCKED` because of that gap, not a page of "returned 403" copies. If the list route already has rows, read-only checks still run.

A later write (`create` after seed, `update`, action) that returns a documented gate 403 is the same: the check that needed a 2xx is `COVERAGE_GAP` / did not apply, citing the tag — not `SECURITY`, not a schema defect. `validation.*` and `schema.error-response-matches-document` still apply: the 403 body must match the documented 403 schema. A gate 403 with an undeclared shape is still drift.

Every 403 is not a feature gate. No tag, or a tag that disagrees with `vars.feature`, stays a `SeedError`.

**Fallback:** none. Without the tag, a 403 is a failed create.

### `x-unique`

```yaml
x-unique:
  - [email]
  - [workspace_id, slug]
# or: { columns: [email] }
# or a single string[] meaning one set: [email]
```

Column sets that must stay unique. Honey/apps emit this as route meta → OpenAPI. `doctor` / `plan` show the effective sets per entity the way they show `x-feature-gate`.

Accepted shapes: a list of column sets, `{ columns: [...] }` objects, and a single `string[]` meaning one set. Each set is a non-empty list of column names; empty sets are dropped. Malformed / non-array → treat as absent (`null`), unique checks do not run, `doctor` records an `x-unique` gap. `[]` after filtering → explicit none, checks do not run. No tag → unique checks do not run, `doctor` says so.

Do not infer uniqueness from 409s, unique-looking names, or JSON Schema `uniqueItems`. Index names and product `error_key` / `vars.type` are not required; HTTP **409** is the unique-conflict class.

`create.unique-conflict-rejected` — after a known row (seeded or adopted), a second create with the same unique-set values is 409, list cardinality does not grow, and a documented 409 body still matches the 409 schema. **2xx is `BACKEND_BUG`** (evidence: both exchanges, unique columns, list before/after when list resolved; tear down a returned id). Probe each probeable set separately (one 2xx fails the check; do not collide every set in one request). Probeable = at least one column on the create JSON or form body; path/tenant/`x-generated` columns may fill set identity from scope, but a set with no body columns is skipped, not failed. Do not reuse `Idempotency-Key` / `Idempotence-Key` / `X-Idempotency-Key` (omit, or send a fresh key if the document requires it). 402 / documented feature-gate 403 on the probe is `COVERAGE_GAP`, not a unique pass. Other 4xx / 5xx is not a unique pass. Verdict is never `SECURITY`. Leftover/extra rows do not skip the check.

`update.unique-conflict-rejected` — PATCH a **different** row onto another row's unique-set values is 409 (same scoring). PATCH of a row's own unique values unchanged is not this check. Skip update sets whose columns are all `x-immutable`.

**Fallback:** none. Without the tag, unique checks do not run, and a seed 409 is a failed create.

### `--profile` — cost gating

```bash
oat run --config oat.config.ts --profile cheap
```

A profile restricts which operations a run is allowed to touch, filtering on `x-cost` and `x-destructive`. Two exist without being declared anywhere: `full` (no gating — the default, today's behaviour if you never mention a profile) and `cheap` (`{ maxCost: "low" }`). Reach for a profile when some operations are expensive to call every run — an extraction endpoint billed per request, a bulk job, anything you don't want fired on every `oat run`.

Anything more specific than a cost band is a named entry in config:

```ts
export default defineConfig({
	// ...
	profiles: {
		// skip everything above "low" cost, same as the built-in "cheap"
		cheap: { maxCost: "low" },
		// skip destructive operations and two specific extraction endpoints
		safe: { excludeDestructive: true, exclude: ["report.extract", "report.summarize"] },
	},
	profile: "safe", // --profile on the CLI overrides this
})
```

An excluded operation never silently narrows what gets reported. Excluding an entity's `create` degrades that entity the same way a real seeding failure does — a `COVERAGE_GAP` naming the reason, then read-only checks run against whatever the list route already returns; `BLOCKED` if nothing exists to fall back on. Excluding `read`/`update`/`delete` individually stands down just the checks that need that one operation.

Exclusion applies to every invocation, not only create/read/update/delete. `effects.declared-effect-occurs` and `async.reaches-terminal-state` drop ops the profile forbids and record `profile.skip` — they do not POST `extract.once` under `--profile cheap`. A check whose only targets were excluded did not apply / names the profile; it never looks like the backend returned 500.

The run summary states what a profile skipped: `skipped 12 operation(s) under --profile cheap (12 high-cost)` — the same principle as `did not apply` for a coverage gap: a report that only shows what ran invites the reader to assume the rest was verified.

`--profile cheap` also defaults the exchange journal **off**. `--save-exchanges` turns it back on; `--quiet` does not change it.

### `x-rate-limit` — pacing oat's own traffic

```yaml
x-rate-limit: { category: ai, rps: 3 }
```

Groups operations sharing one throughput budget (`category`) and optionally the rate itself (`rps`). Without this, oat's matrix can hammer a `login` or paid-inference route past its real limit, collect 429s, and report them as backend defects — exactly the false-positive class that erodes trust fastest. With it, requests to that category are paced through a token bucket before they fire.

Tags are the **proactive** path. HTTP 429 is the **reactive** path and is honoured even when the operation has no `x-rate-limit` at all (untagged JWT writes, teardown DELETEs). oat reads `Retry-After` (delta-seconds or HTTP-date), otherwise backs off 1s, 2s, 4s… capped at 30s, and retries the same request up to five times. The wait is fed into the matching bucket, or into an implicit `untagged-write` bucket so the next call does not immediately re-trip.

A 429 is only ever reported when the request that drew it was demonstrably under the _declared_ rate — oat's own bucket had a free token, so it did not have to wait for one. A 429 that arrived only after oat's bucket made the request wait means oat's own rate model was too generous, which is paced around, never reported. A 429 against a config-supplied or implicit rate is never a finding.

`config.rateLimits` is checked first and needs no tag at all — it is what keeps oat usable against a backend that has not adopted `x-rate-limit` yet, or against an environment (staging, usually) whose real limit differs from what the document claims for production. A 429 against a config-supplied rate is never a finding: it is the operator's own belief about the environment, not a claim the API made.

```ts
export default defineConfig({
	// ...
	rateLimits: [
		{ match: "POST /v1/auth/login", rps: 2 },
		{ match: "auth.login", rps: 2 }, // operationId works too
		{ match: "category:ai", rps: 1 }, // overrides every x-rate-limit-tagged "ai" operation at once
	],
})
```
