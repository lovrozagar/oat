# oat

[![npm](https://img.shields.io/npm/v/@lovrozagar/oat.svg)](https://www.npmjs.com/package/@lovrozagar/oat)

OpenAPI Tester: live **matrix testing** of a running backend against its own OpenAPI document. oat
reads the spec, talks to the API, and treats every way to see a record as a cell in a matrix: list,
item, filter, sort, page, cursor, select, search, parent routes, another tenant. Then it checks that
the cells agree. It never reads your source or assumes your framework.

A schema fuzzer asks _did this answer match its schema?_ oat asks that of every request it sends,
and then the questions only state can answer:

- the row is on `GET /tables/{id}` and missing from `GET /tables`
- `?filter=status.eq.nope` returns every row (the backend dropped the parameter)
- `limit=2` walks to 9 rows and `limit=100` to 10 (the sort has no total order)
- `PATCH { name }` also cleared `description`
- `?filter=id.eq.<another tenant's id>` returns that tenant's row

There is no ground-truth database. A filter and its negation must partition the set, a page walk
must cover the collection, and a record read four ways must read the same. One root cause is one
finding; the checks that depend on it are `BLOCKED`, not a page of copies.

## Install

```bash
npm i -D @lovrozagar/oat
```

Requires **Node.js 22.18 or later**. oat reads OpenAPI 3.0–3.2 documents, in JSON or YAML. The
unscoped `oat` on npm is a different project; the binary this one installs is still `oat`.

## Quick start

```bash
oat doctor --spec https://api.example.com/openapi.json   # offline: what oat can test, and what is missing
oat init --spec https://api.example.com/openapi.json     # writes oat.config.ts from the security schemes
oat run --config oat.config.ts                            # tests the running API
```

`doctor` names every coverage gap and the tag that would close it. To see oat find bugs first, run
the bundled demo API with planted defects (`oat serve --defects STALE_LIST,PATCH_REPLACES`) and
point `labs/local.config.ts` at the URL it prints.

## Authentication

Each operation is sent the credentials its OpenAPI `security` requires, placed where its scheme
says. The config only says how to get each scheme's value:

```ts
// oat.config.ts
import { defineConfig } from "@lovrozagar/oat"

export default defineConfig({
	spec: "https://api.example.com/openapi.json",
	baseUrl: "https://api.example.com",
	security: { bearer: { static: "${API_TOKEN}" } },
	principals: {
		alpha: { tenant: "a" },
		beta: { tenant: "b", security: { bearer: { static: "${API_TOKEN_B}" } } },
	},
})
```

| recipe   | the value                                                              |
| -------- | ---------------------------------------------------------------------- |
| `static` | a fixed token or key, or `{ username, password }` for basic auth       |
| `login`  | steps oat runs (a sign-in), then where the credential is in the answer |
| `mint`   | an operation called with another scheme's credential (an API key)      |
| `oauth2` | a `clientCredentials` or `password` grant at the document's token URL  |
| `hook`   | `hooks.resolveCredential` returns it                                   |

A second principal in another `tenant` is what makes the isolation checks run.

## Verdicts and exit codes

| verdict        | meaning                                                           |
| -------------- | ----------------------------------------------------------------- |
| `BACKEND_BUG`  | the handler is wrong                                              |
| `SPEC_BUG`     | the document is wrong, or disagrees with the handler              |
| `SECURITY`     | an isolation or authorization failure across a declared boundary  |
| `AMBIGUITY`    | the same evidence, where the boundary was only inferred           |
| `COVERAGE_GAP` | a check could not run; the report names the tag that would let it |
| `BLOCKED`      | a check this one depends on already failed                        |

| exit | means                                                                     |
| ---- | ------------------------------------------------------------------------- |
| `0`  | no defects                                                                |
| `1`  | a root-cause finding (`BACKEND_BUG`, `SPEC_BUG`, `SECURITY`, `AMBIGUITY`) |
| `2`  | usage: a missing or wrong flag, or a config the document contradicts      |
| `3`  | oat could not do what it was asked (the network never came back, say)     |
| `4`  | the run may have left records behind; they are listed under Leftovers     |

Any non-zero exit fails CI. Gaps and blocked checks never fail a full run on their own.

## CI

```yaml
- run: npm i -D @lovrozagar/oat
- run: npx oat doctor --spec "$SPEC_URL"
- run: npx oat run --config oat.config.ts
  env:
    API_TOKEN: ${{ secrets.API_TOKEN }}
    API_TOKEN_B: ${{ secrets.API_TOKEN_B }}
```

The report is written to `.oat/runs/latest/oat-report.json`; read it to sort findings by verdict.

## Limits

- Bodies are generated from the document; oat checks HTTP statuses and JSON, never file contents.
- A 5xx is never retried; a 429 is, up to 5 times, honouring `Retry-After`.
- Leftover rows on a shared database poison the numeric and filter checks: wipe them between runs.
- Webhooks, callbacks and links are not followed, and URL `$ref`s are not fetched.

The full list, with what you see and what to do instead, is in [docs/limits.md](docs/limits.md).

## Docs

- [Commands](docs/commands.md): `run`, `doctor`, `plan`, `init`, `serve`, `conformance`
- [Configuration](docs/configuration.md): every field, principals, security recipes, hooks, uploads
- [How oat reads a document](docs/model.md): how a run works, entities, seeding, query grammars
- [OpenAPI tags](docs/tags.md): every `x-*` tag and what it unlocks
- [Checks and verdicts](docs/checks.md): what each check needs and asserts
- [Reports](docs/reports.md): `oat-report.json`, `matrix.json`, repro scripts, progress logs
- [Programmatic API](docs/api.md)
- [Assumptions](docs/assumptions.md): what oat assumes, and how to declare an exception
- [Limits](docs/limits.md): what oat cannot do, and what to do instead
- [Reference defects](docs/reference-defects.md): the named lies `oat serve --defects` can tell
- [Releasing](docs/releasing.md): how a tag publishes to npm with provenance, and the steps to cut one

## License

MIT
