# oat

[![npm](https://img.shields.io/npm/v/@lovrozagar/oat.svg)](https://www.npmjs.com/package/@lovrozagar/oat)

```bash
npm i -D @lovrozagar/oat
```

OpenAPI Tester — live **matrix testing** of a backend against its own OpenAPI document.

It reads the spec, talks to the running API, and treats every way to see a record as a cell in a matrix. Then it checks that those cells agree. It does not read your source, assume your framework, or hardcode a route.

A single-response check asks _did this JSON match its schema?_ oat asks that on every request it sends — generated bodies, 4xx probes, 500s, documented statuses. Most production bugs still pass that test:

- the row is on `GET /tables/{id}` and missing from `GET /tables`
- `?filter=status.eq.nope` returns every row (the backend dropped the param)
- `limit=2` yields 9 rows; `limit=100` yields 10 (the sort has no total order)
- `PATCH { name }` also cleared `instruction`
- `?filter=id.eq.<another tenant's id>` returns the row

Those are disagreements between **projections of the same fact**. That is the matrix.

**How the matrix is built.** oat inverts `x-invalidate` (or path heuristics) into an entity graph. Each entity gets a _read surface_: collection, item, filter, sort, page, cursor, select, search, parent routes, other tenants. It seeds a discriminating cohort (values whose lexical and numeric order disagree, LIKE metacharacters, unicode, nulls). Then it walks:

- **foundations** — create landed, the page walk covers the set, equality selects one, sort actually sorts
- **composition** — filter+sort, filter+select, search+filter, the triples; a filter must apply to the _collection_, not to the current page
- **writes** — PATCH is minimal, immutable fields stay put, two PATCHes do not clobber, replay does not duplicate
- **isolation** — a second principal with different `roots`, a same-tenant rank lattice, an invite that grants and then revokes
- **spec as adversary** — every field you _declared_ filterable / sortable / selectable actually is

There is no ground-truth database. A filter and its negation must partition the set. A page walk must cover the collection without gaps or dupes. List, item, and `id.eq.` must show the same field. One root cause is one finding; checks that depend on a broken primitive are `BLOCKED`, not a page of copies.

This file is the operator manual. An agent that has read it can install oat, write every kind of config, run every command, tag a document, interpret every outcome, and know what each check needs and asserts.

## Table of contents

- [Install](#install)
- [How a run works](#how-a-run-works)
- [Quick start](#quick-start)
- [Complete configs](#complete-configs)
- [Commands](#commands)
  - [oat run](#oat-run)
  - [oat doctor](#oat-doctor)
  - [oat plan](#oat-plan)
  - [oat serve](#oat-serve)
  - [oat conformance](#oat-conformance)
- [Configuration](#configuration)
  - [Top-level fields](#top-level-fields)
  - [Principals](#principals)
  - [Auth flows](#auth-flows)
  - [Hooks](#hooks)
  - [Environment interpolation](#environment-interpolation)
  - [Loading TypeScript configs](#loading-typescript-configs)
- [How the model is derived](#how-the-model-is-derived)
- [Seeding](#seeding)
- [Query roles and grammars](#query-roles-and-grammars)
- [Pagination and envelopes](#pagination-and-envelopes)
- [OpenAPI meta tags](#openapi-meta-tags)
- [Checks](#checks)
- [Verdicts, skips, and exit codes](#verdicts-skips-and-exit-codes)
- [Reports](#reports)
- [Progress logs](#progress-logs)
- [Programmatic API](#programmatic-api)
- [CI](#ci)
- [Reference defects (`oat serve --defects`)](#reference-defects-oat-serve---defects)
- [Limits and non-features](#limits-and-non-features)
- [Compared to schema fuzzers](#compared-to-schema-fuzzers)
- [Labs](#labs)
- [License](#license)

## Install

```bash
npm i -D @lovrozagar/oat
```

Requires **Node.js 20+**. The published CLI is compiled JavaScript; `npx oat` / `./node_modules/.bin/oat` is the entry.

The unscoped name `oat` on npm is a different project. Always install `@lovrozagar/oat`. The binary on PATH is still `oat`.

SQLite conformance (`npm test`, `oat conformance` with the sqlite backend) needs `node --experimental-sqlite` on Node 22. The published `oat` binary does not pass that flag for you; `npm test` in this repo does.

```bash
oat help          # same as oat --help
oat --help
```

Unknown commands and missing required flags exit `2`.

## How a run works

1. **Load** the OpenAPI document (URL or path). Internal `$ref`s are inlined. External `$ref`s are reported, never fetched.
2. **Model** entities by inverting `x-invalidate` (or path heuristics) into a read surface per entity.
3. **Authenticate** every configured principal (static headers and/or an auth flow). Credentials refresh themselves before they expire.
4. **Seed** a cohort of records per entity, in parent-before-child order, using each entity's create operation.
5. **Test** the matrix, one entity at a time: foundations first, then composition, writes, isolation, declared effects. Checks inside an entity stay ordered. Entities may run in parallel (`concurrency`).
6. **Teardown** everything the run created, unless `--keep-fixtures` / `keepFixtures: true`.

The first principal is the writer. Isolation needs a second principal with different `roots`. A rank lattice needs two or more principals that share `roots` and differ in `rank`. Invite checks need `x-invite` plus a peer with `inviteAs`.

oat never needs ground truth about your data. A filter and its negation must partition the set; a page walk must cover the collection; a record read four ways must read the same.

oat does **not** use OpenAPI `security` / `securitySchemes`, `servers[]`, cookies, webhooks, callbacks, or `links`. Auth is the config. The origin is `baseUrl`. Request bodies it sends are JSON.

## Quick start

The package ships a demo API (the same reference backend the self-test uses):

```bash
# terminal 1 — prints a url, spec, and demo keys
oat serve --defects STALE_LIST,PATCH_REPLACES

# terminal 2
oat run --config node_modules/@lovrozagar/oat/labs/local.config.ts --base-url <url from serve>
```

Inside this repository (after `npm run build`):

```bash
oat serve --defects STALE_LIST,PATCH_REPLACES
oat run --config labs/local.config.ts --base-url <url>
```

`oat serve` with no `--defects` is a correct backend. The suite should report nothing.

Against your API:

```bash
oat doctor --spec https://api.example.com/openapi.json
oat plan   --spec https://api.example.com/openapi.json
oat run    --config oat.config.ts
```

`doctor` is the adoption command. It runs offline against the spec alone and reports every coverage gap, naming the tag that would close it.

## Complete configs

These are copy-paste starting points. Real configs import `defineConfig` from `@lovrozagar/oat`. Files inside this repository import from `../dist/index.js` because they live in the source tree.

### Static API keys, two tenants (smallest useful)

```ts
// oat.config.ts
import { defineConfig } from "@lovrozagar/oat"

export default defineConfig({
	spec: "https://api.example.com/openapi.json",
	baseUrl: "https://api.example.com",
	principals: [
		{
			id: "alpha",
			headers: { authorization: "Bearer ${API_TOKEN}" },
			roots: { project_id: "${PROJECT_A}" },
		},
		{
			id: "beta",
			headers: { authorization: "Bearer ${API_TOKEN_B}" },
			roots: { project_id: "${PROJECT_B}" },
		},
	],
})
```

```bash
export API_TOKEN=… API_TOKEN_B=… PROJECT_A=proj_a PROJECT_B=proj_b
oat run --config oat.config.ts
```

One principal is enough to seed and run CRUD / query / schema checks. The second principal, with different `roots`, is what makes `tenant.*` run. Without it those checks are **did not apply**, not a pass.

Shipped as `labs/minimal.config.ts` (and in the npm package).

### JSON config

Same object. `${NAME}` is interpolated after load. There is no `defineConfig` wrapper.

```json
{
	"spec": "https://api.example.com/openapi.json",
	"baseUrl": "https://api.example.com",
	"principals": [
		{
			"id": "alpha",
			"headers": { "authorization": "Bearer ${API_TOKEN}" },
			"roots": { "project_id": "${PROJECT_A}" }
		}
	],
	"seed": 42,
	"cohortSize": 7,
	"concurrency": 1,
	"outDir": "./oat-out"
}
```

```bash
oat run --config oat.config.json
```

### Demo server (operation-id login)

Shipped as `labs/local.config.ts`. Points at `oat serve`.

```ts
import { defineConfig } from "@lovrozagar/oat"

export default defineConfig({
	spec: "/v1/openapi/spec",
	baseUrl: "http://127.0.0.1:8787",
	seed: 42,
	principals: [
		{
			id: "alpha",
			roots: { project_id: "proj_alpha" },
			auth: {
				credentialFrom: "$.access_token",
				steps: [{ operationId: "auth.token", body: { key: "key_alpha" } }],
			},
		},
		{
			id: "beta",
			roots: { project_id: "proj_beta" },
			auth: {
				credentialFrom: "$.access_token",
				steps: [{ operationId: "auth.token", body: { key: "key_beta" } }],
			},
		},
	],
})
```

`spec: "/v1/openapi/spec"` is resolved against `baseUrl`. `--base-url` on the CLI overrides the origin without editing the file.

### Two tenants plus a same-tenant rank lattice

See [Principals](#principals). Isolation keys off `roots`. Rank keys off `rank` with shared `roots`.

## Commands

```
oat run          --config <file>     test a live backend and write a report
oat doctor       --spec <url|file>   what oat can and cannot test, and why
oat plan         --spec <url|file>   print the derived model (offline)
oat serve        [--defects A,B]     run the demo API
oat conformance                      self-test: injected defects vs detection
oat help
```

`--spec` for `doctor` / `plan` can be replaced by `--config` (the spec is read from the config). `--json` makes those two commands emit machine-readable output. `--base-url` on `doctor` / `plan` is only used to resolve a relative spec path.

`--untagged` is a **serve** flag (and a conformance concern). It is not a `run` flag.

### `oat run`

Requires `--config`. CLI flags override the same field in the config when both are set.

| flag              | default                        | meaning                                                                                                                                      |
| ----------------- | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `--config`        | required                       | module or JSON file, default export                                                                                                          |
| `--base-url`      | `config.baseUrl`               | backend origin                                                                                                                               |
| `--only`          | `config.only` or all entities  | comma-separated entity names as `oat plan` prints them (singularised)                                                                        |
| `--seed`          | `config.seed` or `1`           | fixture generation seed (reproducible)                                                                                                       |
| `--out`           | `config.outDir` or `./oat-out` | report directory                                                                                                                             |
| `--concurrency`   | `config.concurrency` or `1`    | entities in parallel. Use `1` on nested graphs; higher values insert children while a parent page-walk is running and invent pagination bugs |
| `--max-in-flight` | `config.maxInFlight` or `4`    | HTTP requests allowed at once                                                                                                                |
| `--keep-fixtures` | `config.keepFixtures` or false | do not DELETE what the run created                                                                                                           |
| `--quiet`         | false                          | no stderr progress; files under `--out` still update                                                                                         |

**Exit codes:** `0` no defects, `1` at least one root-cause finding (`BACKEND_BUG`, `SPEC_BUG`, `SECURITY`, `AMBIGUITY`), `2` usage error (missing `--config`, no principals). `COVERAGE_GAP` and `BLOCKED` do not fail the process.

Example:

```bash
oat run --config oat.config.ts --only store,product --concurrency 1 --out oat-out/prod
```

`--only store,product` matches the **entity names** from `oat plan`, not path segments. `/v1/stores` is usually the entity `store`. If a name is unknown, that entity is simply not tested (the others still run).

A run with no principals exits `2`. Isolation checks then need a second principal; they are skipped, not failed, when only one is present.

### `oat doctor`

Offline. Loads the document, builds the model, prints coverage.

```bash
oat doctor --spec https://api.example.com/openapi.json
oat doctor --config oat.config.ts --json
oat doctor --spec ./openapi.yaml --base-url https://api.example.com
```

Human output:

- `trackable` — entities with an identity and a read surface
- `listable` — those that also have a list (query checks need this)
- tags that are absent, and the checks each tag would unlock
- tags that would **sharpen** checks that already run (`x-query`, `x-tenant`)
- per-operation gaps (`x-entity` could not be inferred, assumed tenant param, …)
- external `$ref`s that were not fetched

`--json` shape:

```json
{
	"blocking": 1,
	"entities": 12,
	"trackableEntities": 10,
	"testableEntities": 10,
	"listableEntities": 8,
	"roots": ["organization_id"],
	"externalRefs": ["https://example.com/shared.yaml"],
	"gaps": [{ "operationId": "table.list", "tag": "x-query", "detail": "…" }]
}
```

Exit `1` if there are **blocking** gaps: entities that are not trackable (no identity / no read), or the document has roots oat cannot create. Advisory gaps (missing `x-query`, no `x-async`) print and still exit `0`.

### `oat plan`

Offline. Prints the derived entity graph, operations, and query capability.

```bash
oat plan --spec ./openapi.yaml
oat plan --config oat.config.ts --json
```

Human columns:

```
entity              CLRUD  ident      read surface
store               CLRU·  id         2 route(s) (inferred)
                                      GET /v1/stores
                                      GET /v1/stores/{store_id}
```

`CLRUD` is Create / List / Read / Update / Delete. `·` means that slot is missing. `ident` is the identity property. Read surface is declared (`x-invalidate`) or inferred (sibling collection/item routes).

`--json` is `{ entities, operations, roots }` — the full `SpecModel` maps, including conventions, query capability, async, invite, and path params. Use this when you need to know what oat will call something.

### `oat serve`

In-process demo API. Same fixture as conformance.

```bash
oat serve
oat serve --defects STALE_LIST,PATCH_REPLACES
oat serve --backend sqlite --dialect classic
oat serve --untagged
```

| flag         | default     | meaning                                                                                |
| ------------ | ----------- | -------------------------------------------------------------------------------------- |
| `--backend`  | `memory`    | `memory` \| `sqlite` \| `postgres`                                                     |
| `--dialect`  | `postgrest` | `postgrest` \| `classic` \| `linked` \| `jsonapi` \| `plain`                           |
| `--defects`  | none        | comma-separated names from [Reference defects](#reference-defects-oat-serve---defects) |
| `--untagged` | false       | serve the same API behind a spec with every `x-*` tag stripped                         |

Printed keys: `key_alpha` (tenant `proj_alpha`), `key_beta` (tenant `proj_beta`). Spec: `{url}/v1/openapi/spec`. Stop with ctrl-c.

`labs/local.config.ts` is written for this server.

Dialects are **reference-backend shapes**, not something you configure against your API. They exist so conformance proves checks read the document rather than one fixture's spelling:

| dialect     | filter                      | sort       | select           | page model          | envelope                          |
| ----------- | --------------------------- | ---------- | ---------------- | ------------------- | --------------------------------- |
| `postgrest` | `filter=status.eq.active`   | `name.asc` | `select=id,name` | `page` + `cursor`   | entity-named + `count`/`hasMore`  |
| `classic`   | `filter=status=eq:active`   | `sort=`    | `fields=`        | `page` + `per_page` | `{ data, total_count, has_more }` |
| `linked`    | postgrest                   | dotted     | `fields=`        | `offset` + `limit`  | raw array + `Link: rel=next`      |
| `jsonapi`   | postgrest                   | `-name`    | `fields[table]=` | `page` + `size`     | `{ data, total, has_more }`       |
| `plain`     | `?status=active` (equality) | `name:asc` | `fields=`        | `page` + `limit`    | `{ items, total, has_more }`      |

`postgres` needs a server on the default `postgres` database (local, default `postgres` driver connection). `sqlite` needs Node's `node:sqlite` (`--experimental-sqlite` on Node 22). Missing backends fail at serve time rather than falling back.

### `oat conformance`

Self-test. Not for your API. Injects named defects into the reference backend and asserts oat reports the matching check.

```bash
# this repo
npm test

# after install, from a checkout with --experimental-sqlite if you want sqlite
oat conformance
oat conformance --backend memory --dialect plain
oat conformance --fuzz 300 --max-defects 12 --seed 7
oat conformance --precision 60 --backend memory
oat conformance --parser
oat conformance --backend d1
oat conformance --only STALE_LIST,PATCH_REPLACES
```

| flag              | meaning                                                                                                                            |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `--backend`       | `memory` \| `sqlite` \| `postgres` \| `d1`. Default: every _local_ backend that is available. `d1` is never default — it is remote |
| `--dialect`       | pin one shape; default runs postgrest on each backend plus classic/linked/jsonapi/plain on memory                                  |
| `--fuzz [n]`      | random _sets_ of defects (default 25 if flag is bare)                                                                              |
| `--max-defects`   | cap per fuzz combination (default 4)                                                                                               |
| `--precision [n]` | vary _data_ against a correct backend; any finding is a false positive (default 50 if flag is bare)                                |
| `--seed`          | replay a fuzz/precision run                                                                                                        |
| `--parser`        | only the hostile-document + example-spec + tag-unlock suites                                                                       |
| `--only`          | restrict injected defects (comma-separated `STALE_LIST,…`)                                                                         |

A default `oat conformance` (no `--fuzz` / `--precision` / `--parser`) also runs a 40-case combination smoke on memory after the one-at-a-time matrix.

D1 needs `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_D1_DATABASE_ID`, `CLOUDFLARE_API_TOKEN`. Postgres needs a reachable server on the default connection (`database: "postgres"`). Missing backends are skipped with a printed reason, not treated as a pass.

`--parser` still always runs first (hostile documents, `labs/annotated-openapi.yaml` model lock, tag-unlock map). Exit `1` if any parser, matrix, fuzz, or precision case fails.

## Configuration

Two inputs, always: **the spec** and **a config file**. Backend-specific knowledge lives in `x-*` tags and this file. A backend adopts oat by adding tags, not by adapting to oat.

A config is:

- `.ts` / `.js` / `.mjs` with `export default defineConfig({ ... })`, or
- `.json` with the same object.

Named export without `default` is also accepted (`module.default ?? module`).

### Top-level fields

```ts
import { defineConfig } from "@lovrozagar/oat"

export default defineConfig({
	spec: "https://api.example.com/openapi.json", // URL or filesystem path; JSON or YAML
	baseUrl: "https://api.example.com",
	principals: [/* at least one; see below */],
	hooks: {/* optional */},
	globalHeaders: { "x-request-id": "oat" }, // sent on every request; oat does not inspect them
	roots: { org_id: "org_shared" }, // path params oat cannot create; also declarable via x-root
	seed: 42, // fixture generation; a failing run with the same seed is identical
	cohortSize: 12, // records created per entity (default 7)
	concurrency: 1, // entities in parallel
	maxInFlight: 4, // HTTP in flight
	only: ["store", "product"], // restrict entities
	keepFixtures: false,
	outDir: "./oat-out",
})
```

| field           | required | default     | notes                                                           |
| --------------- | -------- | ----------- | --------------------------------------------------------------- |
| `spec`          | yes      |             | See [Spec loading](#spec-loading)                               |
| `baseUrl`       | yes      |             | Origin. OpenAPI `servers[]` is ignored                          |
| `principals`    | yes      |             | Non-empty. First is the writer                                  |
| `hooks`         | no       |             | `resolveOutOfBand`, `teardownPrincipal`                         |
| `globalHeaders` | no       | `{}`        | Merged under per-request headers. Opaque to oat                 |
| `roots`         | no       | `{}`        | Shared path params (merged with each principal's `roots`)       |
| `seed`          | no       | `1`         | Integer. Same seed → same fixture bodies                        |
| `cohortSize`    | no       | `7`         | Sliced from the 7 built-in variants. Larger repeats the pattern |
| `concurrency`   | no       | `1`         | Entity-level only. Checks inside one entity stay ordered        |
| `maxInFlight`   | no       | `4`         | Across the whole run                                            |
| `only`          | no       | all         | Entity names from `oat plan`                                    |
| `keepFixtures`  | no       | `false`     | Skip DELETE at the end                                          |
| `outDir`        | no       | `./oat-out` | Created if missing                                              |

`spec` may be a path relative to `baseUrl` (`/v1/openapi/spec`) or an absolute URL or a file.

CLI `--base-url`, `--only`, `--seed`, `--out`, `--concurrency`, `--max-in-flight`, `--keep-fixtures` override these when passed.

### Spec loading

Resolved in this order, never by guessing the string's "look":

1. Absolute `http(s)://` or `file://` — used as given.
2. A path that exists on disk, relative to the working directory.
3. Anything else, when `baseUrl` is known — resolved against it (`/v1/openapi/spec`, `openapi.json`).

JSON if the first non-space character is `{` or `[`, otherwise YAML. Empty files error. A JSON document with more opening than closing brackets is diagnosed as truncated (proxy / download limit), not as a syntax error.

OpenAPI 3.0 and 3.1 both work. oat reads `paths`, operations, parameters, request/response JSON schemas, and `x-*` extensions. It does not require a particular `openapi:` version string.

Internal `$ref`s are dereferenced. External `$ref`s stay unresolved and show up in `oat doctor` / the JSON `externalRefs` list.

### Principals

```ts
{
  id: "alpha",                          // required, stable name in reports
  headers: { authorization: "Bearer …" }, // static; enough for a long-lived key
  auth: { /* AuthFlow — see below */ },
  roots: { org_id: "org_alpha" },       // this principal's tenant / path params
  rootsFromFlow: { org_id: "orgId" },   // take path params from values the auth flow bound
  role: "owner",                        // free-form label in reports
  rank: 2,                              // higher can do everything a lower rank can; default 0
  inviteAs: "key_beta",                 // how an owner names this principal in an invite body
}
```

Rules that matter:

- **Isolation** (`tenant.*`) needs two principals whose `roots` differ.
- **Rank** (`auth.rank-is-monotonic`) needs two principals with the _same_ `roots` and different `rank`.
- **Invite** (`auth.invite-grants-then-revokes`) needs `x-invite` on the spec and a _different-tenant_ principal with `inviteAs` set.
- Extra principals are not ignored. Isolation picks the first different-`roots` peer. Rank uses the same-tenant pair.
- `headers` and `auth` compose: static headers are sent, then the flow's credential header is merged on top.
- A principal with only `headers` (no `auth`) never hits a login route.

Example — two tenants plus a same-tenant lattice:

```ts
principals: [
	{
		id: "alpha",
		role: "owner",
		rank: 2,
		auth: {
			credentialFrom: "$.access_token",
			steps: [{ operationId: "auth.token", body: { key: "key_alpha" } }],
		},
		roots: { org_id: "org_alpha" },
	},
	{
		id: "alpha_member",
		role: "member",
		rank: 1,
		auth: {
			credentialFrom: "$.access_token",
			steps: [{ operationId: "auth.token", body: { key: "key_alpha_member" } }],
		},
		roots: { org_id: "org_alpha" },
	},
	{
		id: "beta",
		role: "owner",
		rank: 2,
		inviteAs: "key_beta",
		auth: {
			credentialFrom: "$.access_token",
			steps: [{ operationId: "auth.token", body: { key: "key_beta" } }],
		},
		roots: { org_id: "org_beta" },
	},
]
```

### Auth flows

```ts
auth: {
  steps: [ /* at least one */ ],
  credentialFrom: "$.access_token", // JSON path in the last (or saved) response
  expiresInFrom: "$.expires_in",    // lifetime in seconds
  header: "authorization",          // default
  template: "Bearer {credential}",  // default
  assumeTtlMs: 3600000,             // used only if neither expiresInFrom nor JWT exp is present
}
```

Expiry is `expiresInFrom` (seconds) → JWT `exp` claim → `assumeTtlMs`. Refresh happens before dispatch, at roughly three quarters of the assumed window (`assumeTtlMs` default 300000 ms when used as the window), never by retrying a 401.

Each step is one of:

**Operation step** (prefer this — survives the path moving):

```ts
{
  operationId: "auth.token",
  body: { key: "${API_KEY}" },
  headers: { "x-extra": "1" },
  query: { realm: "test" },
  saveAs: { token: "$.access_token" },
  saveClaimsFrom: { token: "$.access_token", bind: { orgId: "orgs.0.oid" } },
  bind: { address: "user@example.test" }, // literals, with {name} interpolation
  expect: [200],                            // default: any 2xx
}
```

**Request step** (when the document has no auth operations):

```ts
{
  method: "POST",
  path: "/v1/auth/register/email",
  body: { email: "{address}", password: "…" },
  bind: { address: "oat-alpha@example.test" },
}
```

**Out-of-band step** (email link, OTP — oat cannot collect this itself):

```ts
{ outOfBand: { address: "{address}", kind: "email-verify", as: "verifyToken" } }
```

Later steps interpolate `{name}` from the flow scope. `saveAs` paths are `$.foo.bar` / `$.orgs.0.id` (dot + numeric index only; no JSON Pointer, no filters). `saveClaimsFrom` reads a JWT's _claims_ (signature is not verified — oat is reading its own credential). `rootsFromFlow` maps path parameter names to those bound keys.

`bind` on a step runs **before** the request. `saveAs` / `saveClaimsFrom` run **after**. `credentialFrom` is read from the last HTTP response unless a step already saved `credential`.

If a step's status is not acceptable, auth fails the run (not a finding): `oat: principal "alpha" failed at auth step 2 (POST /v1/…)`.

A complete register → verify → use-claims example:

```ts
function signUp(email: string): AuthFlow {
	return {
		credentialFrom: "$.access_token",
		expiresInFrom: "$.access_token_expires_in",
		steps: [
			{
				bind: { address: email },
				body: { email, password: "…" },
				method: "POST",
				path: "/v1/auth/register/email",
			},
			{ outOfBand: { address: email, as: "verifyToken", kind: "email-verify" } },
			{
				body: { token: "{verifyToken}" },
				method: "POST",
				path: "/v1/auth/email/verify",
				saveClaimsFrom: {
					token: "$.access_token",
					bind: { orgId: "orgs.0.oid", projectId: "orgs.0.pids.0" },
				},
			},
		],
	}
}

principals: [
	{
		id: "alpha",
		auth: signUp("oat-alpha@example.test"),
		rootsFromFlow: { organization_id: "orgId", project_id: "projectId" },
	},
]
```

The address used for `teardownPrincipal` is `scope.address` or `scope.email` (set via `bind: { address }` or `bind: { email }`).

### Hooks

```ts
hooks: {
  // Return null to retry (attempt is 1-based). oat backs off until a value arrives.
  resolveOutOfBand: async ({ address, kind, attempt }) => {
    const token = await readMailCatcher(address, kind)
    return token // or null
  },
  // Remove a principal this run provisioned (and everything it created).
  teardownPrincipal: async (address) => {
    await fetch(`https://api.example.com/test/cleanup?email=${address}`, { method: "DELETE" })
  },
}
```

Without `resolveOutOfBand`, an `outOfBand` step cannot complete. oat polls the hook up to **6** times: 200 ms, then doubling, capped at 3000 ms. Returning `""` is treated like `null`.

Without `teardownPrincipal`, provisioned accounts are reported as leftover rather than cascade-deleted. Per-record DELETE still runs for seeded rows when a delete (or `x-cleanup`) exists.

### Environment interpolation

After the module loads, every string in the config is scanned for `${NAME}`:

```ts
headers: {
	authorization: "Bearer ${API_TOKEN}"
}
```

If `API_TOKEN` is unset, oat exits with an error. Do not commit secrets; put them in the environment.

Template literals in a `.ts` config (`Bearer ${process.env.API_TOKEN}`) are evaluated by Node _before_ oat sees the object. Either style works; `${NAME}` is what a `.json` config can use.

Names match `[A-Z0-9_]+` case-insensitively.

### Loading TypeScript configs

`.js` / `.mjs` / `.json` load everywhere.

`.ts` configs require a runtime that can import TypeScript: Node 22.6+ with `--experimental-strip-types`, or Node 23+. The published `oat` binary is itself JS; it still has to `import()` your config. If that fails, the error says so. Workaround: compile the config, or write `.mjs`.

```bash
node --experimental-strip-types ./node_modules/@lovrozagar/oat/dist/cli.js run --config oat.config.ts
```

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

See [OpenAPI meta tags](#openapi-meta-tags). Fallbacks:

- `readOnly: true` counts as generated (omitted from create bodies).
- No immutability testing without `x-immutable`.
- Tenant param: `x-tenant` or a path param matching `org|organization|tenant|workspace|account|project|app` + optional `_id`/`_slug`. Inferred tenants make a cross-tenant read `AMBIGUITY`, not `SECURITY`. With neither a tag nor an inferred name, the check does not apply.

### Idempotency

No meta tag. If create declares a header matching `Idempotency-Key` / `Idempotence-Key` / `X-Idempotency-Key` (spaces ignored, case-insensitive), `idempotency.replay-does-not-duplicate` runs.

## Seeding

Per entity, oat POSTs the create body built from the request JSON schema.

Default cohort is **7** records, one of each variant, sliced by `cohortSize`:

| variant         | what it is for                                     |
| --------------- | -------------------------------------------------- |
| `baseline`      | `"Quarterly Report N"`                             |
| `lexical-first` | sorts first (`"aaa first alphabetically"`)         |
| `lexical-last`  | sorts last (`"zzz last alphabetically"`)           |
| `null-heavy`    | `null` on every nullable field                     |
| `unicode`       | `"日本語 café ñandú"`                              |
| `metacharacter` | `"100% _off_ *everything*"` — LIKE / escape probes |
| `boundary`      | empty / maxLength / numeric `maximum`              |

Numbers use the ladder `1, 2, 5, 10, 20, 50, 100` so **lexical order ≠ numeric order** (otherwise a TEXT compare looks correct). Enums walk `index % enum.length`. `readOnly` / `x-generated` fields are omitted. Required fields that cannot be generated get a type fallback (`0`, `false`, `[]`, `{}`, `"value"`). Arrays honour `minItems` (never send `[]` when `minItems ≥ 1`). Nested objects stop at depth 4.

Parent path parameters are created first (depth-first through the owning entity's create). Config / principal `roots` fill parameters oat cannot create.

A create that returns `>= 300` on the first variant fails the entity (downstream checks `BLOCKED`). Later variants that fail just shorten the cohort — a partial cohort is still used.

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
| limit (page size) | `limit`, `per_page`, `page_size`, `pagesize`, `count`, `max_results`, `top`, `size` |
| page              | `page`, `page_number`, `pagenum`, `p`                                               |
| offset            | `offset`, `skip`, `start`, `from`                                                   |
| cursor            | `cursor`, `after`, `starting_after`, `next`, `page_token`, `continuation`           |

A bracketed suffix is a _value_ in the name (`fields[articles]`, `filter[status]`), not part of the role. `count` is a page size only when it looks like one (has `maximum` or a default); otherwise it is treated as a total.

A bounded integer with a default that matches no alias is still taken as page size. A 1-based integer with no maximum is taken as page number.

**Filter grammars** — how oat **writes** a term:

| name        | `eq` / `neq` / `gt` / `like` example                                      | `and` / `or`                       |
| ----------- | ------------------------------------------------------------------------- | ---------------------------------- |
| `postgrest` | `filter=status.eq.active`, `name.neq.x`, `price.gt.10`, `name.like.*foo*` | `and(a.eq.1,b.eq.2)`, `or(...)`    |
| `colon`     | `filter=status=eq:active` (comma-joined terms; no grouping)               | not expressible; those checks skip |
| `equality`  | `?status=active` (one query param per field). Only `eq` is expressible    | not expressible                    |

Operators oat can emit: `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `like`. Anything else a check needs that the grammar cannot write becomes **did not apply**, not a failed request.

**Sort grammars:** `name.asc` (dotted), `-name` (prefixed / JSON:API; ascending is the bare name), `name:asc` (colon), `name asc` (spaced).

**Select grammars:** `id,name` (csv) or `fields[table]=id,name` (bracketed). If the parameter is already named `fields[articles]`, that name is used verbatim.

### How a grammar is inferred

`x-query.grammar` wins when it is `postgrest` | `colon` | `equality`.

Otherwise oat concatenates the filter/order/select parameter's `example`, `examples`, and `description`:

- Filter: `/postgrest/i` or `field.op.value` / `status.eq.active` → `postgrest`; `status=eq:` → `colon`; else `equality`. A free-text `filter` string that still looks like equality produces an `x-query` gap telling you to declare the grammar.
- Sort: `name.asc` → dotted; `name:desc` → colon; `name desc` → spaced; leading `-field` → prefixed; else dotted.
- Select: parameter name or description contains `fields[…]` → bracketed; else csv.

Without `x-query`, if a filter/order/select/search role resolves, oat assumes **every scalar** is filterable/sortable/selectable (`string` / `number` / `integer` / `boolean`, including nullable unions). Searchable-without-tag is further narrowed to names matching `name|title|slug|label|description|email`. `doctor` warns. Pagination-only lists stay uncovered.

Searchable / filterable / sortable / selectable from the tag are used as given. `maxLimit` is also taken from a page-size parameter's `schema.maximum` when the tag omits it.

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

Success schema is the first JSON media type on responses `200`, `201`, `202`, `2XX`, or `default`. Request schema is the first JSON media type on `requestBody`. Non-JSON media types are ignored.

## OpenAPI meta tags

Vendor-neutral `x-*` extensions. Every one is optional. Precedence: **explicit tag → heuristic → skip with a coverage gap**.

A complete document with every tag in place is shipped as `labs/annotated-openapi.yaml` (also in the npm package). `oat conformance` asserts the derived model matches that file.

```bash
oat plan   --spec node_modules/@lovrozagar/oat/labs/annotated-openapi.yaml
oat doctor --spec node_modules/@lovrozagar/oat/labs/annotated-openapi.yaml
```

What each tag **unlocks** (otherwise the check cannot run):

| tag             | checks unlocked                                                                                                          |
| --------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `x-async`       | `async.reaches-terminal-state`, `async.receipt-identifies-the-job`                                                       |
| `x-effects`     | `effects.declared-effect-occurs`                                                                                         |
| `x-immutable`   | `patch.immutable-field-rejected`                                                                                         |
| `x-invalidate`  | `invalidation.declared-route-changes` (when the list names another entity)                                               |
| `x-query`       | `spec.declared-filterable-is-filterable`, `spec.declared-sortable-is-sortable`, `spec.declared-selectable-is-selectable` |
| `x-soft-delete` | `softdelete.absent-from-default-list`                                                                                    |
| `x-invite`      | `auth.invite-grants-then-revokes`                                                                                        |

What each tag **sharpens** (the check already runs, but the verdict changes):

| tag        | without it                                                                                     |
| ---------- | ---------------------------------------------------------------------------------------------- |
| `x-query`  | every scalar is probed, including columns you never indexed — expect findings you will dismiss |
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

**Fallback:** deepest plural segment + HTTP verb. See [How the model is derived](#how-the-model-is-derived).

### `x-invite`

```yaml
x-invite:
  invite: table.invite
  accept: invite.accept
  revoke: table.revoke
  granteeField: key
  tokenPointer: $.token
  grantPointer: $.grant_id
```

Put this on the invite operation. Config must give the invitee `inviteAs`. Defaults if omitted: `granteeField: key`, `tokenPointer: $.token`, `grantPointer: $.grant_id`. All three of `invite` / `accept` / `revoke` (operationIds) are required or the tag is ignored.

Timeline asserted: cannot read → invite → still cannot → accept → can → revoke → cannot.

**Fallback:** the check does not run.

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
  grammar: postgrest # postgrest | colon | equality
```

States what `filter` / `order` / `q` / `select` actually support. `stableTiebreak` is load-bearing for keyset pagination. `grammar` pins how oat writes values (see [Query roles and grammars](#query-roles-and-grammars)).

**Fallback:** if those roles resolve, treat every scalar as capable and warn.

**Unlocks:** `spec.declared-filterable-is-filterable`, `spec.declared-sortable-is-sortable`, `spec.declared-selectable-is-selectable`. Sharpens every other query check (without the tag they probe columns you may not have indexed).

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

The HTTP response is a receipt. oat polls until `until` matches, then treats that payload as the result. `poll` may be an operationId or `"GET /path/{id}"`. Defaults: `timeoutMs: 120000`, `pollIntervalMs: 2000`.

`until` / `successWhen` use the same `field.op.value` predicates as filters (`eq`, `in`, …).

**Fallback:** treated as synchronous; async checks are `COVERAGE_GAP`.

### `x-effects`

```yaml
x-effects:
  - { entity: table, op: create, count: 1 }
  - { entity: delivery, op: append, count: 1 }
```

`op`: `create` | `append` | `update` | `delete` | `replace`. oat asserts an exact cardinality delta on the named entity's list. `count` defaults to `1` when omitted.

**Fallback:** derived from `x-entity.action` for this entity only.

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

An excluded operation never silently narrows what gets reported. Excluding an entity's `create` degrades that entity the same way a real seeding failure does — a `COVERAGE_GAP` naming the reason, then read-only checks run against whatever the list route already returns; `BLOCKED` if nothing exists to fall back on. Excluding `read`/`update`/`delete` individually stands down just the checks that need that one operation. The run summary states what a profile skipped: `skipped 12 operation(s) under --profile cheap (12 high-cost)` — the same principle as `did not apply` for a coverage gap: a report that only shows what ran invites the reader to assume the rest was verified.

### `x-rate-limit` — pacing oat's own traffic

```yaml
x-rate-limit: { category: ai, rps: 3 }
```

Groups operations sharing one throughput budget (`category`) and optionally the rate itself (`rps`). Without this, oat's matrix can hammer a `login` or paid-inference route past its real limit, collect 429s, and report them as backend defects — exactly the false-positive class that erodes trust fastest. With it, requests to that category are paced through a token bucket before they fire.

A 429 is only ever reported when the request that drew it was demonstrably under the _declared_ rate — oat's own bucket had a free token, so it did not have to wait for one. A 429 that arrived only after oat's bucket made the request wait means oat's own rate model was too generous, which is paced around, never reported.

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

## Checks

55 checks. A check that cannot run says so (`did not apply` + `needs`). A check that depends on a broken primitive is `BLOCKED`. A check that ran and stopped is inconclusive, not a pass.

Order is fixed (foundations first) so cascade suppression has a cause to point at. Mutating checks run alone; read-only checks may share in-flight requests under `maxInFlight`.

`depends` is the `dependsOn` list: if any of those already failed **for this entity**, this check is `BLOCKED` rather than reported as a second defect. Suppression is transitive.

| id                                         | asserts                                                                              | needs                                                     | depends                                 |
| ------------------------------------------ | ------------------------------------------------------------------------------------ | --------------------------------------------------------- | --------------------------------------- |
| `list.read-after-write`                    | a just-created record appears on the list                                            | create + a seeded record                                  | —                                       |
| `create.persists-submitted-fields`         | every writable field sent on create is echoed                                        | create that echoes the record                             | `list.read-after-write`                 |
| `create.status-matches-document`           | create status is one the document declared                                           | create                                                    | —                                       |
| `schema.success-response-matches-document` | create body validates against the success schema                                     | success schema on create                                  | `create.status-matches-document`        |
| `schema.error-response-matches-document`   | an error body validates against the documented error schema                          | error schema on the item route                            | —                                       |
| `pagination.limit-bounds-page-size`        | page size ≤ the requested limit                                                      | page-size _role_ (aliases include `limit`, `per_page`, …) | `list.read-after-write`                 |
| `pagination.limit-respects-documented-max` | requesting more than `maxLimit` does not return more                                 | declared `maxLimit` and a larger cohort                   | `pagination.limit-bounds-page-size`     |
| `pagination.has-more-is-accurate`          | `hasMore` / `Link rel=next` matches whether another page exists                      | page-forward + `hasMore` or `Link rel=next`               | `pagination.limit-bounds-page-size`     |
| `pagination.page-walk-covers-set`          | walking pages covers the collection with no gaps or dupes                            | page or offset + ≥3 records                               | `pagination.limit-bounds-page-size`     |
| `pagination.cursor-agrees-with-page`       | cursor walk and page walk yield the same set                                         | both cursor and page                                      | `pagination.limit-bounds-page-size`     |
| `filter.unknown-field-rejected`            | a filter on a field that does not exist is not silently ignored                      | a filter expression                                       | —                                       |
| `filter.equality-selects-exactly-one`      | `id.eq.<one>` returns that one record                                                | equality on the identity                                  | `list.read-after-write`                 |
| `filter.zero-match-returns-none`           | a filter that matches nothing returns an empty page, not the whole set               | same                                                      | `list.read-after-write`                 |
| `filter.negation-partitions-the-set`       | `eq` ∪ `neq` = whole set, intersection empty                                         | eq and neq                                                | `list.read-after-write`, equality       |
| `filter.and-composes-as-intersection`      | `and(A,B)` = A ∩ B                                                                   | two filterable fields + AND                               | equality / list                         |
| `filter.or-composes-as-union`              | `or(A,B)` = A ∪ B                                                                    | `or()` — **postgrest grammar only**                       | equality / list                         |
| `filter.like-metacharacters-escaped`       | `%` `_` `*` in a value are literals, not wildcards                                   | like operator                                             | `list.read-after-write`                 |
| `filter.numeric-comparison-is-numeric`     | `gt`/`lt` on a number uses numeric order, not TEXT (`1,10,2`)                        | numeric field + a filter param                            | `list.read-after-write`, unknown-field  |
| `error.malformed-filter-not-5xx`           | garbage filter text is 4xx, never 5xx                                                | a filter expression                                       | —                                       |
| `query.filter-selects-from-whole-set`      | a filter is applied to the collection, not to the current page                       | filterable + ≥3 records                                   | list / walk                             |
| `sort.order-is-applied`                    | requesting a sort actually rearranges the page                                       | order + a sortable field                                  | `pagination.limit-bounds-page-size`     |
| `sort.reverse-symmetry`                    | desc is the reverse of asc (nulls included)                                          | order + asc/desc                                          | order-is-applied                        |
| `search.q-narrows-result`                  | a search term that matches one record does not return the whole set                  | search param + searchable fields                          | `list.read-after-write`                 |
| `select.projection-honoured`               | `select=id,name` does not return undeclared fields                                   | select param                                              | —                                       |
| `count.consistent-with-returned-page`      | envelope total ≥ rows on this page, and is not zero when the page is not             | envelope total                                            | `list.read-after-write`                 |
| `count.matches-filtered-set`               | filtered total equals the size of the filtered walk                                  | total + a filter                                          | list, equality                          |
| `query.axes-compose`                       | filter + sort together: filter still holds on the sorted page                        | filterable + sortable                                     | filter + sort foundations               |
| `query.filter-and-select-compose`          | filter + select together                                                             | filterable + select                                       | same                                    |
| `query.search-and-filter-compose`          | search + filter together                                                             | filterable + search                                       | same                                    |
| `query.filter-sort-select-compose`         | filter + sort + select                                                               | filter + sort + select                                    | same                                    |
| `query.filter-search-sort-compose`         | filter + search + sort                                                               | filter + search + sort                                    | same                                    |
| `query.filter-search-select-compose`       | filter + search + select                                                             | filter + search + select                                  | same                                    |
| `spec.declared-filterable-is-filterable`   | every `x-query.filterable` field actually accepts a filter                           | `x-query` naming filterable fields                        | filter foundations                      |
| `spec.declared-sortable-is-sortable`       | every `x-query.sortable` field actually accepts a sort                               | `x-query` naming sortable fields                          | sort foundations                        |
| `spec.declared-selectable-is-selectable`   | every `x-query.selectable` field actually accepts a select                           | `x-query` naming selectable fields                        | select                                  |
| `tenant.item-not-readable-cross-tenant`    | principal B cannot GET principal A's item                                            | second principal, different `roots`, and a tagged or inferred tenant | —                                       |
| `tenant.denial-does-not-reveal-existence`  | 404 vs 403 (or equivalent) does not distinguish "exists other tenant" from "missing" | second principal, and a tagged or inferred tenant                    | `tenant.item-not-readable-cross-tenant` |
| `tenant.filter-does-not-bypass-scope`      | `filter=id.eq.<other tenant>` does not return that row                               | second principal + a filter                               | `query.filter-selects-from-whole-set`   |
| `auth.rank-is-monotonic`                   | a lower rank cannot do what a higher rank is denied                                  | two same-tenant principals at different `rank`            | `list.read-after-write`                 |
| `auth.invite-grants-then-revokes`          | invite → accept grants; revoke takes it back                                         | `x-invite` + peer with `inviteAs`                         | list, cross-tenant                      |
| `patch.immutable-field-rejected`           | PATCHing an `x-immutable` field is rejected or ignored                               | `x-immutable`                                             | —                                       |
| `softdelete.absent-from-default-list`      | a soft-deleted row is gone from the default list                                     | `x-soft-delete`                                           | `list.read-after-write`                 |
| `invalidation.declared-route-changes`      | after a write, the other entity's listed route actually changes                      | `x-invalidate` naming another entity                      | list, persist                           |
| `effects.declared-effect-occurs`           | `x-effects` cardinality delta is observed on the named list                          | `x-effects`                                               | `list.read-after-write`                 |
| `async.reaches-terminal-state`             | polling `x-async` reaches `until` before `timeoutMs`                                 | `x-async`                                                 | —                                       |
| `async.receipt-identifies-the-job`         | `idFrom` on the receipt resolves to a pollable job                                   | `x-async` + `idFrom`                                      | —                                       |
| `patch.minimality`                         | PATCH `{ name }` does not clear other writable fields                                | update + item route                                       | —                                       |
| `idempotency.replay-does-not-duplicate`    | same Idempotency-Key + same body does not create a second row                        | create + documented Idempotency-Key header                | list, persist                           |
| `delete.absent-record-returns-404`         | DELETE of a missing id is 404, not 200                                               | delete                                                    | —                                       |
| `concurrency.no-lost-update`               | two PATCHes to different fields do not clobber each other                            | update + two writable strings                             | persist + patch                         |
| `validation.enum-enforced`                 | a value outside the enum is rejected                                                 | enum in the request schema                                | —                                       |
| `validation.max-length-enforced`           | a string over `maxLength` is rejected                                                | maxLength                                                 | —                                       |
| `validation.required-enforced`             | omitting a required field is rejected                                                | required field                                            | —                                       |
| `validation.content-type-enforced`         | a wrong Content-Type is 415 when 415 is documented                                   | documented 415                                            | —                                       |
| `consistency.projections-agree`            | list, item, and filtered views of the same field agree                               | item route + a comparable field                           | list + persist + filter                 |

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

`oat run` exit `1` if any finding has a failing verdict. Gaps and blocked entries do not fail CI.

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

## Reports

Written under `--out` (default `./oat-out`):

| file               |                                                                                                                                                          |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `oat-report.md`    | human report: summary, findings with request/response excerpts, coverage, latency p50/p95/max                                                            |
| `oat-report.json`  | same data for CI                                                                                                                                         |
| `matrix.html`      | visual matrix of entities × checks                                                                                                                       |
| `matrix.json`      | the same graph (AI-friendly), including a mermaid string                                                                                                 |
| `issue-repro/*.sh` | one executable `curl` script per finding that has evidence. Directory is omitted when the run is clean. Old `repro/` is deleted at the start of each run |
| `progress.log`     | logfmt, one event per line, never truncated                                                                                                              |
| `progress.jsonl`   | same events as JSON                                                                                                                                      |
| `progress.tsv`     | same columns, tab-separated                                                                                                                              |
| `progress.json`    | latest snapshot only (overwritten ~1s)                                                                                                                   |

There is no HAR file. The JSON report and issue-repro scripts carry the exchanges.

### `oat-report.json`

```json
{
	"backend": "https://api.example.com",
	"generatedAt": "2026-08-15T12:00:00.000Z",
	"durationMs": 41200,
	"requests": 842,
	"entitiesTested": ["store", "product"],
	"checksRun": ["list.read-after-write", "patch.minimality"],
	"checksSkipped": [{ "check": "async.reaches-terminal-state", "entity": "store", "needs": "…" }],
	"checksSuppressed": [{ "check": "query.axes-compose", "entity": "store", "because": "list.read-after-write" }],
	"inconclusive": [{ "check": "filter.and-composes-as-intersection", "entity": "store", "reason": "…" }],
	"summary": { "BACKEND_BUG": 1 },
	"coverage": {
		"neverApplied": ["async.reaches-terminal-state"],
		"partial": [{ "check": "select.projection-honoured", "ran": 1, "skipped": 1 }]
	},
	"latency": {
		"p50": 12,
		"p95": 90,
		"max": 400,
		"slowest": { "method": "GET", "path": "/v1/products" }
	},
	"findings": [
		{
			"check": "patch.minimality",
			"verdict": "BACKEND_BUG",
			"entity": "product",
			"summary": "PATCH { name } also cleared description",
			"detail": "…",
			"evidence": [
				{
					"method": "PATCH",
					"url": "https://api.example.com/v1/products/p1",
					"status": 200,
					"requestBody": { "name": "x" },
					"responseBody": { "name": "x", "description": null }
				}
			]
		}
	]
}
```

Latency is reported, never asserted. oat has no baseline for "too slow".

Gate in CI on process exit code, or on `findings` whose `verdict` is not `COVERAGE_GAP` / `BLOCKED`.

### `matrix.json`

```json
{
	"kind": "oat.matrix",
	"version": 2,
	"baseUrl": "…",
	"generatedAt": "…",
	"thesis": "…",
	"summary": "…",
	"index": { "entityCount": 5, "failed": ["product"], "parents": ["store"], "crossClaims": 1, "inbound": {} },
	"counts": { "failed": 1, "blocked": 0, "held": 40, "skipped": 14 },
	"entities": [
		{
			"name": "product",
			"identity": "id",
			"readSurface": ["GET /v1/products", "GET /v1/products/{id}"],
			"counts": { "failed": 1, "blocked": 0, "held": 20, "skipped": 5 },
			"roots": ["store_id"],
			"nodes": [
				{
					"id": "product/patch.minimality",
					"group": "product",
					"layer": "axis",
					"status": "failed",
					"verdict": "BACKEND_BUG",
					"summary": "…"
				}
			]
		}
	],
	"invalidate": [
		{
			"fromEntity": "product",
			"fromOp": "product.create",
			"toEntity": "store",
			"toRoute": "GET /v1/stores/{id}",
			"cross": true
		}
	],
	"edges": [{ "from": "product/list.read-after-write", "to": "product/patch.minimality", "kind": "dependsOn" }],
	"mermaid": "flowchart LR\n…"
}
```

Cell `status`: `held` (passed), `failed`, `blocked`, `skipped`. Edge `kind`: `dependsOn` (cascade) or `uses` (a composition check built from a single-axis check).

### `issue-repro/<entity>-<check>.sh`

Created only when a finding has HTTP evidence. Not created on a clean run.

```bash
#!/usr/bin/env bash
# Generated by oat. Set TOKEN to a valid credential before running.
# product — PATCH { name } also cleared description
set -u
BASE="${BASE:-https://api.example.com}"
TOKEN="${TOKEN:?set TOKEN to a valid credential}"

# step 1 — observed 200
curl -sS -X PATCH "$BASE/v1/products/p1" \
  -H "authorization: Bearer $TOKEN" \
  -H "content-type: application/json" \
  -d '{"name":"x"}'
```

`authorization`, `cookie`, and `x-api-key` are redacted to `$TOKEN`. Replay needs a live credential; ids in the script are whatever the failing run created (gone if teardown ran). Use `--keep-fixtures` when you want to replay against the same rows.

## Progress logs

`progress.log` starts with a glossary. Fields:

| key                        |                                                              |
| -------------------------- | ------------------------------------------------------------ |
| `ts`                       | ISO-8601 UTC when the line was written                       |
| `status`                   | `ok` or `stall` (`idle_ms` ≥ 15000)                          |
| `done` / `total`           | entity index / how many entities                             |
| `phase`                    | `load` \| `auth` \| `seed` \| `test` \| `teardown` \| `done` |
| `entity` / `check`         | current entity and check id                                  |
| `msg`                      | phase note                                                   |
| `req` / `find`             | request count, finding count                                 |
| `method` / `path` / `http` | last HTTP call                                               |
| `last_ms`                  | duration of that call                                        |
| `idle_ms`                  | ms since it returned — if this climbs, the run is stuck      |
| `elapsed_ms`               | wall clock since start                                       |

`--quiet` keeps the files and drops stderr.

Lines are written when the phase/entity/check/message changes, or every 2 s, or on `load`/`done`. `progress.json` is rewritten about once a second.

If `idle_ms` climbs through a long poll (`x-async`) that is expected. If it climbs on a simple GET, the process or the network is stuck. oat's own `fetch` has **no timeout**.

## Programmatic API

```ts
import {
	defineConfig,
	loadConfig,
	run,
	loadSpec,
	dereference,
	buildModel,
	renderJson,
	renderMarkdown,
} from "@lovrozagar/oat"

const config = defineConfig({
	spec: "./openapi.yaml",
	baseUrl: "https://api.example.com",
	principals: [{ id: "alpha", headers: { authorization: `Bearer ${process.env.API_TOKEN}` } }],
})

const result = await run({
	spec: config.spec,
	baseUrl: config.baseUrl,
	principals: config.principals,
	seed: 1,
	concurrency: 1,
	maxInFlight: 4,
	onProgress: (snap) => {
		// snap.phase, snap.entity, snap.check, snap.message, …
	},
})

// result.findings, result.checksSkipped, result.checksSuppressed,
// result.inconclusive, result.entitiesTested, result.teardown, result.created
```

`loadConfig(path)` loads `.ts` / `.js` / `.mjs` / `.json` the same way the CLI does. The CLI then expands `${NAME}` in every string. `defineConfig` is an identity function for typing; it does not interpolate. If you call `run()` with an in-process object, resolve secrets yourself (template literals, `process.env`) before passing it.

`run(options)` does not write files. The CLI writes reports after `run` returns. To produce the same artifacts, call `renderMarkdown` / `renderJson` / `renderMatrixHtml` / `renderMatrixGraph` / `renderRepros` with a `ReportInput` (`findings`, `model`, `client`, `baseUrl`, `entitiesTested`, `checksRun`, `startedAt`, `durationMs`, plus optional skip/suppress/inconclusive lists).

Offline:

```ts
const doc = await loadSpec("./openapi.yaml")
const { doc: resolved, externalRefs } = dereference(doc)
const model = buildModel(resolved)
```

Types exported: `OatConfig`, `Principal`, `AuthFlow`, `AuthStep`, `Hooks`, `RunOptions`, `RunResult`, `Finding`, `Verdict`, `Actor`, `SpecModel`, `EntityModel`, `OperationModel`, `OpenApiDocument`, matrix types.

## CI

This repository runs [`.github/workflows/ci.yml`](./.github/workflows/ci.yml) on every push and pull request to `main`: format, lint, typecheck, then `npm test` (conformance on memory + sqlite, plus the built-in combination smoke). D1, live labs Workers, and postgres are not in that job — D1 needs Cloudflare credentials, and the postgres reference backend is not yet a green CI gate.

The package is [`@lovrozagar/oat` on npm](https://www.npmjs.com/package/@lovrozagar/oat). That URL is the repository website. GitHub Releases match npm versions. Pushing a tag `vX.Y.Z` (same as `package.json` `version`) runs [`.github/workflows/release.yml`](./.github/workflows/release.yml): test, `npm publish` via trusted publishing, then a GitHub Release. Configure the trusted publisher once on npm (package Settings → Trusted Publisher → GitHub Actions, workflow `release.yml`, no environment). Do not publish to GitHub Packages — people install from the public npm registry.

Against **your** API:

```yaml
# GitHub Actions sketch
- run: npm i -D @lovrozagar/oat
- run: oat doctor --spec "$SPEC_URL"
- run: oat run --config oat.config.ts --concurrency 1
  env:
    API_TOKEN: ${{ secrets.API_TOKEN }}
    API_TOKEN_B: ${{ secrets.API_TOKEN_B }}
```

Gate on exit code 1 (defects). Read `oat-out/oat-report.json` if you need to classify verdicts.

Nested APIs: keep `--concurrency 1`. Higher values create children while a parent page-walk is in flight and produce false `pagination.page-walk-covers-set` findings.

Wipe leftover rows on a shared database between runs if a previous `--keep-fixtures` or a crashed teardown left data. Leftover rows make numeric/filter checks look like type bugs (`1, 10, 2` from old TEXT-sorted leftovers mixed with a fresh numeric cohort).

## Reference defects (`oat serve --defects`)

Comma-separated. Each is one named lie the demo API can tell. Primary check is what conformance asserts; extras in parentheses are accepted additional symptoms of the same lie.

| defect                                      | primary check                              | the lie                                                |
| ------------------------------------------- | ------------------------------------------ | ------------------------------------------------------ |
| `STALE_LIST`                                | `list.read-after-write`                    | create succeeds, list does not show the row            |
| `CREATE_DROPS_FIELD`                        | `create.persists-submitted-fields`         | a submitted field is dropped                           |
| `CREATED_201_AS_200`                        | `create.status-matches-document`           | create returns 200 when the spec says 201              |
| `RESPONSE_SCHEMA_DRIFT`                     | `schema.success-response-matches-document` | success body does not match the schema                 |
| `ERROR_SCHEMA_DRIFT`                        | `schema.error-response-matches-document`   | error body does not match the schema                   |
| `LIMIT_IGNORED`                             | `pagination.limit-bounds-page-size`        | `limit` is accepted and ignored                        |
| `LIMIT_EXCEEDS_MAX`                         | `pagination.limit-respects-documented-max` | documented max is not capped                           |
| `HASMORE_ALWAYS_FALSE`                      | `pagination.has-more-is-accurate`          | `hasMore` is always false                              |
| `OFF_BY_ONE_PAGE`                           | `pagination.page-walk-covers-set`          | page walk skips or repeats                             |
| `UNSTABLE_SORT`                             | `pagination.page-walk-covers-set`          | default order is not a total order                     |
| `CURSOR_DRIFT`                              | `pagination.cursor-agrees-with-page`       | cursor and page disagree                               |
| `FILTER_IGNORED`                            | `filter.unknown-field-rejected`            | unknown filter field is ignored                        |
| `FILTER_EQ_NOT_APPLIED`                     | `filter.equality-selects-exactly-one`      | equality filter is ignored                             |
| `EMPTY_RESULT_RETURNS_ALL`                  | `filter.zero-match-returns-none`           | empty match returns the whole set                      |
| `NEQ_DROPS_NULLS`                           | `filter.negation-partitions-the-set`       | `neq` drops nulls so the partition leaks               |
| `FILTER_GROUP_COMBINATOR_SWAPPED`           | `filter.and-composes-as-intersection`      | `and`/`or` are swapped                                 |
| `LIKE_UNESCAPED`                            | `filter.like-metacharacters-escaped`       | `%`/`_` are wildcards in values                        |
| `NUMERIC_COMPARED_AS_TEXT`                  | `filter.numeric-comparison-is-numeric`     | numbers compared as strings                            |
| `ERROR_500_ON_BAD_FILTER`                   | `error.malformed-filter-not-5xx`           | bad filter is 500                                      |
| `FILTER_AFTER_PAGINATION`                   | `query.filter-selects-from-whole-set`      | filter applied after the page is cut                   |
| `ORDER_IGNORED`                             | `sort.order-is-applied`                    | sort param is ignored                                  |
| `SORT_DESC_DROPS_NULLS`                     | `sort.reverse-symmetry`                    | desc drops nulls                                       |
| `SEARCH_IGNORED`                            | `search.q-narrows-result`                  | search param is ignored                                |
| `SELECT_IGNORED`                            | `select.projection-honoured`               | select param is ignored                                |
| `COUNT_ALWAYS_ZERO`                         | `count.consistent-with-returned-page`      | total is always 0                                      |
| `COUNT_IGNORES_FILTER`                      | `count.matches-filtered-set`               | total ignores the filter                               |
| `FILTER_DROPPED_WHEN_SORTED`                | `query.axes-compose`                       | sort drops the filter                                  |
| `FILTER_DROPPED_WHEN_SELECTED`              | `query.filter-and-select-compose`          | select drops the filter                                |
| `FILTER_DROPPED_WHEN_SEARCHED`              | `query.search-and-filter-compose`          | search drops the filter                                |
| `FILTER_DROPPED_WHEN_SORTED_AND_SELECTED`   | `query.filter-sort-select-compose`         | the triple drops the filter                            |
| `FILTER_DROPPED_WHEN_SORTED_AND_SEARCHED`   | `query.filter-search-sort-compose`         | the triple drops the filter                            |
| `FILTER_DROPPED_WHEN_SEARCHED_AND_SELECTED` | `query.filter-search-select-compose`       | the triple drops the filter                            |
| `SPEC_OVERCLAIMS_FILTERABLE`                | `spec.declared-filterable-is-filterable`   | `x-query` lists a field that 400s                      |
| `SPEC_OVERCLAIMS_SORTABLE`                  | `spec.declared-sortable-is-sortable`       | same for sort                                          |
| `SPEC_OVERCLAIMS_SELECTABLE`                | `spec.declared-selectable-is-selectable`   | same for select                                        |
| `CROSS_TENANT_READ`                         | `tenant.item-not-readable-cross-tenant`    | item GET is global by id                               |
| `EXISTENCE_LEAK_VIA_STATUS`                 | `tenant.denial-does-not-reveal-existence`  | 403 vs 404 reveals the other tenant's row              |
| `TENANT_LEAK_VIA_FILTER`                    | `tenant.filter-does-not-bypass-scope`      | filter drops the tenant predicate                      |
| `ROLE_MONOTONICITY_BROKEN`                  | `auth.rank-is-monotonic`                   | a lower rank can do more                               |
| `INVITE_NEVER_GRANTS`                       | `auth.invite-grants-then-revokes`          | accept does not grant                                  |
| `REVOKE_IGNORED`                            | `auth.invite-grants-then-revokes`          | revoke leaves the grant                                |
| `IMMUTABLE_WRITABLE`                        | `patch.immutable-field-rejected`           | immutable fields accept writes                         |
| `SOFT_DELETE_LEAK`                          | `softdelete.absent-from-default-list`      | tombstone stays on the default list                    |
| `PARENT_PROJECTION_STALE`                   | `invalidation.declared-route-changes`      | child write does not bump the parent                   |
| `EFFECT_NOT_APPLIED`                        | `effects.declared-effect-occurs`           | declared cardinality delta does not happen             |
| `ASYNC_NEVER_COMPLETES`                     | `async.reaches-terminal-state`             | job stays pending                                      |
| `ASYNC_RECEIPT_MISSING_ID`                  | `async.receipt-identifies-the-job`         | receipt has no id                                      |
| `PATCH_REPLACES`                            | `patch.minimality`                         | PATCH is implemented as replace                        |
| `IDEMPOTENCY_IGNORED`                       | `idempotency.replay-does-not-duplicate`    | Idempotency-Key is ignored                             |
| `DELETE_MISSING_OK`                         | `delete.absent-record-returns-404`         | DELETE missing returns 200                             |
| `CONCURRENT_WRITE_LOST`                     | `concurrency.no-lost-update`               | full-row write clobbers a parallel PATCH               |
| `ENUM_NOT_VALIDATED`                        | `validation.enum-enforced`                 | enum is not enforced                                   |
| `MAXLENGTH_NOT_VALIDATED`                   | `validation.max-length-enforced`           | maxLength is not enforced                              |
| `REQUIRED_NOT_VALIDATED`                    | `validation.required-enforced`             | required is not enforced                               |
| `CONTENT_TYPE_NOT_ENFORCED`                 | `validation.content-type-enforced`         | wrong Content-Type is accepted                         |
| `LIST_DETAIL_DISAGREE`                      | `consistency.projections-agree`            | list and item show different values                    |
| `COLUMN_NAME_MISMATCH`                      | `create.persists-submitted-fields`         | SQL identifier does not match the field (SQL backends) |
| `COLLATION_INCONSISTENT`                    | `pagination.cursor-agrees-with-page`       | cursor order ≠ page order (SQL)                        |

```bash
oat serve --defects STALE_LIST,PATCH_REPLACES
oat run --config labs/local.config.ts --base-url <url>
```

`COLUMN_NAME_MISMATCH`, `NUMERIC_COMPARED_AS_TEXT`, `COLLATION_INCONSISTENT`, and `CONCURRENT_WRITE_LOST` are SQL-only in conformance (the in-memory store cannot exhibit them).

## Limits and non-features

These are deliberate. An agent should not invent a flag for them.

- **No request timeout.** `fetch` waits until the server answers. Watch `idle_ms`.
- **No retry on 5xx / 429 / 401.** A 401 mid-run is evidence, not a refresh trigger. Refresh is expiry-based only.
- **No OpenAPI `security`.** Put credentials in `principals`. Cookie auth is a `headers: { cookie: "…" }` (or a flow that sets that header).
- **No `servers[]`.** Always set `baseUrl`.
- **JSON request bodies only.** Multipart, form, file upload, and XML are not sent. Those operations will fail to seed or will not apply.
- **No webhook / callback / link-object following.**
- **External `$ref`s are not fetched.** In-document `$ref`s are.
- **`x-idempotent` is not the idempotency check.** The check keys off a documented `Idempotency-Key` header.
- **Rate-limit pacing only covers requests oat itself sends.** It cannot see traffic from anything else hitting the backend at the same time, so a shared budget can still trip even when oat's own share was within the declared rate.
- **Equality filter grammar** cannot express `neq` / `gt` / `like` / `and` / `or`. Those checks did-not-apply, they do not fail.
- **`or()` is postgrest-only.**
- **Concurrency > 1 on nested graphs invents pagination bugs.** Use `1`.
- **Leftover rows on a shared DB** poison numeric and filter checks. Wipe between runs.
- **`--only` uses plan names** (`store`, not `stores` or `/v1/stores`).
- **Default cohort is 7.** `pagination.limit-respects-documented-max` needs `cohortSize > maxLimit`.
- **First principal is the writer.** Extra principals are peers / lattice, not a pool of writers.

## Compared to schema fuzzers

Tools like [Schemathesis](https://schemathesis.readthedocs.io/) generate request bodies from the OpenAPI schema and check that each response validates, is not a 5xx, and matches a documented status.

oat does that on the traffic it sends: create/update bodies come from the schema; `validation.*` and `schema.*` catch drift; `error.malformed-filter-not-5xx` fails a 500. You do not need a second tool for “send OpenAPI-shaped requests and watch for 500s.”

What they cannot do — and what oat is for — is **state**. A fuzzer’s requests are independent. It has no model of the row it just created, so it cannot ask whether that row appears on the list, whether a filter and its negation partition the set, whether `GET` item and `GET` list agree, or whether another tenant can read it. oat keeps a shadow of everything it wrote and matrix-tests those projections against each other.

|                               | schema fuzzer           | oat                                                               |
| ----------------------------- | ----------------------- | ----------------------------------------------------------------- |
| generate bodies from schema   | yes                     | yes                                                               |
| catch 500 / schema drift      | yes                     | yes (`schema.*`, `validation.*`, malformed → 5xx)                 |
| remember what it created      | no                      | shadow model of the cohort                                        |
| same fact, every projection   | no                      | the matrix (list / item / filter / sort / page / tenant / parent) |
| filter ∩ negation = universe  | no                      | `filter.negation-partitions-the-set`                              |
| page walk covers the set      | no                      | `pagination.page-walk-covers-set`                                 |
| N live principals             | header injection        | peer tenants + rank lattice + invite timeline                     |
| multi-step / out-of-band auth | usually a static header | declarative chain, `resolveOutOfBand`, JWT refresh                |

They are not a peer you should also run for coverage oat misses. The implication is one way.

Runtime dependencies of a run against _your_ API: `ajv`, `ajv-formats`, `yaml`. SQL drivers are optional and only loaded for `oat serve` / `oat conformance`.

## Labs

[`labs/`](./labs) is a family of real Hono + Cloudflare D1 backends this repo uses to iterate oat (correct worlds and planted bugs). Schema is generated from [`labs/worlds/catalog.ts`](./labs/worlds/catalog.ts). See [`labs/README.md`](./labs/README.md). You do not need labs to test your own API.

Shipped in the npm package for copy-paste: `labs/local.config.ts`, `labs/minimal.config.ts`, `labs/oob-auth.config.ts`, `labs/annotated-openapi.yaml`.

## License

MIT
