# oat

OpenAPI Tester — behavioural testing of a live backend against its OpenAPI specification.

Schema validators answer _did this response match its declared shape?_ Most real API bugs do not violate a schema:

- a resource exists on `GET /tables/{id}` but not on `GET /tables`
- `?filter=status.eq.nope` returns every row, because the backend dropped the param
- paging at `limit=2` yields 9 rows; `limit=100` yields 10 — the sort has no total order
- `PATCH { name }` also cleared `instruction`
- `?filter=id.eq.<another tenant's id>` returns the row

oat asserts the same fact through every projection the API offers, then compares those projections against each other.

## Table of contents

- [Install](#install)
- [Quick start](#quick-start)
- [Commands](#commands)
- [Configuration](#configuration)
- [OpenAPI meta tags](#openapi-meta-tags)
- [What gets tested](#what-gets-tested)
- [Reports](#reports)
- [Conformance](#conformance)
- [What this is not](#what-this-is-not)
- [Labs](#labs)
- [License](#license)

## Install

```bash
npm i -D @lovrozagar/oat
```

Requires Node.js 20 or later.

## Quick start

oat ships a demo API — the same reference backend its self-test uses — so you can try it before pointing it at anything real:

```bash
# terminal 1
oat serve --defects STALE_LIST,PATCH_REPLACES

# terminal 2
oat run --config labs/local.config.ts --base-url <url printed above>
```

```
  25 checks · 3 entities · 164 requests · 0.2s

  BACKEND DEFECTS (5)
    table            list projection does not reflect a completed write
    table            PATCH changed fields the request did not mention

  cleaned up 22/22 created record(s)
  report: oat-out/oat-report.md
```

`oat-out/` holds a markdown report, a JSON copy for CI, and one runnable `curl` script per finding (`issue-repro/`). Drop `--defects` and a correct backend reports nothing across 55 checks.

Against your own API:

```bash
oat doctor --spec https://api.example.com/openapi.json
oat plan   --spec https://api.example.com/openapi.json
oat run    --config oat.config.ts
```

`doctor` is the adoption command. It runs offline against the spec alone and reports every coverage gap, naming the meta tag that would close it.

## Commands

```
oat run     --config <file>     test a live backend and write a report
oat plan    --spec <url|file>   derive and print the test model (offline)
oat doctor  --spec <url|file>   report what oat can and cannot test, and why
oat serve   [--defects A,B]     run the demo API
oat conformance                 self-test: injected defects vs detection
```

Useful flags:

| flag              |                                                                         |
| ----------------- | ----------------------------------------------------------------------- |
| `--config`        | config module (`.ts` / `.js` / `.mjs` / `.json`) with a default export  |
| `--spec`          | OpenAPI document, URL or path                                           |
| `--base-url`      | backend under test, overrides the config                                |
| `--only`          | comma-separated entity names                                            |
| `--out`           | report directory (default `./oat-out`)                                  |
| `--concurrency`   | entities tested in parallel (default 1)                                 |
| `--quiet`         | no live progress on stderr (`progress.log` is still written)            |
| `--keep-fixtures` | leave created records in place                                          |
| `--backend`       | conformance storage: `memory` \| `sqlite` \| `postgres` \| `d1`         |
| `--dialect`       | API shape: `postgrest` \| `classic` \| `linked` \| `jsonapi` \| `plain` |
| `--fuzz`          | inject random defect combinations                                       |
| `--precision`     | vary cohort data against a correct backend                              |

## Configuration

Two inputs, always: the spec, and a config file. oat never reads your source, assumes your framework, or hardcodes a route. Backend-specific knowledge lives in one of two places:

- **`x-*` tags in the spec** — optional; each degrades to a heuristic and reports the degradation rather than guessing silently. A complete worked document is [`labs/annotated-openapi.yaml`](./labs/annotated-openapi.yaml).
- **`oat.config.ts`** — auth, roots, and the one hook oat cannot infer: values delivered outside HTTP (verification tokens, OTPs).

A backend adopts oat by adding tags, not by adapting to oat.

Smallest useful config — a long-lived API key and two tenants, so isolation checks can run:

```ts
import { defineConfig } from "@lovrozagar/oat"

export default defineConfig({
	baseUrl: "https://api.example.com",
	spec: "https://api.example.com/openapi.json",
	principals: [
		{
			id: "alpha",
			headers: { authorization: `Bearer ${process.env.API_TOKEN}` },
			roots: { project_id: process.env.PROJECT_A },
		},
		{
			id: "beta",
			headers: { authorization: `Bearer ${process.env.API_TOKEN_B}` },
			roots: { project_id: process.env.PROJECT_B },
		},
	],
})
```

Multi-step login is a chain of operations. Values flow forward through `saveAs`; the credential is taken from the last response:

```ts
{
  id: "alpha",
  auth: {
    credentialFrom: "$.access_token",
    steps: [{ operationId: "auth.token", body: { key: process.env.API_KEY } }],
  },
  roots: { org_id: "org_alpha" },
}
```

`resolveOutOfBand` on the config is the hook for emailed tokens and OTPs. Credentials refresh from JWT `exp` before they expire. See [`labs/minimal.config.ts`](./labs/minimal.config.ts) and [`labs/anyrow.config.ts`](./labs/anyrow.config.ts).

## OpenAPI meta tags

Vendor-neutral `x-*` extensions oat reads from your spec. Every one is **optional**. Precedence is always: **explicit tag → heuristic → skip with a coverage gap**.

`oat conformance` loads [`labs/annotated-openapi.yaml`](./labs/annotated-openapi.yaml) and asserts the derived model matches what its comments claim, so the examples cannot drift from the implementation.

```bash
oat plan   --spec openapi.yaml
oat doctor --spec openapi.yaml
```

### `x-invalidate`

```yaml
x-invalidate:
  - GET /v1/projects/{project_id}/tables
  - GET /v1/projects/{project_id}/tables/{table_id}
```

`string[]` of `"METHOD /path"`. Names the read routes this mutation must change. Colon (`/tables/:id`) and brace (`/tables/{id}`) syntax both work; oat normalises to brace.

This is the entity graph. Inverted, it gives every entity its _read surface_ — the projections through which it is observable. Highest-value tag, and the one many specs already emit.

**Fallback:** pair a mutator with the sibling collection and item routes on the same path prefix. Catches the obvious cases, misses cross-entity effects.

### `x-entity`

```yaml
x-entity:
  name: table
  action: create # create | list | read | update | delete | action
  identity: id # optional; property that identifies an instance
```

Overrides path-segment entity inference. Needed when the path does not follow `/<plural>/{id}`.

`identity` matters when the item schema does not declare an `id` — for example free-form row objects.

**Fallback:** deepest plural segment + HTTP verb. Irregular paths (`/rows/aggregate`) yield nothing and lose lifecycle tracking.

### `x-invite`

```yaml
x-invite:
  invite: table.invite # operationId that creates the invite
  accept: invite.accept # operationId the invitee calls
  revoke: table.revoke # operationId that removes the grant
  granteeField: key # invite body field naming the invitee
  tokenPointer: $.token # where the accept token is
  grantPointer: $.grant_id # where the revoke handle is
```

Declares the delegated-access flow. oat asserts the timeline: the invitee cannot read before accept, can after, and cannot after revoke. Put the tag on the invite operation.

The invitee's config must set `inviteAs` to the value the invite body expects.

**Fallback:** the check does not run. There is no heuristic for a multi-step flow.

### `x-query`

```yaml
x-query:
  filterable: [id, name, slug, status, created_at]
  sortable: [name, created_at, updated_at]
  searchable: [name, slug]
  selectable: [id, name, slug, created_at]
  maxLimit: 100
  defaultOrder: created_at.desc
  stableTiebreak: id
```

Declares what the list endpoint's `filter` / `order` / `q` / `select` params actually support.

Without it, oat has to guess which fields are filterable from the item schema and will report false failures on fields the backend does not index.

`stableTiebreak` is load-bearing: if a sort has no total order, keyset pagination is unsound and page walks silently drop or duplicate rows. Declaring it lets oat assert it; omitting it makes oat test for the instability instead.

**Fallback:** if a filter / order / select / search _role_ resolves (`sort`, `fields`, `q`, `where`, …), treat every scalar property as filterable/sortable and warn. Pagination-only lists stay uncovered.

### `x-async`

```yaml
x-async:
  poll: "GET /v1/projects/{project_id}/batches/{batch_id}"
  idFrom: batch_id
  until: "status.in.complete,partial,failed"
  successWhen: "status.eq.complete"
  timeoutMs: 120000
  pollIntervalMs: 2000
```

Marks an operation whose HTTP response is a receipt, not an outcome. oat drives the poll to a terminal state, then treats that payload as the real result.

Without this, every extract / export / batch endpoint is untestable beyond "did it return 200".

**Fallback:** treated as synchronous; downstream assertions are marked `COVERAGE_GAP`.

### `x-effects`

```yaml
x-effects:
  - { entity: table, op: create, count: 1 }
  - { entity: delivery, op: append, count: 1 }
```

`x-invalidate` says _this GET changes_; `x-effects` says _how_. That is what lets oat assert an exact delta (`count 4 → 5`, new id present) instead of a weak body inequality.

Also tells oat to track and clean up resources created as side effects.

`op`: `create` | `append` | `update` | `delete` | `replace`.

**Fallback:** derived from `x-entity.action` for the operation's own entity only.

### `x-soft-delete`

```yaml
x-soft-delete: deleted_at
```

On the entity's delete (or any operation on the entity). Tells oat that DELETE tombstones rather than removes.

Changes the post-delete assertion from "absent everywhere" to "absent from the default list". Without this tag, correct soft-delete behaviour is reported as a bug.

### `x-immutable` / `x-generated`

```yaml
x-immutable: [id, project_id, created_at]
x-generated: [id, created_at, updated_at]
```

`x-generated` lets oat build valid create bodies without guessing, and assert the fields appear. `x-immutable` powers the update-safety case: PATCH each immutable field and require the stored value to be unchanged.

**Fallback:** `readOnly: true` is honoured as generated; no immutability testing without the tag.

### `x-tenant`

```yaml
x-tenant: project_id
```

Names the path parameter that scopes the operation to a tenant.

Drives the isolation matrix: a second principal in another tenant must not see, read, or mutate the record — and `filter=id.eq.<other tenant's id>` must return empty rather than becoming an authz bypass.

**Fallback:** regex over `{organization_id}`, `{project_id}`, `{tenant_id}`, `{workspace_id}`, `{app_slug}`. Without the tag, a cross-tenant read is an ambiguity, not a security finding.

### `x-root`

```yaml
x-root: true
```

On a **path parameter**, not an operation. Declares that this resource has no create endpoint and must be supplied by config.

**Fallback:** inferred when a path param has no discoverable create op; everything beneath it is reported `UNSEEDABLE`.

### `x-cost` / `x-destructive` / `x-idempotent`

```yaml
x-cost: high # low | medium | high
x-destructive: true # excluded outside --profile paranoid
x-idempotent: true # oat asserts repeat-equivalence
```

`x-cost: high` is why an extract runs once instead of inside a permutation loop.

### `x-cleanup`

```yaml
x-cleanup: "DELETE /v1/projects/{project_id}/tables/{table_id}"
```

Explicit teardown when the delete op is not discoverable from the entity graph.

**Fallback:** the entity's `delete` op; oat reports leaked resources at end of run if there is none.

### `x-fresh-principal`

```yaml
x-fresh-principal: true
```

Operation mutates session or principal state and must run against a freshly provisioned principal (login, logout, token refresh, key rotation).

## What gets tested

55 property checks. None of them needs ground truth about what your data "should" be. A filter and its negation must partition the set; a page walk must cover the collection; a record read four ways must read the same.

| group              | examples                                                         |
| ------------------ | ---------------------------------------------------------------- |
| Foundations        | create lands, schema matches, page size is honoured              |
| Query, single axis | filter, sort, search, select, cursor vs page, count              |
| Query, composition | filter+sort, filter+select, search+filter, and the triples       |
| Spec as adversary  | declared filterable / sortable / selectable fields actually work |
| Isolation          | cross-tenant item, filter, and existence disclosure              |
| Authorization      | rank is monotonic; invite grants then revokes                    |
| Tagged behaviour   | immutable, soft-delete, invalidate, effects, async               |
| Validation         | enum, maxLength, required, content-type                          |
| Writes             | PATCH minimality, idempotency, delete 404, lost update           |

Every check reaches a stated outcome: a finding, _did not apply_ (with what it needed), _blocked by an earlier failure_ (with the cause), or _could not conclude_ (with why). None of the last three is a pass.

Findings are graded by how much the document states. A cross-tenant read is a security finding when `x-tenant` declares the boundary, and an ambiguity when oat only inferred it.

## Reports

A run writes:

| file                       |                                                               |
| -------------------------- | ------------------------------------------------------------- |
| `oat-out/oat-report.md`    | human report                                                  |
| `oat-out/oat-report.json`  | CI / machine copy                                             |
| `oat-out/issue-repro/*.sh` | one `curl` script per finding — omitted when the run is clean |
| `oat-out/progress.log`     | live logfmt progress (also `.jsonl` and `.tsv`)               |

Cascade suppression is transitive: one root cause produces one finding, not a page of consequences.

## Conformance

oat ships four reference backends — memory, SQLite, Postgres, and Cloudflare D1 — behind the same HTTP surface and the same 56 named defects. `oat conformance` injects each defect and asserts the matching diagnosis, then runs a correct backend and asserts nothing is reported.

They are served in five dialects (`postgrest`, `classic`, `linked`, `jsonapi`, `plain`) so a check that only works on one spelling is visible.

```bash
npm test                         # memory + sqlite, every dialect
oat conformance --fuzz 300       # random defect combinations
oat conformance --precision 60   # varied data, correct backend — any finding is a false positive
```

The testing path never touches a database. Runtime dependencies are `ajv`, `ajv-formats`, and `yaml`. SQL drivers are optional and loaded on demand.

## What this is not

oat is not a fuzzer. Tools like [Schemathesis](https://schemathesis.readthedocs.io/) generate inputs from your schema and check that responses validate — that finds crashes, 500s, and schema drift. Run both.

The difference is _statefulness_. A fuzzer sends independent requests and has no model of what the API should now contain, so it cannot ask whether the record it just created appears in the listing, whether a filter and its negation partition the set, or whether another tenant can read a record they should not see.

|                                         | schema fuzzers   | oat                                   |
| --------------------------------------- | ---------------- | ------------------------------------- |
| multi-step auth                         | header injection | declarative chain, JSON-path binding  |
| out-of-band token                       | —                | `resolveOutOfBand` hook               |
| credential refresh                      | —                | JWT `exp`, refreshes before expiry    |
| expected-state oracle                   | none             | shadow model of everything it created |
| N live principals                       | —                | peer tenants + optional rank lattice  |
| cross-tenant read / filter / disclosure | —                | 3 checks                              |
| stateful invariants                     | random walk      | 55 property checks                    |
| N-role permission matrix                | —                | monotonicity over `rank`              |
| invite / delegated access               | —                | `x-invite` timeline                   |

## Labs

[`labs/`](./labs) is a family of real Hono backends on Cloudflare D1, used to iterate oat against correct APIs and planted bugs. Schema is generated from [`labs/worlds/catalog.ts`](./labs/worlds/catalog.ts). See [`labs/README.md`](./labs/README.md).

## License

MIT
