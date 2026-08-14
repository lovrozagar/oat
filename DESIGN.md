# oat — design

Deep behavioural testing of a running backend against its OpenAPI document.

Two inputs, always: **the spec** and **a config file**. oat never reads your source, never assumes your framework, never hardcodes a route. Anything backend-specific is either declared in the spec as an `x-*` meta tag (see [EXTENSIONS.md](./EXTENSIONS.md)) or supplied by config. A backend adopts oat by adding tags, not by adapting to oat.

---

## 1. Why not another schema validator

Schema validators answer *"did this response match its declared shape?"* — a per-request question. Nearly every real API bug is a **relational** question:

- A resource exists in `GET /tables/{id}` but not in `GET /tables`.
- `?filter=status.eq.nonexistent` returns every row because the backend silently dropped the param.
- Walking `?limit=2` pages yields 9 rows; `?limit=100` yields 10 — the sort has no total order.
- `PATCH {name}` also cleared `instruction`.
- `?filter=id.eq.<other tenant's id>` returns the row.

None of those violate a schema. All of them are caught by asserting the **same fact through independent projections** and comparing the projections to each other.

That is oat's thesis: *schema validation is the floor, not the product.*

---

## 2. Pipeline

```
spec ──▶ resolve ──▶ model ──▶ plan ──▶ world ──▶ execute ──▶ triage ──▶ report
```

| stage | produces |
|---|---|
| **resolve** | fully dereferenced document, `$ref` cycles broken, strictness applied |
| **model** | entity graph, read surfaces, query capabilities, principals |
| **plan** | ordered scenario list — lifecycles, properties, negatives |
| **world** | seeded fixtures, topologically resolved, one per run |
| **execute** | requests with oracle assertions, full transcript recorded |
| **triage** | root-cause DAG, severity classification, cascade collapse |
| **report** | markdown + JSON + generated curl reproducers |

Each stage is a pure function of the previous one except `world` and `execute`. That means `oat plan` runs fully offline and is unit-testable — the previous attempts couldn't do this, which is why their planner bugs only surfaced against a live backend.

---

## 3. The model

### 3.1 Entity graph from `x-invalidate`

`x-invalidate` is conventionally read as a cache hint. oat reads it as a **graph edge**, and inverts it:

```
mutation ──x-invalidate──▶ read route
```
inverted:
```
entity E ──▶ read surface of E = ⋃ { read routes named by E's mutators }
```

An entity's read surface is every projection through which it is observable. That set *is* the criss-cross test matrix. A backend that already emits `x-invalidate` for cache purposes gets the entire model for free.

Fallback when absent: pair each mutator with sibling collection/item routes on the same path prefix. Catches `POST /tables` → `GET /tables`, misses `POST /tables/{id}/columns` → `GET /tables/{id}/rows`. The gap is reported, never guessed at silently.

### 3.2 Collection shape

Never hardcode the array key. Derive it from the 200 response schema: the array-typed property, or the root if the response is an array. Envelope keys are then known (`count`, `hasMore`, `nextCursor`, `page`), which is what makes cardinality and pagination assertions possible.

> The previous attempt hardcoded `["data","items","results","records"]`. Against a spec whose keys are `tables` / `rows` / `webhooks`, that returns `null` on every list response and **every invalidation check silently passes.** Deriving from the schema is not a refinement; it is the difference between working and not.

### 3.3 Identity

An entity instance needs a stable handle. Order: `x-entity.identity` → a required `id`-like property in the item schema → the property the create response and the read path parameter agree on. If none resolves, the entity is `UNTRACKABLE` and gets schema-level coverage only, reported as a gap.

---

## 4. Scenarios

### 4.1 Lifecycle

Per entity, a state machine over `absent → created → updated → deleted`. After **every** transition, the full read surface is re-observed and checked against the oracle.

The oracle is a shadow copy of expected state, updated on each transition from the request body plus the create/update response. Assertions compare observations to the oracle, not to each other's timestamps — so a failure reads:

```
row 01H… after PATCH {name:"b"}
  detail  GET .../rows/01H…    name="b"   ✓ matches oracle
  list    GET .../rows          name="a"   ✗ stale
  → read-after-write divergence between detail and list projection
```

