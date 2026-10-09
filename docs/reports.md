# oat — Reports and progress logs

[← back to the overview](../README.md)

## Reports

Written under `--out` (default `./.oat/runs`). Each invocation creates a UTC timestamp folder and points `latest` at it:

```
.oat/runs/2026-08-18T12-00-00Z/
.oat/runs/latest -> 2026-08-18T12-00-00Z
```

`--out` / `outDir` replace the root, not the leaf — `--out .oat/runs/prod` writes `.oat/runs/prod/<datetime>/`.

| file                         |                                                                                                                            |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `oat-report.md`              | human report: scope, per-operation status, summary, findings with request/response excerpts, coverage, latency p50/p95/max |
| `oat-report.json`            | same data for CI. Summary only — full exchanges are not inlined here                                                       |
| `matrix.html`                | visual matrix of entities × checks                                                                                         |
| `matrix.json`                | the same graph (AI-friendly), including a mermaid string                                                                   |
| `issue-repro/*.sh`           | one executable `curl` script per finding that has evidence. Directory is omitted when the run is clean                     |
| `progress.log`               | logfmt, one event per line, never truncated                                                                                |
| `progress.jsonl`             | same events as JSON                                                                                                        |
| `progress.tsv`               | same columns, tab-separated. `req_id` is the join key to the exchange journal                                              |
| `progress.json`              | latest snapshot only (overwritten ~1s)                                                                                     |
| `exchanges.jsonl`            | one line per request (`seq`, `requestId`, method, url, status, bytes, …). Greppable                                        |
| `exchanges/<requestId>.json` | full exchange: status, headers, described bodies. Missing id → `seq-<n>.json`. Duplicate id → `-<seq>`                     |
| `blobs/<sha256>`             | content-addressed file parts and oversized / binary bodies                                                                 |

The journal is oat `Exchange` JSON, not HAR (HAR export is out of scope). Default **on** unless `--profile cheap`. `--no-save-exchanges` skips `exchanges/` entirely. `--quiet` does not. **`--no-save-exchanges` does not reduce transcript RAM** — it only skips the disk journal. The in-memory transcript always drops live `FormData` / `Blob` / `ArrayBuffer` / multi-MiB strings after each hop, keeping citeable metadata and content-addressed body descriptors. Reconstruct bytes from `blobs/<sha256>` when a check genuinely needs them.

Bodies are described, never base64 multipart. JSON / text inline up to 256 KiB, then `blobs/<sha256>`. `FormData` file parts and binary downloads (`application/pdf`, spreadsheet, image, `octet-stream`) are always blobs; the same fixture bytes POSTed N times share one file. SSE is parsed incrementally into `{ event, data }[]` frames — the raw `text/event-stream` concatenation is not retained on the transcript.

Redaction is on by default (not opt-in), applied on write:

- Headers: `authorization`, `cookie`, `set-cookie`, `proxy-authorization`, and any `x-*-key` / `x-*-secret` / `x-ia-tester-key` (case-insensitive).
- JSON bodies, any depth: `access_token`, `refresh_token`, `id_token`, `password`, `token`, `secret`, `api_key` → `"<redacted>"`.

Every report names its scope. The console prints `scope: full · 141 of 212 operations graded` or `scope: targeted · 2 operations (--ops …)` followed by one line per target. `oat-report.md` has a **Scope** line and an **Operations** table: on a full run, every operation in the document with its status (so operations no check ever grades are visible); on a targeted run, the targets only, followed by **Support operations** with call and non-2xx counts. In `matrix.html` / `matrix.json` a check a targeted run did not ask for is `out-of-scope`, distinct from `skipped` (not applicable).

Join `progress.tsv` `req_id` to `exchanges.jsonl` `requestId` (response `x-request-id` / `request-id` / `x-correlation-id` / `correlation-id` wins; else what oat sent). `oat-report.md` includes one line such as `1841 exchanges → exchanges/`.

### `oat-report.json`

```json
{
	"backend": "https://api.example.com",
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
					"held": ["concurrency.no-lost-update"],
					"failed": ["patch.minimality"],
					"suppressed": [],
					"inconclusive": [],
					"gaps": []
				},
				"findings": 1,
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
