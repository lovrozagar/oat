# Live documents

Outcomes of pointing oat at specifications it did not generate. Dated 2026-08-13.

This is ROADMAP task **R2** (doctor + plan) plus **R3** against `labs/`
(D1 + Workers). Anyrow still needs `ANYROW_TESTER_KEY` for a stranger run.

Raw logs: `.oatlogs/doctor-petstore.log`, `.oatlogs/plan-petstore.log`,
`.oatlogs/doctor-anyrow.log`, `.oatlogs/plan-anyrow.log`.

---

## Swagger Petstore 3

`https://petstore3.swagger.io/api/v3/openapi.json`

The standard untagged CRUD-ish document. No oat tags. No list operations modelled.

### doctor

- **3/3 entities “fully testable.”** False in the sense a reader cares about. Each
  entity has an identity and an item route, which is all doctor currently requires.
- 9 checks locked behind tags (`x-async`, `x-effects`, `x-immutable`, `x-invalidate`,
  `x-query` spec-adversary trio, `x-soft-delete`). Accurate.
- Doctor still claims “the remaining query checks run against every scalar property”
  because `x-query` is missing. There is **no list**, so those checks will not run.
  The sharpening sentence assumes a list exists.
- `x-tenant` sharpening is listed even though petstore has no tenants.

### plan

| entity | CLRUD | identity | read surface |
| --- | --- | --- | --- |
| pet | C·R·D | `id` | `GET /pet/{petId}` (inferred) |
| order | C·R·D | `id` | `GET /store/order/{orderId}` (inferred) |
| user | C·RUD | `id` | `GET /user/{username}` (inferred) |

19 operations, 3 entities. `GET /pet/findByStatus` and `findByTags` were not modelled
as the pet collection — they look like RPC, not `GET /pets`. No `L` anywhere.

User identity is `id` while the item parameter is `username`. That will break
read-after-write style tracking if a run is ever attempted.

### Classification

| outcome | |
| --- | --- |
| modelled | 3 entities, item routes only |
| skipped | every list/query/pagination check (no list) |
| gap | `x-invalidate` fallback to sibling item routes; no auth operations assessed beyond tags |
| surprise | “fully testable” with zero lists; query-check warning that cannot apply |

No `oat run` against the live petstore in this pass (mutating a public sandbox is
out of scope until R3 has a dedicated, disposable API).

---

## anyrow (`https://api.anyrow.ai/v1/openapi/spec`)

Fetched 2026-08-13, 125746 bytes. This is the API `labs/anyrow.config.ts` targets.
Doctor/plan only — no tester key, so no `oat run`.

### doctor

- **10/10 entities fully testable.** Closer to true than petstore: several entities
  have lists. Still includes `distinct` and `delivery` (collection-only views) and
  `project` with CLRUD `·····`.
- 8 checks locked behind tags. `x-invalidate` is present on some operations, so it
  is not in the locked list — but doctor then reports those tags **point at routes
  that are not in the document** (`GET /v1/table-templates`). A declared surface
  that does not resolve is worse than an inferred one; doctor lists it under gaps,
  which is right.
- `x-query` inferred on 10 list operations (`filter`/`order`/`q`/`select` present,
  fields not declared). This is the honest “will probe every scalar” case.
- `x-tenant` inferred 42 times from `{organization_id}` / `{project_id}`.
- Auth: document names `apiKey` and `jwt` but contains **no token-issuing
  operation**. Matches the comment in `anyrow.config.ts` — auth is raw paths.
  Doctor reports this clearly. Good.
- Roots required: `batch_id`, `export_id`, `organization_id`, `project_id`.
  The example config fills org/project from the signup flow; batch/export would
  still need a create or a supplied id.

### plan

| entity | CLRUD | surface |
| --- | --- | --- |
| table, row, table-template, webhook | CLRUD | declared lists + items |
| column | C··UD | declared, no own list |
| batch, export | ·LR·· | inferred; no create in the document |
| project | ····· | declared as someone else’s invalidate target |
| delivery, distinct | ·L··· | inferred views treated as entities |

46 operations · 10 entities.

### Classification

| outcome | |
| --- | --- |
| modelled | real list+item entities (table, row, webhook, template) |
| skipped | spec-adversary checks (no `x-query` tag); async/effects/immutable/soft-delete |
| gap | auth operations missing; `x-invalidate` names routes that do not exist; views promoted to entities |
| surprise | `project` is “fully testable” with no lifecycle letters |

