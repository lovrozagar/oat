# oat — Commands

[← back to the overview](../README.md)

## Commands

```
oat run          --config <file>     test a live backend and write a report
oat doctor       --spec <url|file>   what oat can and cannot test, and why
oat plan         --spec <url|file>   print the derived model (offline)
oat serve        [--defects A,B]     run the demo API
oat conformance                      self-test: injected defects vs detection
oat baseline     --from <run>        write a known-findings baseline from a run's report
oat diff         <runA> <runB>       new, fixed and persisting findings between two runs
oat help
```

`--spec` for `doctor` / `plan` can be replaced by `--config` (the spec is read from the config). `--json` makes those two commands emit machine-readable output. `--base-url` on `doctor` / `plan` is only used to resolve a relative spec path.

`--untagged` is a **serve** flag (and a conformance concern). It is not a `run` flag.

`oat help`, `oat --help` and `--help` after any command print every command and flag, from the same table the command line is read with. An unknown flag or command, or a flag without its value, is refused with exit `2` and the help.

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

**Exit codes:** `0` no defects, `1` at least one root-cause finding (`BACKEND_BUG`, `SPEC_BUG`, `SECURITY`, `AMBIGUITY`) **or**, on a targeted run, a target that `failed`, `2` usage error (missing `--config`, no principals, an `overlay` or `allow` entry that names nothing, unknown flag, a flag without its value or with a value of the wrong kind, an `--ops` / `--only` name that matches nothing, a target the profile excludes), `3` oat could not do what it was asked — the network never came back, `hooks.beforeRequest` refused a request (unless `fence.failRun` is false), the run graded no operation at all, a target was never judged, or oat itself failed, `4` the run may have left records behind — a record teardown could not show gone (its delete was refused or failed, it is still listed after a 2xx delete, its creator never saw it, or `hooks.verifyRemoved` found it), or a create answered 2xx with no id oat could read or confirm, so teardown could not remove it. Each is listed under **Leftovers**, and `4` takes precedence over every other outcome. An entity with no delete operation is reported as a gap and does not exit `4` on its own. A first Ctrl-C or SIGTERM stops the run in whatever phase it is in, removes what it created, writes the report with `interrupted: true`, and exits `130` (SIGINT) or `143` (SIGTERM); a second one exits `130` at once, without teardown. `COVERAGE_GAP` and `BLOCKED` do not fail a full run. `latest` moves to a run only once its reports are written.

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
| `passed`       | at least one check graded it and none failed                                                                                                            |
| `failed`       | a defect finding is attributed to it                                                                                                                    |
| `inconclusive` | checks ran and none could decide                                                                                                                        |
| `blocked`      | every check was suppressed, or a support operation it needed failed (named, with evidence)                                                              |
| `untested`     | nothing exercised it. The reason says why (`unmodeled`, `entity-not-testable`, `coverage gap: …`, `no check applied: needs …`, `no check exercised it`) |

A targeted run exits `0` only when every target is `passed`. A target nothing could grade must not read as a pass.

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

### `oat baseline`

```
oat baseline --from .oat/runs/latest [--out oat.baseline.json] [--force]
```

Reads `<run>/oat-report.json` (`latest` is followed) and writes one entry per root-cause finding — `check`, `entity`, the first operation it judges, and its summary as `reason` — deduplicated and sorted. Edit the reasons to point at tickets. An existing `--out` file is kept unless `--force`. Exit `2` when the run cannot be read.

Point `baseline` in the config at the file. A finding an entry matches is reported under **Known** and does not fail the run; every other root cause still does; an entry that matched nothing is reported under **Fixed**, never as a failure. An entry with `operationId` matches only findings that judge that operation; without it, the check's findings on that entity (or every entity, without `entity`) — so keep entries narrow, or a new defect of the same check on another operation is hidden.

### `oat diff`

```
oat diff .oat/runs/20261015T210304Z .oat/runs/latest [--json]
```

Compares two runs' `oat-report.json`: root-cause findings that are **new**, **fixed** and **persisting**, matched by a key that ignores run-specific values (record ids, UUIDs, timestamps, ports, nonces) and the wording of the summary; operations whose status changed; and both runs' target versions. A report without `scope` makes coverage "not comparable". Always exits `0` — it is a report, not a gate — except `2` when a run cannot be read.

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
| `--jobs`          | worker processes the legs share (default: CPUs − 1, at most 4)                                                                     |
| `--legs`          | run only these parts: `suites`, `passes`, `shapes`, `recall`, `scope`, `fuzz` (comma-separated)                                    |
| `--shapes`        | the shapes the `shapes` and `recall` legs judge behind (comma-separated); all when absent                                          |
| `--proven-out`    | write the checks this run's defects proved to a JSON file, for `--aggregate`                                                       |
| `--aggregate`     | judge a folder of `--proven-out` files together; exit `1` on any check no file proved                                              |
| `--fuzz-seed`     | seed of the 40-combination pass a full run ends with (default 1); CI passes a fresh one                                            |
| `--skip-backend`  | backends a full run may leave out when unreachable (comma-separated); otherwise a missing one fails the run                        |

A default `oat conformance` runs every leg: the suites (hostile documents, the `labs/annotated-openapi.yaml` model lock, the tag-unlock map and the other self-contained suites), the passes on every local engine plus the extra dialects on memory, the correct-backend shapes, every defect again behind each shape that runs clean (recall), `--ops` recall from the default pass's own runs, a 40-case combination pass, and finally the checks no defect proved. The extra dialects run only the defects whose symptom depends on how a listing is asked for and answered.

Selecting a `--backend`, `--dialect` or `--only` runs the suites and those passes alone; `--legs` runs exactly the legs named (the `scope` leg brings the default memory pass it judges from); `--parser` runs the suites alone. Each pass prints its time, recall prints a line per shape as it finishes, and the run ends with the largest worker's memory. Set `OAT_HEAP_SNAPSHOTS=<dir>` to write a worker heap snapshot after every task.

D1 needs `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_D1_DATABASE_ID`, `CLOUDFLARE_API_TOKEN`; it never runs unless asked for by name. Postgres needs a reachable server on the default connection (`database: "postgres"`). A full run fails on a local backend it cannot reach unless `--skip-backend` names it. Exit `1` if any suite, pass, shape, recall, fuzz or precision case fails, or a full run leaves a check unproven.

#### Sharded

`bun run conformance:sharded [--jobs n] [--skip-backend sqlite,postgres] [--out dir]` runs the same self-test as short legs, one process each — the suites, each pass, recall a few shapes at a time, `--ops` scope, the combination pass — writing each leg's proven checks with `--proven-out`, then judges them with `--aggregate`. It prints every leg's exit and time. No leg holds the whole matrix, so a machine short of memory still finishes, and a failing leg can be rerun alone with the command it prints.
