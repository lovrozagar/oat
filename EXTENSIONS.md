# OpenAPI meta tags

**See [`examples/annotated-openapi.yaml`](./examples/annotated-openapi.yaml) first.** It is a
complete, valid OpenAPI 3.1 document with every tag below shown *in place* — the fragments here
tell you what a tag means, that file shows you where it goes.

It is not illustrative. `oat conformance` loads it and asserts the derived model matches what its
comments claim, so it cannot drift from the implementation:

```
✓ x-query resolves the filter grammar   "postgrest"
✓ x-query declares filterable fields    "tag"
✓ x-tenant is declared, not inferred    "tag"
✓ x-invalidate names two routes         2
✓ idempotency header is modelled        "Idempotency-Key"
✓ x-async is read                       "export.read"
```

Try it against your own document:

```bash
oat plan   --spec openapi.yaml --base-url https://api.example.com   # what oat modelled
oat doctor --spec openapi.yaml --base-url https://api.example.com   # what it had to guess
```

`doctor` is the one to run first: it reports every place oat fell back to a heuristic, which is
exactly the list of tags worth adding.

---


Vendor-neutral `x-*` extensions oat reads from your spec. Every one is **optional** — oat degrades to a heuristic and reports the degradation as a `COVERAGE_GAP`, never as a failure. Nothing here is oat-specific; they describe your API, not the tester.

Precedence is always: **explicit tag → heuristic → skip with coverage gap**.

---

## 1. `x-invalidate`

```yaml
x-invalidate: ["GET /v1/projects/{project_id}/tables", "GET /v1/projects/{project_id}/tables/{table_id}"]
```

`string[]` of `"METHOD /path"`. Names the read routes this mutation must change. Colon (`/tables/:id`) and brace (`/tables/{id}`) syntax both accepted; oat normalises to brace.

**This is the entity graph.** Inverted, it gives every entity its *read surface* — the set of projections through which the entity is observable. Oat's whole criss-cross model is derived from it, so this is the highest-value tag and the one you already emit.

**Fallback:** heuristic pairs a mutator with the sibling collection/item routes on the same path prefix. Catches the obvious cases, misses cross-entity effects (`column.add` → `.../rows`).

---

## 2. `x-entity`

```yaml
x-entity:
  name: table
  action: create        # create | list | read | update | delete | action
  identity: id          # optional; property that identifies an instance
```

Overrides path-segment entity inference. Needed when the path doesn't follow `/<plural>/{id}`.

`identity` matters when the item schema doesn't declare an `id` — e.g. `rows` items are `{type: object, additionalProperties: {}}`, so oat has no way to track a created row without being told.

**Fallback:** deepest plural segment + HTTP verb. Irregular paths (`/rows/aggregate`, `/columns/order`) yield nothing and lose lifecycle tracking.

---

## 3. `x-query`

```yaml
x-query:
  filterable: [id, name, slug, status, created_at]
  sortable:   [name, created_at, updated_at]
  searchable: [name, slug]            # the fields `q` actually searches
  selectable: [id, name, slug, created_at]
  maxLimit: 100
  defaultOrder: created_at.desc
  stableTiebreak: id                  # secondary sort guaranteeing total order
```

Declares what the list endpoint's `filter` / `order` / `q` / `select` params actually support.

Without it, oat has to guess which fields are filterable from the item schema and will report false failures on fields the backend deliberately doesn't index. Your current spec says `q` searches "the endpoint's configured search fields" without naming them — this tag names them.

`stableTiebreak` is load-bearing: **if a sort has no total order, keyset pagination is unsound and page walks silently drop or duplicate rows.** Declaring it lets oat assert it; omitting it makes oat test for the instability instead.

**Fallback:** treat every scalar property of the item schema as filterable/sortable, and warn.

---

## 4. `x-async`

```yaml
x-async:
  poll: "GET /v1/projects/{project_id}/batches/{batch_id}"
  idFrom: batch_id            # response property holding the poll id
  until: "status.in.complete,partial,failed"
  successWhen: "status.eq.complete"
  timeoutMs: 120000
  pollIntervalMs: 2000
```

Marks an operation whose HTTP response is not its outcome. Oat drives the poll to a terminal state, then treats the terminal payload as the operation's real result and criss-crosses whatever it produced.

Without this, every extraction/export/batch endpoint is untestable beyond "did it return 200" — which for an extraction API is most of the surface.

**Fallback:** operation treated as synchronous; downstream assertions on its effects are marked `COVERAGE_GAP`.

---

## 5. `x-effects`

```yaml
x-effects:
  - { entity: table, op: create, count: 1 }         # table.duplicate makes a table
  - { entity: delivery, op: append, count: 1 }      # webhook.test appends a delivery
```

