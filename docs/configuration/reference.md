# oat — Configuration reference

[← back to the overview](../../README.md)

The config file, field by field. The rest of the configuration docs: [principals and security](principals-and-security.md), [hooks](hooks.md), [origins and uploads](origins-and-uploads.md); upgrading from 0.24: [migrating to 0.25](../migrating-0.25.md).

## Complete configs

These are copy-paste starting points. Real configs import `defineConfig` from `@lovrozagar/oat`. Files inside this repository import from `../dist/index.js` because they live in the source tree.

### Starting from oat init

`oat init --spec <url|file>` writes a starter `oat.config.ts` from the document: one `security` recipe per scheme it declares, each secret read with `env()`, and one principal. Set the env vars it prints, then run `oat doctor --config oat.config.ts`. A document that declares no scheme gets a commented `overlay.securitySchemes` stub to declare one. See [`oat init`](../commands.md#oat-init).

### Static API keys, two tenants (smallest useful)

```ts
// oat.config.ts
import { defineConfig } from "@lovrozagar/oat"

export default defineConfig({
	spec: "https://api.example.com/openapi.json",
	baseUrl: "https://api.example.com",
	security: { bearer: { static: "${API_TOKEN}" } },
	principals: {
		alpha: { tenant: "a", scope: { project_id: "${PROJECT_A}" } },
		beta: { tenant: "b", scope: { project_id: "${PROJECT_B}" }, security: { bearer: { static: "${API_TOKEN_B}" } } },
	},
})
```

```bash
export API_TOKEN=… API_TOKEN_B=… PROJECT_A=proj_a PROJECT_B=proj_b
oat run --config oat.config.ts
```

`bearer` names a scheme in the document's `components.securitySchemes`; oat places the value where that scheme says. One principal is enough to seed and run CRUD / query / schema checks. The second principal, in a different `tenant`, is what makes `tenant.*` run. Without it those checks are **did not apply**, not a pass.

Shipped as `labs/minimal.config.ts` (and in the npm package).

### JSON config

Same object. `${NAME}` is interpolated after load. There is no `defineConfig` wrapper.

```json
{
	"spec": "https://api.example.com/openapi.json",
	"baseUrl": "https://api.example.com",
	"security": { "apiKey": { "static": "${API_KEY}", "format": "ApiKey {credential}" } },
	"principals": { "alpha": { "tenant": "a", "scope": { "project_id": "${PROJECT_A}" } } },
	"seed": 42,
	"cohortSize": 7,
	"outDir": "./.oat/runs"
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
	security: {
		jwt: {
			login: { steps: [{ operationId: "auth.token", body: { key: "{principal.key}" } }], from: "$.access_token" },
		},
	},
	principals: {
		alpha: { key: "key_alpha", tenant: "proj_alpha", scope: { project_id: "proj_alpha" }, rank: 2 },
		beta: { key: "key_beta", tenant: "proj_beta", scope: { project_id: "proj_beta" }, rank: 2 },
	},
})
```

`spec: "/v1/openapi/spec"` is resolved against `baseUrl`. `--base-url` on the CLI overrides the origin without editing the file.

### Two tenants plus a same-tenant rank lattice

See [Principals](principals-and-security.md#principals). Isolation keys off `tenant`. Rank keys off `rank` within one tenant.

## Config files

Two inputs, always: **the spec** and **a config file**. Backend-specific knowledge lives in `x-*` tags and this file. A backend adopts oat by adding tags, not by adapting to oat.

A config is:

- `.ts` / `.js` / `.mjs` with `export default defineConfig({ ... })`, or
- `.json` with the same object.

Named export without `default` is also accepted (`module.default ?? module`).

## Top-level fields

```ts
import { defineConfig } from "@lovrozagar/oat"

export default defineConfig({
	spec: "https://api.example.com/openapi.json", // URL or filesystem path; JSON or YAML
	baseUrl: "https://api.example.com",
	security: { bearer: { static: "${API_TOKEN}" } }, // one recipe per scheme the document declares
	principals: { alpha: { tenant: "acme" } }, // at least one; see below
	hooks: {/* optional */},
	uploads: { pool: ["./fixtures/**/*"], eachMax: 24 },
	globalHeaders: { "x-request-id": "oat" }, // sent on every request; never a credential
	redact: { headers: ["x-tester-key"] }, // secret, but not a credential
	seed: 42, // fixture generation; a failing run with the same seed is identical
	cohortSize: 12, // records created per entity (default 7)
	maxInFlight: 4, // HTTP in flight
	ops: ["store.create", "product.*"], // grade only these operationIds; the rest is support
	only: ["store", "product"], // grade every operation these entities own (union with ops)
	keepFixtures: false,
	outDir: "./.oat/runs",
	saveExchanges: true, // default on unless --profile cheap; --quiet does not turn this off
	network: { retries: 4, waitMs: 60_000 }, // fetch-threw: retry, then wait for the link
	outOfBand: { attempts: 20, initialMs: 1000, maxMs: 8000 },
	origins: [
		{
			id: "cdn",
			baseUrl: "https://cdn.example.com",
			spec: "https://cdn.example.com/openapi.json",
			security: { bearer: "bearer" },
		},
	],
	query: {
		// grammar / sortGrammar: a preset name or a template, as on x-query; outranks the document
		grammar: "postgrest",
		operators: ["eq", "neq", "gt", "gte", "lt", "lte", "in", "nin", "like", "ilike", "is"],
		emptyIn: "match-none",
		maxInValues: 100,
		searchEmpty: "match-all",
		sort: { nulls: ["first", "last"], maxKeys: 3 },
		select: { unknown: "reject" },
	},
	entities: {
		row: {
			query: {
				// an entity's grammar outranks the run's
				sortGrammar: { term: "{field}_{direction}", asc: "ascending", desc: "descending", join: "," }, // join: "repeat" sends one sort parameter per key
				identityFilter: "_id",
				filterable: [{ field: "_id", type: "string", ops: ["eq", "neq", "in"] }],
			},
		},
	},
})
```

| field           | required | default                                                   | notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --------------- | -------- | --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `spec`          | yes      |                                                           | See [Spec loading](#spec-loading)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `baseUrl`       | yes      |                                                           | Primary origin. OpenAPI `servers[]` is ignored                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `principals`    | yes      |                                                           | A map of id → identity data, at least one. The first is the writer. See [Principals](principals-and-security.md#principals)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `security`      | no       |                                                           | One recipe per scheme the document declares: how each credential is obtained. See [Security recipes](principals-and-security.md#security-recipes)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `hooks`         | no       |                                                           | See [Hooks](hooks.md#hooks)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `uploads`       | no       |                                                           | `pool` globs; optional `each` (operationId → globs) and `eachMax`. JSON configs may set all three                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `globalHeaders` | no       | `{}`                                                      | Merged first, then `resolveHeaders`, then caller headers. Never a credential: a credential header, or one where a scheme places its credential, exits 2                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `redact`        | no       |                                                           | `{ headers: ["x-tester-key"] }`: header names whose values are secret though they carry no credential, scrubbed wherever a run records them                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `origins`       | no       | `[]`                                                      | Extra `{ id, baseUrl, spec, maxRps?, overlay?, security? }` hosts. `security` maps an origin scheme to a primary recipe. Do not merge those routes into `spec`. See [Secondary origins](origins-and-uploads.md#secondary-origins)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `outOfBand`     | no       | `{ attempts: 6, initialMs: 200, maxMs: 3000 }`            | Backoff for `resolveOutOfBand`. See [Hooks](hooks.md#hooks)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `seed`          | no       | `1`                                                       | Integer. Same seed → same fixture bodies                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `cohortSize`    | no       | `7`                                                       | Sliced from the 7 built-in variants. Larger repeats the pattern                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `maxInFlight`   | no       | `4`                                                       | Across the whole run                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `maxRps`        | no       | none                                                      | Requests per second to `baseUrl` in all, across every route: a limit no route declares, such as a CDN or firewall capping each client IP. Route budgets (`rateLimits`, `x-rate-limit`) still hold under it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `checks`        | no       | none on                                                   | Checks that run only when switched on, by id: `{ "auth.login-throttled": true }` sends failed logins for an identity that does not exist until the login answers 429. An unknown id is a config problem                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `payloads`      | no       | `"per-write-path"`                                        | String payload catalog: all 159 cases once per write path (media type + field type), one per family elsewhere, said in a run note; `"full"` sends every case to every field                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `profiles`      | no       | `full` and `cheap`                                        | Named profiles beyond the two built in: `{ maxCost?, excludeDestructive?, exclude? }`. `maxCost` (`low`, `medium` or `high`) excludes an operation whose `x-cost` is higher, `excludeDestructive: true` every `x-destructive` operation, and `exclude` the operationIds it lists. An entry named `full` or `cheap` replaces that built-in. See [`--profile`](../tags.md#--profile--cost-gating)                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `profile`       | no       | `"full"`                                                  | The active profile, by name. `--profile` overrides it. A name neither built in nor in `profiles` is an error that lists the known ones                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `ops`           | no       | every operation                                           | The operations to grade, each by its [operation name](#operation-names); every other operation is support, called to reach or observe a target and never graded. `*` globs within a name (`row.*`), and `<originId>:<operationId>` names an operation on a secondary origin. Joins `only` as a union. A name that matches nothing is a usage error (exit 2). `--ops` replaces the list. See [Targeted runs](../commands.md#targeted-runs---ops)                                                                                                                                                                                                                                                                                                                                                                            |
| `only`          | no       | all                                                       | Entity names from `oat plan`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `keepFixtures`  | no       | `false`                                                   | Skip DELETE at the end                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `overlay`       | no       |                                                           | Patches to a document you cannot change: `{ operations: { "<operation name>": { … } }, schemas: { "<Name>": { … } }, securitySchemes: { "<name>": { … } }, security: [{ "<name>": [] }] }`. Objects merge, arrays replace, `null` deletes a key, a patch's own `operationId` renames the operation. Each `operations` key is an [operation name](#operation-names) as the document gives it before any patch. A patch naming nothing is a usage error (exit 2), as are two keys naming one operation (`GET /a` and `get /a`), except `securitySchemes`, whose purpose is to declare a scheme the document lacks (`null` deletes one); `security` replaces the root requirement. Both apply before anything reads the document, so `doctor`, `plan` and `run` all see them. `origins[].overlay` does the same for an origin |
| `allow`         | no       |                                                           | The only operations oat may call, each by its [operation name](#operation-names). Every other operation leaves the document after the overlay, so no check, contract call, scenario or teardown can reach it; `oat doctor` lists what was removed. An entry naming nothing, or a recipe's login or refresh step, mint, revoke or scenario step needing a removed operation, is a usage error                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `fence`         | no       | `{ failRun: true }`                                       | With `hooks.beforeRequest`: whether a refused request alone fails the run (exit 3)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `baseline`      | no       |                                                           | Path, relative to the config, to a file `oat baseline` writes: `{ "version": 1, "entries": [{ "check", "entity"?, "operationId"?, "reason" }] }`. Matched findings are reported as known and do not fail the run; unmatched entries are reported as fixed. A file oat cannot read is a usage error                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `targetVersion` | no       |                                                           | Where the backend says which build it is, read once after sign-in: `{ operationId \| path, from, scheme? }`, with `from` a `$.json.path` into the body or `header:<name>`. An operation is read as the first principal under its security; a `path` is read anonymously, or as the first principal sending `scheme`, a scheme the document declares. Reports and `oat diff` show it; a version that cannot be read is noted and never changes the verdict                                                                                                                                                                                                                                                                                                                                                                  |
| `teardown`      | no       | `{ verify: true }`                                        | After teardown, read each list again with the creator's credential; a record still listed after its delete answered 2xx is a leftover (`delete answered 2xx but the record is still listed`). `verify: false` skips the read                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `outDir`        | no       | `./.oat/runs`                                             | History root, relative to the config (the default, to the working directory). Each run writes `<outDir>/<datetime>/` and updates `latest`, with `principals.json`, which holds no credential value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `saveExchanges` | no       | on unless `profile` is `cheap`                            | Persist every HTTP exchange under the run dir. `--save-exchanges` / `--no-save-exchanges` override. `--quiet` does not                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `network`       | no       | `{ retries: 4, waitMs: 60000, requestTimeoutMs: 180000 }` | When `fetch` throws (offline / DNS / reset / timeout): retry, then wait once for the link. Not a 5xx policy. `requestTimeoutMs: 0` disables the per-attempt cap                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `query`         | no       |                                                           | Global query-catalog defaults. Overlay after `x-query`. Does not invent operators                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `entities`      | no       |                                                           | Per-entity overlays. This release only reads `query`. Unknown names are ignored; `doctor` warns                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `scenarios`     | no       | `[]`                                                      | Declared flows for operations the matrix cannot reach. See [Scenarios](#scenarios)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

`spec` may be a path relative to `baseUrl` (`/v1/openapi/spec`) or an absolute URL or a file. Every relative file path a config holds (`spec`, each origin's `spec`, `baseline`, `outDir`, upload patterns) is read from the config file's folder, whatever the working directory.

CLI `--base-url`, `--ops`, `--only`, `--seed`, `--out`, `--max-in-flight`, `--keep-fixtures`, `--save-exchanges` / `--no-save-exchanges` override these when passed.

## Operation names

`ops`, `allow` and `overlay.operations` name an operation the same way, through one resolver. An
operation is named by its `operationId`, or, when the document gives it none, `METHOD /path`, as
in `"GET /admin/realms/{realm}/users"`. The method may be written in any case; the path must be
one of the document's path templates exactly, so `/users/` and `/users/{id}` for `/users/{userId}`
match nothing. An operation with an `operationId` answers to that id alone, the name every report
prints. A name that matches no operation is a usage error that suggests the nearest names.

## Spec loading

Resolved in this order, never by guessing the string's "look":

1. Absolute `http(s)://` or `file://` — used as given.
2. A path that exists on disk, relative to the config file's folder (a `--spec` on the command line: the working directory).
3. Anything else, when `baseUrl` is known — resolved against it (`/v1/openapi/spec`, `openapi.json`).

JSON if the first non-space character is `{` or `[`, otherwise YAML. Empty files error. A JSON document with more opening than closing brackets is diagnosed as truncated (proxy / download limit), not as a syntax error.

oat reads OpenAPI 3.0–3.2 only. oat reads `paths`, operations, parameters, request/response JSON schemas, and `x-*` extensions. A Swagger 2.0 document, an OpenAPI version below 3.0, or one newer than 3.2 is refused with exit 2, naming its version (`oat: api.json is Swagger 2.0; oat reads OpenAPI 3.0–3.2 only — convert it first`). A document with no `openapi` version string is not an OpenAPI document and fails to load.

Internal `$ref`s are dereferenced. When the document is a file, a `$ref` to another file by relative path (`./schemas/pet.yaml#/Pet`) is read too, relative to the file that names it, recursively, so a document split across files loads as one; a cycle across files works like one inside a file. Every such file must resolve inside the document's own folder, compared by real path: a ref by absolute path or `file:` URL, one that climbs out with `..`, or a symlink that points outside is refused with exit 2, as is a ref to a missing file (the error names the file and the file that refers to it). URL refs, anchor refs (`#Name`), and every ref in a document fetched by URL stay unresolved and show up in `oat doctor` / the JSON `externalRefs` list.

## Scenarios

Some operations need a scene the document cannot describe: a second factor enabled before it can be verified, a checkout paid before the webhook lands, an invite accepted by someone other than the inviter. A scenario declares that scene as steps. oat runs them and grades each operation in `covers` by what the steps observed. The product knowledge lives in your config; oat stays generic.

```ts
scenarios: [
	{
		id: "rename",
		covers: ["notes.create", "notes.rename"],
		steps: [
			{ operationId: "notes.create", body: { text: "first" }, saveAs: { id: "$.id" } },
			{ operationId: "notes.list", assert: { from: "$.items[*].text", contains: "first", observes: ["notes.create"] } },
			{ operationId: "notes.rename", bind: { id: "{id}" }, body: { text: "second" } },
			{ operationId: "notes.list", assert: { from: "$.items[*].text", contains: "second", observes: ["notes.rename"] } },
		],
	},
],
```

Steps are the login steps (`operationId` / raw `method` + `path`, `body`, `bind`, `saveAs`, `expect`, `origin`, `redirect`, and `outOfBand`). `{name}` is filled in a text or JSON `body`; a byte body (`Uint8Array`, `ArrayBuffer`, `Blob`) is an upload and is sent as it is, under the step's `mediaType`. Plus:

| on a request step                                                                                   | meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `assert: { from, equals \| contains \| excludes \| omits \| atLeast, observes? }` or a list of them | The value at `from` — a JSON path (`[*]` fans out, `[?(@.id=='{id}')]` keeps the items whose field equals a value), or `header:Name` / `cookie:name` as `saveAs` reads them — must equal, contain, or (`excludes`) no longer hold the text, or (`omits`) appear in no node's text, an object's JSON text included (`'"token":'` is a key named `token` at any depth), or (`atLeast`) be a number no lower than it: a count from a sampled or eventually consistent store promises a floor, not an exact value. `{name}` is filled in both the path and the value. A list must all hold on the same exchange, so a response read only a few times (a download with a cap) is checked once. A pass marks the step's own operation and every operation in `observes` `verified`, with this exchange as the observation; `excludes` records it as an absence, `atLeast` the number it saw |
| `poll: { within: "30s", everyMs?: 500 }`                                                            | Re-send until the assert passes or the window runs out — for reads that are eventually consistent. The wait starts at `everyMs` and doubles up to 5s, never below `everyMs`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `anonymous: true`                                                                                   | Send without the scenario principal's credential                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

| step                                                                                 | meaning                                                                                                                    |
| ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| `{ external: "pay-with-test-card", input: { url: "{checkoutUrl}" }, as: "session" }` | Something only a browser or a person can do. oat calls `hooks.external(name, input)` and binds the returned string to `as` |

A `saveAs` that lands on an object, a number or a boolean, or an `external` step that returns JSON, keeps the value whole: a body or `input` field that is exactly `"{name}"` sends that value with its type, not its string form. Inside a longer string it is interpolated as text. That is how a WebAuthn ceremony passes the server's options to a software authenticator and its credential back.

`principal` picks the config principal the steps act as (default: the first); each step sends the credentials its operation's security requires; its `scope` parameters are bound from the first step. A record a step creates with a configured principal's credential is ledgered as that principal's and removed at teardown like any other. A step that sends a credential no configured principal holds — an account the scenario signed up itself — creates records oat does not track: cleaning those up is the scenario's job. A write's own response never proves that write — its observation has to come from a later read. Each id in `covers` must be called by a step — a scenario that covers what it never calls is refused before the run starts. A step that fails stops the scenario: the operation it blamed is `failed` with the exchanges as evidence, even when `covers` does not name it (a support step that arms an account fails as loudly as a covered one), and every covered operation it never reached is `blocked` with the step named. A step body field may hold a file as `{ bytes, filename, mediaType }`; on a multipart operation that field is sent as that part under that filename, so a scenario can upload one document under two names. An operation a scenario covers is never graded by the contract floor. A scenario with `origin` belongs to that configured origin: its steps and `covers` name that origin's operations, it runs in that origin's pass with the same principals and their scope, and its grades land on that origin's rows (`--ops files:file.put` targets it). A single step can also set `origin` to reach another origin as support; such a step never covers a main operation.

## Environment interpolation

After the module loads, every string in the config is scanned for `${NAME}`:

```ts
security: {
	bearer: { static: "${API_TOKEN}" },
}
```

If `API_TOKEN` is unset, oat exits with an error. Do not commit secrets; put them in the environment.

Template literals in a `.ts` config (`Bearer ${process.env.API_TOKEN}`) are evaluated by Node _before_ oat sees the object. Either style works; `${NAME}` is what a `.json` config can use.

`oat doctor` and `oat plan` send nothing, so they read a config whose variables are not set yet: an unset `env("NAME")` or `${NAME}` stays the literal `${NAME}`, and the command lists it. `oat run` never does this, whatever `OAT_DEFER_ENV` the shell exports, and refuses to send a credential that is still such a literal.

Names match `[A-Z0-9_]+` case-insensitively.

## Loading TypeScript configs

`.js` / `.mjs` / `.json` load everywhere.

`.ts` / `.mts` configs, such as the one `oat init` writes, load under plain `node` on oat's floor, Node 22.18 or later, where type stripping is on by default. The published `oat` binary is itself JS; it still has to `import()` your config. If that fails (an older Node, or `--no-experimental-strip-types`), the error says so. Workaround: write `.mjs`.
