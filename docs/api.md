# oat — Programmatic API

[← back to the overview](../README.md)

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

`loadConfig(path)` loads `.ts` / `.js` / `.mjs` / `.json` the same way the CLI does. The CLI then expands `${NAME}` in every string. `defineConfig` is an identity function for typing; it does not interpolate. If you call `run()` with an in-process object, resolve secrets yourself (template literals, `process.env`) before passing it.

`runVerdict(result)` is the verdict the CLI and every report state: `{ outcome, reason }`, where
`outcome` is `clean`, `defects` or `failed` (a run that graded nothing, a network that went away, or
a `--ops` target never judged). `exitCode(result)` is that outcome as the CLI's exit code, from
`EXIT`: 0, 1 or 3.

`run(options)` does not write files. The CLI writes reports after `run` returns. To produce the same artifacts, call `renderMarkdown` / `renderJson` / `renderMatrixHtml` / `renderMatrixGraph` / `renderRepros` with a `ReportInput` (`findings`, `model`, `client`, `baseUrl`, `entitiesTested`, `checksRun`, `startedAt`, `durationMs`, plus optional skip/suppress/inconclusive lists).

Offline:

```ts
const doc = await loadSpec("./openapi.yaml")
const { doc: resolved, externalRefs } = dereference(doc)
const model = buildModel(resolved)
```

Types exported: `OatConfig`, `Principal`, `AuthFlow`, `AuthRefresh`, `AuthStep`, `HookAuth`, `Hooks`, `Uploads`, `UploadRequest`, `UploadFile`, `HeaderRequest`, `InputRequest`, `OriginSpec`, `OutOfBandConfig`, `OutOfBandRequest`, `TeardownPrincipalContext`, `RunOptions`, `RunResult`, `Finding`, `Verdict`, `Actor`, `SpecModel`, `EntityModel`, `OperationModel`, `OpenApiDocument`, `AuthRefreshRequiredError`, `loadPersistedPrincipals`, `worstCaseWaitMs`, `allocateRunDir`, `DEFAULT_RUNS_ROOT`, matrix types.
