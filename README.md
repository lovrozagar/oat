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

## Reference

- [Commands](docs/commands.md) — `run`, `--ops`, `doctor`, `plan`, `serve`, `conformance`
- [Configuration](docs/configuration.md) — complete configs, every field, principals, auth flows, hooks, uploads
- [How oat reads a document](docs/model.md) — entities, identity, seeding, query grammars, pagination
- [OpenAPI meta tags](docs/tags.md) — every `x-*` tag and what it unlocks
- [Checks and verdicts](docs/checks.md) — what each check needs and asserts, verdicts, exit codes
- [Reports](docs/reports.md) — `oat-report.json`, `matrix.json`, repro scripts, progress logs
- [Programmatic API](docs/api.md)
- [Assumptions](docs/assumptions.md) — every assumption oat makes about an API, and how to declare an exception
- [Reference defects](docs/reference-defects.md) — the named lies `oat serve --defects` can tell

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

Unknown commands, unknown flags, and missing required flags exit `2`.

## How a run works

1. **Load** the OpenAPI document (URL or path). Internal `$ref`s are inlined. External `$ref`s are reported, never fetched.
2. **Model** entities by inverting `x-invalidate` (or path heuristics) into a read surface per entity.
3. **Authenticate** every configured principal (static headers and/or an auth flow). Credentials refresh on a countdown from `exp` (default 30s buffer) before every dispatch and each async poll.
4. **Seed** a cohort of records per entity, in parent-before-child order, using each entity's create operation.
5. **Test** the matrix entity by entity: foundations first, then composition, writes, isolation, declared effects. Entities that can see each other's writes — a parent and its children, a route one invalidates, an effect one lands on another — run in series; entities that share nothing run side by side. Checks inside an entity stay ordered.
6. **Teardown** everything the run created, unless `--keep-fixtures` / `keepFixtures: true`.

The first principal is the writer. Isolation needs a second principal with different `roots`. A rank lattice needs two or more principals that share `roots` and differ in `rank`. Invite checks need `x-invite` plus a peer with `inviteAs`.

oat never needs ground truth about your data. A filter and its negation must partition the set; a page walk must cover the collection; a record read four ways must read the same.

oat does **not** use OpenAPI `security` / `securitySchemes`, `servers[]`, webhooks, callbacks, or `links`. Auth is the config. The primary origin is `baseUrl`. Extra hosts go in `origins[]`, each with its own spec — do not merge them into the primary document. A RequestStep whose `path` is an absolute `http(s)` URL is a recorded hop on that URL (a mailed consume page) — that is not an `origins[]` entry and does not need a spec. Request bodies follow the document: JSON, `multipart/form-data` (scalars + dummy / pool / `each` / `resolveUpload` files), or `application/x-www-form-urlencoded`. `hooks.resolveInput` can replace a generated JSON field (a Stripe test `pm_…`); `hooks.resolveHeaders` can attach a one-shot header (Turnstile) per request.

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

## CI

This repository runs [`.github/workflows/ci.yml`](./.github/workflows/ci.yml) on every push and pull request to `main`: format, lint, typecheck, then `npm test` (conformance on memory, sqlite and a Postgres service, the built-in combination smoke with a fresh fuzz seed per run, and a precision pass). D1 and the live labs Workers are not in that job — D1 needs Cloudflare credentials.

The package is [`@lovrozagar/oat` on npm](https://www.npmjs.com/package/@lovrozagar/oat). That URL is the repository website. GitHub Releases match npm versions. Pushing a tag `vX.Y.Z` (same as `package.json` `version`) runs [`.github/workflows/release.yml`](./.github/workflows/release.yml): test, `npm publish` via trusted publishing, then a GitHub Release. Configure the trusted publisher once on npm (package Settings → Trusted Publisher → GitHub Actions, workflow `release.yml`, no environment). Do not publish to GitHub Packages — people install from the public npm registry.

Against **your** API:

```yaml
# GitHub Actions sketch
- run: npm i -D @lovrozagar/oat
- run: oat doctor --spec "$SPEC_URL"
- run: oat run --config oat.config.ts
  env:
    API_TOKEN: ${{ secrets.API_TOKEN }}
    API_TOKEN_B: ${{ secrets.API_TOKEN_B }}
```

Gate on exit code 1 (defects); treat 3 as "the run itself failed", not as a pass or a defect. Read `.oat/runs/latest/oat-report.json` if you need to classify verdicts.

Wipe leftover rows on a shared database between runs if a previous `--keep-fixtures` or a crashed teardown left data. Leftover rows make numeric/filter checks look like type bugs (`1, 10, 2` from old TEXT-sorted leftovers mixed with a fresh numeric cohort).

## Limits and non-features

These are deliberate. An agent should not invent a flag for them.

- **Default request timeout is 180s.** `network.requestTimeoutMs` (per attempt) aborts a stuck `fetch`, including a hung stream. `0` disables it. Watch `status=in_flight` and `idle_ms` as that budget is consumed.
- **No retry on 5xx.** 429 is retried (up to 5, honouring `Retry-After`). One 401 → force refresh + single retry. A second 401 is evidence.
- **Network throws are not HTTP.** Offline / DNS / reset / timeout: 4 retries, then one wait (default 60s) for the link. If it does not come back, `net.unreachable` is recorded, remaining work stands down, the report is still written, exit `1`. Progress `status=network`. Failed attempts are journaled as `status: 0` with `{ error: "network", kind }`.
- **No OpenAPI `security`.** Put credentials in `principals`. Cookie auth is a `headers: { cookie: "…" }` (or a flow that sets that header / `saveAs: { credential: "cookie:session" }`). oat does not grow OpenAPI cookie `securitySchemes`.
- **No `servers[]`.** Always set `baseUrl`. Extra hosts are `origins[]`, each with its own `spec`. An app origin that is HTML + `Set-Cookie` is a RequestStep with an absolute URL, not a dummy spec in `origins[]`.
- **No OCR.** Multipart and file parts are sent as dummy / pool / `each` / `resolveUpload` bytes. oat checks HTTP status and JSON responses, not whether a PDF is a real invoice.
- **No webhook / callback / link-object following**, except the explicit auth / invite GET of a URL `resolveOutOfBand` returned. A hook-side `fetch` of that URL is not a recorded exchange.
- **External `$ref`s are not fetched.** In-document `$ref`s are.
- **`x-idempotent` is not the idempotency check.** The check keys off a documented `Idempotency-Key` header.
- **Rate-limit pacing only covers requests oat itself sends.** It cannot see traffic from anything else hitting the backend at the same time, so a shared budget can still trip even when oat's own share was within the declared rate.
- **Equality filter grammar** cannot express `neq` / `gt` / `like` / `and` / `or`. Those checks did-not-apply, they do not fail.
- **`or()` is postgrest-only.**
- **Leftover rows on a shared DB** poison numeric and filter checks. Wipe between runs.
- **`--only` uses plan names** (`store`, not `stores` or `/v1/stores`).
- **`--ops` trusts support operations.** A targeted green means the targets held, given that what they needed worked. A defect in an untargeted operation is out of scope, even when a target called it.
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
