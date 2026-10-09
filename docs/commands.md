# oat — Commands

[← back to the overview](../README.md)

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

| flag                                       | default                          | meaning                                                                                                                                         |
| ------------------------------------------ | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `--config`                                 | required                         | module or JSON file, default export                                                                                                             |
| `--base-url`                               | `config.baseUrl`                 | backend origin                                                                                                                                  |
| `--ops`                                    | `config.ops` or every operation  | comma-separated operationIds to grade; everything else is support. `*` globs, `<originId>:` prefixes. See [Targeted runs](#targeted-runs---ops) |
| `--only`                                   | `config.only` or all entities    | comma-separated entity names as `oat plan` prints them (singularised); each grades every operation it owns. Joins `--ops` as a union            |
| `--seed`                                   | `config.seed` or `1`             | fixture generation seed (reproducible)                                                                                                          |
| `--out`                                    | `config.outDir` or `./.oat/runs` | history root; each run writes `<out>/<datetime>/` and updates `latest`                                                                          |
| `--max-in-flight`                          | `config.maxInFlight` or `4`      | HTTP requests allowed at once                                                                                                                   |
| `--keep-fixtures`                          | `config.keepFixtures` or false   | do not DELETE what the run created                                                                                                              |
| `--quiet`                                  | false                            | no stderr progress; files under `--out` still update                                                                                            |
| `--save-exchanges` / `--no-save-exchanges` | on unless `--profile cheap`      | persist every HTTP exchange under the run dir (`exchanges.jsonl`, `exchanges/`, `blobs/`). Does **not** change in-memory transcript RAM         |

**Exit codes:** `0` no defects, `1` at least one root-cause finding (`BACKEND_BUG`, `SPEC_BUG`, `SECURITY`, `AMBIGUITY`) **or**, on a targeted run, a target that `failed`, `2` usage error (missing `--config`, no principals, unknown flag, a flag without its value or with a value of the wrong kind, an `--ops` / `--only` name that matches nothing, a target the profile excludes), `3` oat could not do what it was asked — the network never came back, the run graded no operation at all, a target was never judged, or oat itself failed. `COVERAGE_GAP` and `BLOCKED` do not fail a full run. `latest` moves to a run only once its reports are written.

Example:

```bash
oat run --config oat.config.ts --only store,product --out .oat/runs/prod
```

`--only store,product` matches the **entity names** from `oat plan`, not path segments. `/v1/stores` is usually the entity `store`. An unknown name exits `2` with the nearest names.

A run with no principals exits `2`. Isolation checks then need a second principal; they are skipped, not failed, when only one is present.

### Targeted runs (`--ops`)

A full run grades every operation. After changing two endpoints you usually want those two, not the whole API:

```bash
oat run --config oat.config.ts --ops table.create,row.list
oat run --config oat.config.ts --ops 'row.*'            # glob within an operationId
oat run --config oat.config.ts --ops cdn:asset.get      # an operation on the origin with id "cdn"
oat plan --config oat.config.ts --ops table.create      # dry run: what would be graded, queued, called
```

**Targets** are graded: every check whose subjects include a target runs the full matrix against it. **Support** operations are called and never graded: principal sign-up, parent creates, the cohort create behind a list, reads used as an oracle, teardown deletes. A list route cannot be tested without rows in it, so its create still runs, but a defect in that create is out of this run's scope.

How the scope is decided:

- Every check declares its **subjects**, the operations whose contract it judges (`filter.*` judges the list route, `patch.minimality` the update, `effects.declared-effect-occurs` each `x-effects` operation). A check runs when one of its subjects is a target. Others are **out of scope**: not run, not skipped.
- An entity is seeded only when one of its checks grades a target. Declared edges pull in the other direction too: targeting a read route that another entity's create names in `x-invalidate` queues that entity, so its invalidation check grades the route.
- Checks that judge several operations (`effects.*`, `async.*`, `response.status-is-documented`, `schema.error-response-matches-document`, `invalidation.declared-route-changes`) invoke and judge only the targeted ones. An untargeted `x-effects` upload is never POSTed.
- Every finding names the operations it judges (`operations` in `oat-report.json`).
- An operation counts as graded only when a check exercised it. A check that judges after the fact (`response.status-is-documented` reads the transcript) grades only the operations it saw. A check that reports a coverage gap for an operation did not grade it. `--only <entity>` therefore surfaces every action no check can reach as `untested`.

Each target ends with one status:

| status         | meaning                                                                                                                                                 |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `held`         | at least one check graded it and none failed                                                                                                            |
| `failed`       | a defect finding is attributed to it                                                                                                                    |
| `inconclusive` | checks ran and none could decide                                                                                                                        |
| `blocked`      | every check was suppressed, or a support operation it needed failed (named, with evidence)                                                              |
| `untested`     | nothing exercised it. The reason says why (`unmodeled`, `entity-not-testable`, `coverage gap: …`, `no check applied: needs …`, `no check exercised it`) |

A targeted run exits `0` only when every target is `held`. A target nothing could grade must not read as a pass.

Validation happens before any principal signs up: a name that matches nothing exits `2` with the nearest operationIds; an exact target the active `--profile` excludes exits `2`; a glob or `--only` match the profile excludes is dropped and listed. An origin no target names is not run.

A targeted run is for iterating. It grades what you named and what those operations observably affect through declared edges. It does not catch a regression in an untargeted operation caused by shared code, so run the full suite before a release.

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

With `--ops` / `--only` (flag or config), `plan` prints the targeted scope instead: each target with its entity and the checks that would grade it, untestable targets with the reason, the entities that would be queued, and the support operations predicted from the graph. `--json` adds a `scope` object with the same fields. An unknown name exits `2`.

### `oat serve`

In-process demo API. Same fixture as conformance.

```bash
oat serve
oat serve --defects STALE_LIST,PATCH_REPLACES
oat serve --backend sqlite --dialect classic
oat serve --untagged
```

| flag         | default     | meaning                                                                                                    |
| ------------ | ----------- | ---------------------------------------------------------------------------------------------------------- |
| `--backend`  | `memory`    | `memory` \| `sqlite` \| `postgres`                                                                         |
| `--dialect`  | `postgrest` | `postgrest` \| `classic` \| `linked` \| `jsonapi` \| `plain`                                               |
| `--defects`  | none        | comma-separated names from [Reference defects](reference-defects.md#reference-defects-oat-serve---defects) |
| `--untagged` | false       | serve the same API behind a spec with every `x-*` tag stripped                                             |

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
| `--jobs`          | legs run at once, each on its own thread (default: CPUs − 1, at most 4)                                                            |

A default `oat conformance` (no `--fuzz` / `--precision` / `--parser`) also runs a 40-case combination smoke on memory after the one-at-a-time matrix, and `--ops` recall for every defect, reusing the matrix's own runs. The extra dialects run only the defects whose symptom depends on how a listing is asked for and answered.

D1 needs `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_D1_DATABASE_ID`, `CLOUDFLARE_API_TOKEN`. Postgres needs a reachable server on the default connection (`database: "postgres"`). Missing backends are skipped with a printed reason, not treated as a pass.

`--parser` still always runs first (hostile documents, `labs/annotated-openapi.yaml` model lock, tag-unlock map). Exit `1` if any parser, matrix, fuzz, or precision case fails.
