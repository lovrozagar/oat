# oat — Reports and progress logs

[← back to the overview](../README.md)

## Reports

Written under `--out` (default `./.oat/runs`). Each invocation creates a UTC timestamp folder and points `latest` at it:

```
.oat/runs/2026-08-18T12-00-00Z/
.oat/runs/latest -> 2026-08-18T12-00-00Z
```

`--out` / `outDir` replace the root, not the leaf — `--out .oat/runs/prod` writes `.oat/runs/prod/<datetime>/`.

| file                         |                                                                                                                                                                           |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `report.html`                | **start here**: every operation in one group (Failed, Blocked, Effects unproven, Verified, Complete by contract), why, and links to the requests behind it                |
| `oat-report.md`              | human report: scope, confidence counts, per-operation status, summary, findings with request/response excerpts, coverage, latency p50/p95/max                             |
| `oat-report.json`            | same data for CI. Summary only — full exchanges are not inlined here                                                                                                      |
| `junit.xml`                  | only under `--report junit`: a suite per entity and a case per operation and check, for CI test-result views. See [JUnit and the job summary](#junit-and-the-job-summary) |
| `matrix.html`                | visual matrix of entities × checks                                                                                                                                        |
| `matrix.json`                | the same graph (AI-friendly), including a mermaid string                                                                                                                  |
| `issue-repro/*.sh`           | one executable `curl` script per finding that has evidence. Directory is omitted when the run is clean                                                                    |
| `progress.log`               | logfmt, one event per line, never truncated                                                                                                                               |
| `progress.jsonl`             | same events as JSON                                                                                                                                                       |
| `progress.tsv`               | same columns, tab-separated. `req_id` is the join key to the exchange journal                                                                                             |
| `progress.json`              | latest snapshot only (overwritten ~1s)                                                                                                                                    |
| `exchanges.jsonl`            | one line per request (`seq`, `requestId`, method, url, status, bytes, …). Greppable                                                                                       |
| `exchanges/<requestId>.json` | full exchange: status, headers, described bodies. Missing id → `seq-<n>.json`. Duplicate id → `-<seq>`                                                                    |
| `blobs/<sha256>`             | content-addressed file parts and oversized / binary bodies                                                                                                                |

The journal is oat `Exchange` JSON, not HAR (HAR export is out of scope). Default **on** unless `--profile cheap`. `--no-save-exchanges` skips `exchanges/` entirely. `--quiet` does not. **`--no-save-exchanges` does not reduce transcript RAM** — it only skips the disk journal. The in-memory transcript always drops live `FormData` / `Blob` / `ArrayBuffer` / multi-MiB strings after each hop, keeping citeable metadata and content-addressed body descriptors. Reconstruct bytes from `blobs/<sha256>` when a check genuinely needs them.

Bodies are described, never base64 multipart. JSON / text inline up to 256 KiB, then `blobs/<sha256>`. `FormData` file parts and binary downloads (`application/pdf`, spreadsheet, image, `octet-stream`) are always blobs; the same fixture bytes POSTed N times share one file. SSE is parsed incrementally into `{ event, data }[]` frames — the raw `text/event-stream` concatenation is not retained on the transcript.

Redaction is on by default (not opt-in), applied on write:

- Headers: `authorization`, `cookie`, `set-cookie`, `proxy-authorization`, and any `x-*-key` / `x-*-secret` / `x-ia-tester-key` (case-insensitive).
- JSON bodies, any depth: `access_token`, `refresh_token`, `id_token`, `password`, `token`, `secret`, `api_key` → `"<redacted>"`.

Every report names its scope. The console prints `scope: full · 141 of 212 operations graded` or `scope: targeted · 2 operations (--ops …)` followed by one line per target. `oat-report.md` has a **Scope** line and an **Operations** table: on a full run, every operation in the document with its status and, for a pass, its **tier** (so operations no check ever grades are visible); on a targeted run, the targets only, followed by **Support operations** with call and non-2xx counts. In `matrix.html` / `matrix.json` a check a targeted run did not ask for is `out-of-scope`, distinct from `skipped` (not applicable).

Join `progress.tsv` `req_id` to `exchanges.jsonl` `requestId` (response `x-request-id` / `request-id` / `x-correlation-id` / `correlation-id` wins; else what oat sent). `oat-report.md` includes one line such as `1841 exchanges → exchanges/`.

A pass carries `tier` and `evidence`, naming exchanges by their run `seq` (each saved exchange records it). `verified`: `evidence.observation` is a later exchange that holds `value` at `path`; for a delete, a later read answering `status` (404/410), or a later list where `value` is `absent`. `contract`: only `evidence.call` — a documented success whose body matched the schema.

### How far a pass goes

Calling a route and getting a documented answer is not the same as proving it works, and not every route has more to prove. Each pass carries `sufficiency` and a one-line `why`:

| group                    | meaning                                                                                                                                                                      |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Verified**             | a later request shows what the call did (a read returns the written value, a deleted record answers 404)                                                                     |
| **Complete by contract** | a safe method (`GET` / `HEAD` / `OPTIONS` / `QUERY`) with no declared `x-effects`, or any operation that declares `x-effects: []`: meeting its contract is all it promises   |
| **Effects unproven**     | met its contract, but whatever it changes was never observed. Either something should read the effect back, or the operation has none and should say so with `x-effects: []` |

Operations that did not pass are **Failed** (a check found a defect) or **Blocked** (no verdict: a dependency failed, or no check could reach it), each with its reason. `report.html` shows the five groups worst first, with counts, the reason per row, and links to the call and the observing request in `exchanges/`. `oat-report.md` opens its Operations table with the same counts under **Confidence**.

### Leftovers

A create that answered 2xx but named no id oat could read or confirm left a record teardown cannot remove. `oat-report.md` lists each under **Leftovers** (method, URL, operation, status and exchange number), the console prints `leftovers: N create(s) answered 2xx but no id could be read`, `oat-report.json` holds them as `"teardown": { "unidentified": [...] }`, and the run exits `4`. Declare `x-entity.createdIdFrom` where the answer keeps the id.

A record oat identified but could not show gone — its delete was refused, or it is still listed after a 2xx delete — is listed under **Leftovers** too, and the run exits `4`. It reads ``- table `t9` · as beta · DELETE … returned beta: 403``. Every record names the principal that created it, since that principal's tenant is where it remains: the console prints `table t9 (as beta): …`, and `oat-report.json` carries `principal` on each `teardown.failed` and `teardown.records` entry.

Two reasons are teardown's own verdict rather than an answer it got. `its creator could never read it back, so teardown cannot tell whether it is gone` names a record no read or listing by its creator ever served, not even teardown's read before the delete, so a 2xx delete and an empty list prove nothing. `hooks.verifyRemoved says it is still present` names a record the hook found after teardown counted it removed. A hook that threw is one `teardown.verify-hook` gap, and those records keep teardown's verdict.

### Known, fixed and the target version

With a `baseline`, `oat-report.md` lists the findings it names under **Known** (each with its reason) and the entries nothing matched under **Fixed**; the console prints `baseline: N known · M fixed`. Known findings carry `"known": { "reason": … }` in `oat-report.json`, which also holds `"baseline": { "fixed": [...] }`. Only findings no entry names count toward the result and the exit code.

With `targetVersion`, the markdown header shows `**Target version**: 1.0.88` (or why it could not be read) and `oat-report.json` holds `"targetVersion": { "value" } | { "error" }`.

### `oat-report.json`

`schemaVersion` comes first in `oat-report.json`, and `matrix.json` states the same version after `kind`. It rises only on a breaking change to a file's shape; an added field is not one. `oat diff` and `oat baseline --from` read a report with no `schemaVersion` (0.24) or with `1`, and exit `2` on a later one: `oat: <file> is report schemaVersion 2; this oat reads 1 — upgrade oat`.

```json
{
	"schemaVersion": 1,
	"backend": "https://api.example.com",
	"targetVersion": { "value": "1.0.88" },
	"generatedAt": "2026-08-15T12:00:00.000Z",
	"durationMs": 41200,
	"requests": 842,
	"entitiesTested": ["store", "product"],
	"scope": {
		"mode": "targeted",
		"requested": { "ops": ["product.update"], "only": [] },
		"operations": [
			{
				"operationId": "product.update",
				"entity": "product",
				"status": "failed",
				"checks": {
					"passed": ["concurrency.no-lost-update"],
					"failed": ["patch.minimality"],
					"suppressed": [],
					"inconclusive": [],
					"gaps": []
				},
				"findings": 1,
				"reason": null
			},
			{
				"operationId": "product.create",
				"entity": "product",
				"status": "passed",
				"tier": "verified",
				"evidence": { "call": 14, "observation": { "seq": 15, "path": "$.items[*].id", "value": "prd_9" } },
				"checks": {
					"passed": ["create.persists-submitted-fields"],
					"failed": [],
					"suppressed": [],
					"inconclusive": [],
					"gaps": []
				},
				"findings": 0,
				"reason": null
			}
		],
		"support": [{ "operationId": "product.create", "calls": 9, "non2xx": 0 }],
		"excluded": [],
		"originsSkipped": []
	},
	"checksOutOfScope": [{ "check": "filter.in-is-union-of-eq", "entity": "product" }],
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
	"schemaVersion": 1,
	"baseUrl": "…",
	"generatedAt": "…",
	"thesis": "…",
	"summary": "…",
	"index": { "entityCount": 5, "failed": ["product"], "parents": ["store"], "crossClaims": 1, "inbound": {} },
	"counts": { "failed": 1, "blocked": 0, "passed": 40, "skipped": 14 },
	"entities": [
		{
			"name": "product",
			"identity": "id",
			"readSurface": ["GET /v1/products", "GET /v1/products/{id}"],
			"counts": { "failed": 1, "blocked": 0, "passed": 20, "skipped": 5 },
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

Cell `status`: `passed`, `failed`, `blocked`, `skipped`. Edge `kind`: `dependsOn` (cascade) or `uses` (a composition check built from a single-axis check).

### JUnit and the job summary

`--report junit` adds `junit.xml` to the run folder, so `.oat/runs/latest/junit.xml` is a stable path for a CI step. It is the common denominator Jenkins, GitLab and the GitHub test-report actions read: one `testsuites`, one `testsuite` per entity, and one `testcase` per operation and check. Each check appears once per operation; when one is listed under several outcomes, the first in this table wins.

| oat                                                 | JUnit                                                                                                            |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| a failing root cause                                | `<failure type="<verdict>" message="<summary>">`: the detail, then up to 5 requests as `METHOD url → status`     |
| a known finding (baseline)                          | `<skipped message="known (baseline): <reason>">`, since it does not fail the run                                 |
| a coverage gap                                      | `<skipped message="coverage gap: <summary>">`                                                                    |
| an inconclusive check                               | `<skipped message="inconclusive: <reason>">`                                                                     |
| a check blocked by an earlier failure               | `<skipped message="blocked: waiting on <check>">`                                                                |
| a passed check                                      | a bare `testcase`                                                                                                |
| an operation no check graded                        | one `testcase name="graded"`, skipped with the reason                                                            |
| a check that stood down on an entity                | `testcase classname="<entity>" name="<check>"`, skipped with `stood down: <what it needs>`                       |
| a finding no operation holds (teardown, network, …) | a case in the `oat.run` suite, `classname="run"`, named by its check                                             |
| a run that failed (exit 3) or left records (exit 4) | `<testcase classname="run" name="outcome">` holding `<error type="<outcome>" message="<reason>"/>`, in `oat.run` |

Suites are named by entity: `operations` holds an operation with no entity, and a secondary origin's are `<origin>:<entity>`. A case's `classname` is its `operationId`, `<origin>:<operationId>` on a secondary origin. So a gate that reads only the JUnit file fails exactly when the exit code is not `0`. Text goes through the run's redactor, then XML escaping; characters XML 1.0 forbids (most control characters) are dropped, and no CDATA is used.

Inside GitHub Actions, where `GITHUB_STEP_SUMMARY` is set, every `oat run` also appends a job summary in Markdown, with no flag: the outcome and exit code, the base URL and run size, the operations by status, a table of root causes (failing ones first, then known ones), the count of coverage gaps and blocked findings, a collapsed list of what went untested, and the path to `oat-report.md`. It goes through the same redactor. It stays within 64 KiB: rows are dropped from the end of the untested list, then from the end of the findings, each list ending `… and <n> more, truncated, see <run folder>`. A summary that cannot be written prints `oat: could not write the step summary: <reason>` and leaves the exit code alone.

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

| key                        |                                                                                  |
| -------------------------- | -------------------------------------------------------------------------------- |
| `ts`                       | ISO-8601 UTC when the line was written                                           |
| `status`                   | `ok`, `stall` (`idle_ms` ≥ 15000 after the last call returned), or `in_flight`   |
| `done` / `total`           | entity index / how many entities                                                 |
| `phase`                    | `load` \| `auth` \| `seed` \| `test` \| `teardown` \| `done`                     |
| `entity` / `check`         | current entity and check id                                                      |
| `msg`                      | phase note. In-flight is `status`, not `msg`                                     |
| `req` / `find`             | request count, finding count                                                     |
| `method` / `path` / `http` | last completed call, or the in-flight call when `status=in_flight` (`http=-`)    |
| `last_ms`                  | duration of the last completed call. `-` while `in_flight`                       |
| `idle_ms`                  | while `in_flight`: ms since this request started. otherwise ms since it returned |
| `elapsed_ms`               | wall clock since start                                                           |

`--quiet` keeps the files and drops stderr.

Every HTTP call emits a **start** line (`status=in_flight`, `http=-`, `last_ms=-`) when `fetch` is issued, then a **completed** line when it returns (`http=200`, `last_ms` ≈ wall time, `idle_ms=0`). The 5 s heartbeat keeps the in-flight path and climbs `idle_ms` until the call returns; after return it climbs on the completed call (and becomes `stall` at 15 s). A 300 s `POST /extract` therefore stays `/extract` in the log, not the previous refresh or GET.

Lines are also written when the phase/entity/check/message changes, or every 2 s, or on `load`/`done`. `progress.json` is rewritten about once a second.

If `idle_ms` climbs through a long poll (`x-async`) that is expected. If it climbs on a simple GET while `status` is not `in_flight`, the process or the network is stuck. Live `run` aborts a single `fetch` after `network.requestTimeoutMs` (default **180s**). A hung `text/event-stream` becomes `net.unreachable` (`kind=timeout`), not an unbounded buffer on the transcript. Set `requestTimeoutMs: 0` only if you intend to wait for the socket.

Bun and Node both honour that timeout. If oat still runs away with RAM (a bug, or a caller holding the process open), treat the process like any other prefer-kill target for `earlyoom` / systemd — Bun is often **not** in a default `--prefer` list.