not `invalidate mismatch: body unchanged`.

### 4.2 Criss-cross

For resource `R` in state `S`, assert `R` through every projection its read surface offers:

| projection | assertion |
|---|---|
| detail | equals oracle |
| list, default params | contains `R`, fields equal oracle |
| `filter=<id>.eq.<R>` | exactly `[R]` |
| `filter=<id>.neq.<R>` | `R` absent |
| `order=<f>.asc` / `.desc` | `R` present in both; full sets are exact reverses modulo ties |
| page walk at `limit=2` | `R` appears **exactly once** across all pages |
| cursor walk vs page walk | identical sets |
| `q=<token from R>` | contains `R` |
| `select=<subset>` | keys ⊆ requested; values equal oracle |
| aggregate / count | equals length of full walk |
| export / download | equals list set |

Every row is the same fact through a different code path. Divergence is a defect even when oat cannot say which side is right — and it names both sides, which is what a backend dev needs.

### 4.3 Metamorphic properties

Hold for any correct implementation; need no ground truth.

- concat of `limit=n` pages ≡ single `limit=max` page
- `filter=and(A,B)` ⊆ `filter=A`
- `filter=A` ⊎ `filter=not(A)` ≡ unfiltered, and disjoint
- **a filter that must match zero rows returns zero** — if it returns everything, the param is being silently ignored. The single highest-yield check in oat, and invisible to schema validation.
- unknown filter field → `400`; never `500`, never silently ignored
- `select` output is a strict projection of `select=*`
- `GET` twice ≡ identical; `PUT` twice ≡ same state; second `DELETE` → `404`/`410`
- **PATCH minimality** — send one field, every other field byte-identical afterward
- PATCH of an undeclared field → rejected or ignored, never persisted
- PATCH of an `x-immutable` field → value unchanged afterward
- reorder-type ops: read-back order equals the order sent

### 4.4 Isolation

Two principals in different tenants. Every resource created by A must be, for B: absent from list, `403`/`404` on detail, unmutable — **and `filter=<id>.eq.<A's id>` returns empty**, because a filter that bypasses the tenant predicate is an authorization bug that per-operation `403` cases never reach.

### 4.5 Negatives

Synthesized from documented response codes and the request schema: missing required field → `400`; each declared error code exercised; wrong `content-type` → `415`; oversized body → `413`; absent credential → `401`. Error bodies validated against their declared schemas — the previous run found 7 real spec drifts this way alone.

### 4.6 Async

`x-async` operations are driven to a terminal state, then the terminal payload is treated as the operation's result and criss-crossed like any other. Without it, extraction/batch/export endpoints are testable only as "returned 200", which for an extraction-shaped API is most of the surface.

---

## 5. Data that can actually be tested

Valid-random fixtures cannot test filtering. `ilike` needs a substring; `order` needs a total order; boundary handling needs boundaries.

oat seeds a **discriminating cohort** — by default 5 instances per entity, deliberately shaped:

| instance | purpose |
|---|---|
| baseline | ordinary values, all optional fields set |
| lexical-extremes | names sorting first and last under the declared collation |
| null-heavy | every nullable field null — exercises `nullsfirst`/`nullslast` |
| unicode | multi-byte, combining marks, RTL — encoding and length semantics |
| metacharacter | contains `%`, `_`, `*`, `,`, `.` — LIKE escaping and filter-grammar injection |
| boundary | every string at `maxLength`, every number at `minimum`/`maximum` |

Timestamps are staggered deterministically so ordering assertions have signal. Everything derives from `--seed`, so a failing run is exactly reproducible.

---

## 6. Auth and credentials

Declarative, never built in. oat knows nothing about your login route.

```ts
auth: {
  principals: [{ id: "a" }, { id: "b", isolateFrom: "a" }],
  acquire: [ /* request steps; values piped forward by JSON pointer */ ],
  refresh: { credentialFrom: "$.access_token", expiresInFrom: "$.access_token_expires_in" },
  inject:  { header: "authorization", template: "Bearer {credential}" },
  hooks:   { resolveOutOfBand, teardownPrincipal },
}
```

A spec may instead declare `x-auth-flows` at document root, making oat zero-config on that backend.