R3 should run `labs/anyrow.config.ts` with a tester key and record which of the
modelled entities actually execute checks, and whether inferred `x-query` produces
dismissable findings on unindexed columns — the warning doctor already prints.

---

## oat lab (`lab/`) — 2026-08-13

A Hono API this repo owns, local SQLite (D1-shaped). Spec: `lab/openapi.yaml`.
Config: `lab/oat.config.ts`. Not the reference fixture.

### doctor / plan

- 2/2 trackable, 2/2 listable (`article` CLRUD + `comment` nested CLRUD).
- `x-query` and `x-tenant` are tagged, so no “inferred” sharpening.
- Locked: `x-async`, `x-effects` only.
- `org_id` is a root (no org create in the document). Expected.

### `oat run` (after N2/N3)

```
50 checks · 1 entity · 149 requests · no defects · 5 did not apply
cleaned up 9/9
```

Two more than the first R3 run: `auth.rank-is-monotonic` and
`auth.invite-grants-then-revokes`. Still clean.

Did not apply, all honest:

| check | why |
| --- | --- |
| async.* | no `x-async` |
| effects.declared-effect-occurs | no `x-effects` |
| invalidation.declared-route-changes | invalidate names only *this* entity’s routes |
| pagination.limit-respects-documented-max | `maxLimit` 100, cohort smaller than that |

### Spec lie (2026-08-13)

Added `body` to `x-query.filterable` while `lab/store.ts` still rejects it.

```
SPECIFICATION DRIFT (1)
  article  the document declares a filter the backend does not accept
           spec.declared-filterable-is-filterable
```

Restored. Dropping a declared field does **not** produce this verdict — the
check only fires on an overclaim.

### D1 (`LAB_STORE=d1`) — same API, remote engine

Database `oat-lab` provisioned in the CF account. First D1 run found a real
lost-update (`concurrency.no-lost-update`, 37.8s, p95 825ms): `Store.update`
read the row and wrote every column back. In-process SQLite was too fast to
lose; D1 latency made it deterministic.

Fix: PATCH updates only the named columns. Re-run: **48 checks, no defects,
42.5s, 9/9 cleaned**.

### Comments + `kind`/`author` on D1 (2026-08-13)

Hand-written `comment` routes (not the fixture). Spec: `x-invalidate` on
article list/item for create/delete. First D1 comment run found
`pagination.cursor-agrees-with-page` — list advertised `nextCursor` and
ignored it. After the cursor walk, 51 checks / 2 entities / no defects,
but 9 comment checks could not conclude: one writable string (`body`)
and no shared filter value.

`author` and `kind` (`note`/`question`) were added on the real table
(`ALTER` via `migrate()`). Direct D1 `PRAGMA table_info(comments)` went
from 6 columns to 8. A live `POST /comments` `{author: ecomet, kind:
question}` persisted in Cloudflare and bumped `articles.comment_count`.

Clean re-run (`oat-out/lab-d1/`):

```
51 checks · 2 entities · 296 requests · 119.7s · p95 1467ms
0 findings · 0 inconclusive · cleaned 18/18
```

Composition, projections-agree, and lost-update held on comments.

Planted `LAB_BUG=stale-comments` (skip `recountComments`). Independent
D1 read of `art_mss0yzy2_w152o0`: 1 comment row, `comment_count = 0`.
oat (`oat-out/lab-d1-stale/`):

```
BACKEND DEFECTS (1)
  comment  a route the document says is invalidated by this write did not change
           invalidation.declared-route-changes
```

Repro: `oat-out/lab-d1-stale/issue-repro/comment-invalidation-declared-route-changes.sh`.
Process restored without the bug.

One extra inconclusive on the planted run (`query.filter-selects-from-whole-set`:
collection larger than the walk) is leftover D1 rows from earlier sessions,
not a check bug.

### R4 from this run

`x-soft-delete` was on `article.delete`. Doctor unlocked the check; the check
stood down because `run.ts` only read the tag off the **list** operation.
Fixed: soft-delete is taken from any operation on the entity. After the fix the
check ran and the lab stayed clean.

---

## What R2 changes about the queue

1. **A2 landed.** Doctor reports trackable vs listable and no longer claims
   query checks on item-only entities.
2. **A4 is (b).** Query matrix and sharp tenant verdicts need roles.
3. **R3 and N-role landed** against `lab/` (SQLite and D1), not anyrow.
   Anyrow still needs `ANYROW_TESTER_KEY` if we want a stranger run.
4. **Do not add query-matrix cells.** Petstore would not run them. The lab
   already exercises the triples plus invalidate.