The semantic upgrade to `x-invalidate`. `x-invalidate` says *"this GET changes"*; `x-effects` says *how*. That difference is what lets the oracle assert an exact delta (`count 4 → 5, new id present`) instead of the weak `JSON.stringify(pre) !== JSON.stringify(post)` check that produces both false passes and false failures.

Also tells oat to **track and clean up** resources created as side effects — `table.duplicate` currently leaks a table per run.

`op`: `create | append | update | delete | replace`.

**Fallback:** derived from `x-entity.action` for the operation's own entity only; cross-entity effects invisible.

---

## 6. `x-soft-delete`

```yaml
x-soft-delete: deleted_at
```

On the entity's read/list operations. Tells oat that DELETE tombstones rather than removes.

Changes the post-delete assertion from "absent everywhere" to "absent from default list, present with `filter=deleted_at.not.is.null`, restorable". You have `deleted_at` and a `table.restore` op — **without this tag oat reports correct soft-delete behaviour as a bug.**

---

## 7. `x-immutable` / `x-generated`

```yaml
x-immutable: [id, project_id, created_at]     # rejecting or ignoring writes is fine; changing is not
x-generated: [id, created_at, updated_at]     # server-assigned; never sent, always present
```

`x-generated` lets oat build valid create bodies without guessing, and assert the fields appear.
`x-immutable` powers the update-safety case: PATCH each immutable field and require the stored value to be unchanged afterward.

**Fallback:** `readOnly: true` in the schema is honoured as `x-generated`; no immutability testing without the tag.

---

## 8. `x-tenant`

```yaml
x-tenant: project_id
```

Names the path parameter that scopes the operation to a tenant.

Drives the isolation matrix: oat runs a second principal in a different tenant and asserts every resource is invisible, unreadable, unmutable — **and that `filter=id.eq.<other tenant's id>` returns empty rather than becoming an authz bypass.**

**Fallback:** regex over `{organization_id}`, `{project_id}`, `{tenant_id}`, `{workspace_id}`, `{app_slug}`.

---

## 9. `x-root`

```yaml
x-root: true
```

On a **path parameter**, not an operation. Declares that this resource has no create endpoint and must be supplied by config.

Your spec has no `POST /v1/projects` or `POST /v1/organizations`, so `project_id` and `organization_id` are roots. Tagging them turns "oat couldn't seed a fixture" from a run-killing cascade into a clean config requirement checked before the run starts.

**Fallback:** oat infers a root when a path param has no discoverable create op, and reports `UNSEEDABLE` for everything beneath it.

---

## 10. `x-cost` / `x-destructive` / `x-idempotent`

```yaml
x-cost: high            # low | medium | high — money, tokens, or wall-clock
x-destructive: true     # irreversible; excluded outside --profile paranoid
x-idempotent: true      # repeat-safe; oat asserts repeat-equivalence
```

`x-cost: high` is why `extract.once` gets exercised once instead of inside a 12-case permutation loop. Without it oat will happily burn your extraction budget.

---

## 11. `x-cleanup`

```yaml
x-cleanup: "DELETE /v1/projects/{project_id}/tables/{table_id}"
```

Explicit teardown when the delete op isn't discoverable from the entity graph.

**Fallback:** the entity's `delete` op; nothing if there isn't one, and oat reports leaked resources at end of run.

---

## 12. `x-fresh-principal`

```yaml
x-fresh-principal: true
```

Operation mutates session/principal state and must run against a freshly-provisioned principal rather than the shared one (login, logout, token refresh, key rotation). `webhook.rotateSecret` is a candidate — it invalidates a secret other cases may depend on.

---

## Priority for the anyrow backend

| # | Tag | Unlocks | Effort |
|---|---|---|---|
| 1 | `x-async` | the entire extract / batch / export surface — currently untestable | medium |
| 2 | `x-query` | all filter/sort/search/select assertions without false positives | low, mechanical |
| 3 | `x-soft-delete` | correct delete semantics; removes a whole false-failure class | trivial |
| 4 | `x-root` on `project_id`, `organization_id` | kills the cascade-failure class that dominated the last run | trivial |
| 5 | `x-entity.identity` on rows | row lifecycle tracking (item schema is free-form) | trivial |
| 6 | `x-effects` | exact-delta assertions + cleanup of `table.duplicate` leaks | medium |
| 7 | `x-immutable` / `x-generated` | update-safety cases | low |

`x-invalidate` and per-op `security` you already emit correctly. Every operation already documents 400/401/403/413/415/500 — oat synthesizes cases for all of them, including the 413/415 pair nothing currently tests.
