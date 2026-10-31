# oat — Programmatic API

[← back to the overview](../README.md)

## Programmatic API

```ts
import {
	defineConfig,
	env,
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
	security: { bearer: { static: env("API_TOKEN") } },
	principals: { alpha: { tenant: "acme" } },
})

const result = await run({
	spec: config.spec,
	baseUrl: config.baseUrl,
	security: config.security,
	principals: config.principals,
	seed: 1,
	maxInFlight: 4,
	onProgress: (snap) => {
		// snap.phase, snap.entity, snap.check, snap.inflight, snap.last, snap.message, …
	},
})

// result.findings, result.checksSkipped, result.checksSuppressed,
// result.inconclusive, result.entitiesTested, result.teardown, result.created,
// result.scope (per-operation status), result.checksOutOfScope
// pass `ops: ["product.update"]` to run() for a targeted run; ScopeError on an unknown name
```

`result.teardown` is `{ removed, failed, unsupported, records }`; `records` lists every record oat ledgered, in creation order, as `{ entity, id, removed }`. Only ids the backend gave back are ever ledgered. `oat-report.json` carries the same object under `teardown`.

`env(name)` reads a secret for a config: `token: env("API_TOKEN")`. An unset or empty variable stops the load with `oat: env API_TOKEN is not set (<config path>)`, so a missing secret never goes out as an empty credential.

`loadConfig(path)` loads `.ts` / `.js` / `.mjs` / `.json` the same way the CLI does. The CLI then expands `${NAME}` in every string. `defineConfig` is an identity function for typing; it does not interpolate. If you call `run()` with an in-process object, resolve secrets yourself (template literals, `process.env`) before passing it.

`runVerdict(result)` is the verdict the CLI and every report state: `{ outcome, reason }`, where
`outcome` is `clean`, `defects` or `failed` (a run that graded nothing, a network that went away, or
a `--ops` target never judged). `exitCode(result)` is that outcome as the CLI's exit code, from
`EXIT`: 0, 1 or 3.

`run(options)` does not write files. The CLI writes reports after `run` returns. To produce the same artifacts, call `renderMarkdown` / `renderJson` / `renderMatrixHtml` / `renderMatrixGraph` / `renderRepros` with a `ReportInput` (`findings`, `model`, `client`, `baseUrl`, `entitiesTested`, `checksRun`, `startedAt`, `durationMs`, plus optional skip/suppress/inconclusive lists).

`transcript: { memoryBytes, dir }` bounds what a large run holds. Each client keeps up to `memoryBytes` of exchange bodies in memory (default 32 MiB) and moves the oldest to a private folder under `dir` (default the system temporary directory). Checks read those bodies back exactly as the backend sent them, so they are not redacted. Each file is encrypted with AES-256-GCM, under a key each client draws for itself and holds only in memory,, and the folder is removed when the run ends, however it ends. Choose a local, private `dir`: the encryption is what protects the files there. `memoryBytes` must be a positive integer, and `dir` must exist and be writable; `run` refuses either fault with a `UsageError` before it sends anything.

Offline:

```ts
const doc = await loadSpec("./openapi.yaml")
const { doc: resolved, externalRefs } = dereference(doc)
const model = buildModel(resolved)
```

Types exported, by what they describe:

- **Config.** `OatConfig`; `EntityConfig` (an `entities` entry, today only its `query`); `PayloadPolicy` (`payloads`: `"full"` or `"per-write-path"`); `ProfileSpec` (a `profiles` entry); `RateLimitSpec` (a `rateLimits` entry); `OriginSpec`; `OutOfBandConfig`; `Uploads` and `UploadFile`.
- **Security.** `SecurityConfig` (one `Recipe` per scheme) and `PrincipalsConfig` (a `PrincipalEntry` per id).
- **Steps and scenarios.** `AuthStep` is an `OperationStep`, a `RequestStep` or an `OutOfBandStep`. A `Scenario` runs `ScenarioStep`s: a `ScenarioRequestStep` (an operation or request step with its `ScenarioAssert`s), an `OutOfBandStep` or an `ExternalStep`.
- **Query catalog.** `QueryCapabilities` is what `x-query` or a config's `query` declares for a list: `FilterableField`s, each a field with its `FieldType` and `FilterOp`s, and `FilterableFrom`, the read that `filterableFrom` and its siblings harvest names from. `QueryParamNames` maps a `QueryParamRole` (`filter`, `sort`, `select`, `search`, `searchMode`, `limit`, `page`, `offset`, `cursor`) to the query parameter it is sent in, as `x-query.params` and config `query.params` name it.
- **Hooks.** `Hooks`, and what each hook receives: `HeaderRequest` (`resolveHeaders`), `InputRequest` (`resolveInput`), `UploadRequest` (`resolveUpload`, which answers an `UploadResolution`), `PathValueRequest` (`resolvePathValue`), `QueryCapabilitiesRequest` (`resolveQueryCapabilities`), `SideEffectRequest` (`awaitSideEffect`), `OutOfBandRequest` (`resolveOutOfBand`) and `TeardownPrincipalContext` (`teardownPrincipal`).
- **Runs and reports.** `RunOptions`, `RunResult`, `Finding`, `Verdict`, `Actor` and `ReportInput`.
- **The model.** `SpecModel`, `EntityModel`, `OperationModel` and `OpenApiDocument`.

Also exported: `loadPersistedPrincipals`, `worstCaseWaitMs`, `allocateRunDir` and `DEFAULT_RUNS_ROOT`.
