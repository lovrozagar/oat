# Examples

## Run it end to end, with no setup

oat ships a demo API — the same reference backend its own self-test runs against. Two terminals:

```bash
npm run build

# terminal 1 — prints a url, and takes --defects to make it misbehave
node dist/cli.js serve --defects STALE_LIST,PATCH_REPLACES

# terminal 2 — point a real config at it
node --experimental-strip-types dist/cli.js run \
  --config examples/local.config.ts --base-url http://127.0.0.1:PORT
```

What comes back:

```
  25 checks · 3 entities · 164 requests · 0.2s

  BACKEND DEFECTS (5)
    table            list projection does not reflect a completed write
                     list.read-after-write
    table            PATCH changed fields the request did not mention
                     patch.minimality

  cleaned up 22/22 created record(s)
  report: oat-out/oat-report.md
```

Three artifacts land in `oat-out/`:

| file | what it is |
| --- | --- |
| `oat-report.md` | findings grouped by severity, each with the exchange that produced it |
| `oat-report.json` | the same, for CI gating or diffing between runs |
| `repro/*.sh` | one runnable `curl` script per finding, `BASE` and `TOKEN` as variables |

Drop `--defects` and it reports nothing across 55 checks. That the *clean* case is silent is the
part worth checking first — a tester that cries wolf is worse than no tester.

`npm run demo` does the same thing in a single process if you would rather not manage two
terminals.

## From `doctor` to a fix

The commands above show that oat runs. This is what to *do* with what it prints.

**1. Read the document first, offline.** `doctor` does not need a running backend.

```bash
node dist/cli.js doctor --spec examples/annotated-openapi.yaml
```

It reports two different kinds of gap. Tags listed under “cannot run” mean those checks
are impossible until you declare the behaviour (`x-async`, `x-soft-delete`, …). Lines
under “running, but on inferred information” mean the checks *will* fire, but a
cross-tenant read will be an `AMBIGUITY` rather than `SECURITY` until you add
`x-tenant`, and query probes will hit every scalar until you add `x-query`.

**2. Reproduce one finding.** Serve the demo with a single known defect and run:

```bash
node dist/cli.js serve --defects STALE_LIST          # terminal 1
node --experimental-strip-types dist/cli.js run \
  --config examples/local.config.ts --base-url http://127.0.0.1:PORT
```

`list.read-after-write` fires: the item route serves the record oat just created, the
list route does not. That is not a schema violation. The report names the check, the
entity, and the two exchanges.

**3. Act on the diagnosis, not the symptom.** A stale list is a backend bug — the write
path and the listing have drifted. The matching `curl` under `oat-out/repro/` replays
the create and the two reads without oat. If the same shape appeared because the
*document* promised a filter the backend refuses, the verdict would be `SPEC_BUG` and
the fix would be the document (or an index), not the handler.

**4. Confirm the quiet case.** Drop `--defects`, run again, expect no findings. A tester
that still complains against a correct backend is not ready to point at yours.

## Where the spec can live

`spec` accepts any of these, resolved in a fixed order rather than guessed at:

```ts
spec: "https://api.example.com/openapi.json"   // absolute url
spec: "/v1/openapi/spec"                        // relative — resolved against baseUrl
spec: "./openapi.json"                          // a file on disk
spec: "file:///abs/path/openapi.json"           // an explicit file url
```

A path that exists on disk always wins over a route, so a typo cannot silently become a network
fetch. When nothing matches, the error names every location it tried.

## `minimal.config.ts` — the smallest useful config

A long-lived API key and nothing else. A principal without an `auth` flow authenticates by static
header, so there is no login to describe.

```ts
import { defineConfig } from "oat"

export default defineConfig({
  spec: "https://api.example.com/openapi.json",
  baseUrl: "https://api.example.com",
  principals: [
    { id: "alpha", headers: { authorization: `Bearer ${process.env.API_TOKEN}` },
      roots: { project_id: process.env.PROJECT_A } },
    { id: "beta",  headers: { authorization: `Bearer ${process.env.API_TOKEN_B}` },
      roots: { project_id: process.env.PROJECT_B } },
  ],
})
```

The second principal is optional, but it is what makes the tenant-isolation checks possible —
without one they are skipped rather than silently passed.

`defineConfig` is an identity function whose only job is to type the object, so an editor
completes every field and a mistake is a compile error:

```
principals: []          → Type '[]' is not assignable to '[Principal, ...Principal[]]'
seed: "forty-two"       → Type 'string' is not assignable to type 'number'
```

Run a `.ts` config with `node --experimental-strip-types dist/cli.js run --config <file>`.

## `anyrow.config.ts` — a real backend

What a config looks like against a live API that needs a multi-step login. It is the *entire*
coupling surface between oat and that backend: which route issues a credential, how a
verification token that never travels over HTTP is collected, which header carries it, and which
path parameters the credential itself identifies.

```bash
ANYROW_TESTER_KEY=... node --experimental-strip-types dist/cli.js run \
  --config examples/anyrow.config.ts
```

Delete that file and oat still runs against any other OpenAPI document — nothing about it lives
in the package.

## A note on the databases

oat never talks to a database. It parses a specification and makes HTTP requests; its runtime
dependencies are `ajv`, `ajv-formats` and `yaml`.

The SQLite and Postgres backends under `src/reference/` are **test fixtures** — they exist so
`oat conformance` can prove the checks actually detect what they claim, on engines that disagree
with each other about NULL ordering, collation, type discipline and case-insensitive matching.
They are excluded from the published package, and their driver is a dev dependency.