**Out-of-band values.** Verification tokens, magic links, OTPs arrive outside HTTP. oat cannot know your mechanism — mail catcher, KV tap, webhook sink. It declares the *need* and calls `hooks.resolveOutOfBand(address, kind)`. That function, which you write, is the entire coupling surface. It is polled with backoff, because such stores are usually eventually consistent.

### 6.1 Credential lifecycle

Short-lived tokens are the norm; naive handling corrupts results.

1. **Expiry is known, not guessed** — config pointer → JWT `exp` → configured fallback. Clock skew computed from the server's `Date` header.
2. **Refresh proactively at 75% of TTL, before dispatch, never mid-flight.** Deterministic under `--seed`.
3. **A 401 is evidence, not a retry trigger.**

```
unexpected 401
  ├─ fire control request (a cheap authed GET already proven good this run)
  ├─ control 401 too → credential expired → refresh once, re-run, mark RETRIED_AUTH
  └─ control 200     → credential is fine → BACKEND_BUG, both responses attached
```

   Blanket-retrying 401 hides exactly the authorization bugs oat exists to find.
4. **Per-principal lanes** — A's refresh is never triggered by B's expected `403`.
5. **Refresh semantics are themselves tested, on a throwaway principal.** After refresh, does the old refresh token still work? Yes → reuse vulnerability. Testing this on the session principal is how prior attempts produced run-wide cascades.
6. **Churn is reported** — `TTL 300s → 47 refreshes this run` is an observation worth surfacing.

---

## 7. World and cascade suppression

Fixtures resolve **topologically, once per run**, into a world that outlives every case. Per-case seeding was the prior attempts' fatal flaw.

Roots — resources with no create operation — come from config or `x-root`, and are validated **before** the run starts. A missing root is a configuration error reported in one line, not 27 failures.

Outcomes are five-valued:

```
PASS · FAIL · BLOCKED · UNSEEDABLE · SKIPPED
```

Every case declares its dependencies. A failed create marks dependents `BLOCKED`, never `FAIL`. The prior run's 88 failures were roughly 5 root causes; oat prints the 5 and folds the rest beneath them. **This is the single biggest determinant of whether anyone acts on the report.**

---

## 8. Triage

Severity is derived from evidence, not prose:

| verdict | rule |
|---|---|
| `SPEC_BUG` | backend behaviour is defensible, document disagrees — create returns `201`, spec says `200` |
| `BACKEND_BUG` | projections of one fact disagree, or a property is violated |
| `SECURITY` | cross-tenant read/write, filter-based authz bypass, refresh-token reuse accepted |
| `AMBIGUITY` | spec permits both observed and expected behaviour — a contract that needs tightening |
| `COVERAGE_GAP` | oat could not test this, and why |
| `BLOCKED` | dependency failed; names the root cause |

Every finding carries: the request, the response, the oracle expectation, the divergent projections, and a **generated `curl` reproducer**. The prior team hand-wrote those scripts and they were the most-used artifact in the whole report — so oat generates them.

---

## 9. Surface

```
oat run   --spec <url|file> --base-url <url> [--profile smoke|crud|deep|paranoid]
          [--seed 42] [--only table,row] [--concurrency 4]
oat plan  --spec <url|file>          # offline; prints the derived model and matrix
oat doctor --spec <url|file>         # what oat can and cannot test, and which tags would help
```

`oat doctor` matters for adoption: it reports coverage gaps against the spec alone and names the meta tag that would close each one. That is how a backend team discovers what to annotate.

Outputs `oat-report.md`, `oat-report.json`, `issue-repro/*.sh` (only when there is a finding), and a full HAR transcript so findings are re-inspectable without rerunning. Exit code is the count of **root causes**, not raw failures.

Profiles bound cost: `x-cost: high` operations run once under `crud`, never inside permutation loops. `x-destructive` runs only under `paranoid`.

---

## 10. Non-goals

- Load, soak, or performance testing.
- Fuzzing for crashes — oat generates adversarial *valid* input, not garbage.
- Replacing unit tests. oat tests the contract at the boundary.
- Guessing. Anything oat cannot determine is a reported gap, never a silent assumption.
