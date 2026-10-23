# oat — Configuration

[← back to the overview](../README.md)

## Complete configs

These are copy-paste starting points. Real configs import `defineConfig` from `@lovrozagar/oat`. Files inside this repository import from `../dist/index.js` because they live in the source tree.

### Starting from oat init

`oat init --spec <url|file>` writes a starter `oat.config.ts` from the document: one `security` recipe per scheme it declares, each secret read with `env()`, and one principal. Set the env vars it prints, then run `oat doctor --config oat.config.ts`. A document that declares no scheme gets a commented `overlay.securitySchemes` stub to declare one. See [`oat init`](commands.md#oat-init).

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

See [Principals](#principals). Isolation keys off `tenant`. Rank keys off `rank` within one tenant.

## Configuration

Two inputs, always: **the spec** and **a config file**. Backend-specific knowledge lives in `x-*` tags and this file. A backend adopts oat by adding tags, not by adapting to oat.

A config is:

- `.ts` / `.js` / `.mjs` with `export default defineConfig({ ... })`, or
- `.json` with the same object.

Named export without `default` is also accepted (`module.default ?? module`).

### Top-level fields

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

| field           | required | default                                                   | notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| --------------- | -------- | --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `spec`          | yes      |                                                           | See [Spec loading](#spec-loading)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `baseUrl`       | yes      |                                                           | Primary origin. OpenAPI `servers[]` is ignored                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `principals`    | yes      |                                                           | A map of id → identity data, at least one. The first is the writer. See [Principals](#principals)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `security`      | no       |                                                           | One recipe per scheme the document declares: how each credential is obtained. See [Security recipes](#security-recipes)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `hooks`         | no       |                                                           | See [Hooks](#hooks)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `uploads`       | no       |                                                           | `pool` globs; optional `each` (operationId → globs) and `eachMax`. JSON configs may set all three                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `globalHeaders` | no       | `{}`                                                      | Merged first, then `resolveHeaders`, then caller headers. Never a credential: a credential header, or one where a scheme places its credential, exits 2                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `redact`        | no       |                                                           | `{ headers: ["x-tester-key"] }`: header names whose values are secret though they carry no credential, scrubbed wherever a run records them                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `origins`       | no       | `[]`                                                      | Extra `{ id, baseUrl, spec, maxRps?, overlay?, security? }` hosts. `security` maps an origin scheme to a primary recipe. Do not merge those routes into `spec`. See [Secondary origins](#secondary-origins)                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `outOfBand`     | no       | `{ attempts: 6, initialMs: 200, maxMs: 3000 }`            | Backoff for `resolveOutOfBand`. See [Hooks](#hooks)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `seed`          | no       | `1`                                                       | Integer. Same seed → same fixture bodies                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `cohortSize`    | no       | `7`                                                       | Sliced from the 7 built-in variants. Larger repeats the pattern                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `maxInFlight`   | no       | `4`                                                       | Across the whole run                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `maxRps`        | no       | none                                                      | Requests per second to `baseUrl` in all, across every route: a limit no route declares, such as a CDN or firewall capping each client IP. Route budgets (`rateLimits`, `x-rate-limit`) still hold under it                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `checks`        | no       | none on                                                   | Checks that run only when switched on, by id: `{ "auth.login-throttled": true }` sends failed logins for an identity that does not exist until the login answers 429. An unknown id is a config problem                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `payloads`      | no       | `"per-write-path"`                                        | String payload catalog: all 159 cases once per write path (media type + field type), one per family elsewhere; `"full"` sends every case to every field                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `only`          | no       | all                                                       | Entity names from `oat plan`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `keepFixtures`  | no       | `false`                                                   | Skip DELETE at the end                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `overlay`       | no       |                                                           | Patches to a document you cannot change: `{ operations: { "<operationId>": { … } }, schemas: { "<Name>": { … } }, securitySchemes: { "<name>": { … } }, security: [{ "<name>": [] }] }`. Objects merge, arrays replace, `null` deletes a key, a patch's own `operationId` renames the operation. A patch naming nothing is a usage error (exit 2), except `securitySchemes`, whose purpose is to declare a scheme the document lacks (`null` deletes one); `security` replaces the root requirement. Both apply before anything reads the document, so `doctor`, `plan` and `run` all see them. `origins[].overlay` does the same for an origin |
| `allow`         | no       |                                                           | The only operationIds oat may call. Every other operation leaves the document after the overlay, so no check, contract call, scenario or teardown can reach it; `oat doctor` lists what was removed. An entry naming nothing, or a recipe's login or refresh step, mint, revoke or scenario step needing a removed operation, is a usage error                                                                                                                                                                                                                                                                                                  |
| `fence`         | no       | `{ failRun: true }`                                       | With `hooks.beforeRequest`: whether a refused request alone fails the run (exit 3)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `baseline`      | no       |                                                           | Path, relative to the config, to a file `oat baseline` writes: `{ "version": 1, "entries": [{ "check", "entity"?, "operationId"?, "reason" }] }`. Matched findings are reported as known and do not fail the run; unmatched entries are reported as fixed. A file oat cannot read is a usage error                                                                                                                                                                                                                                                                                                                                              |
| `targetVersion` | no       |                                                           | Where the backend says which build it is, read once after sign-in: `{ operationId \| path, from, scheme? }`, with `from` a `$.json.path` into the body or `header:<name>`. An operation is read as the first principal under its security; a `path` is read anonymously, or as the first principal sending `scheme`, a scheme the document declares. Reports and `oat diff` show it; a version that cannot be read is noted and never changes the verdict                                                                                                                                                                                       |
| `teardown`      | no       | `{ verify: true }`                                        | After teardown, read each list again with the creator's credential; a record still listed after its delete answered 2xx is a leftover (`delete answered 2xx but the record is still listed`). `verify: false` skips the read                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `outDir`        | no       | `./.oat/runs`                                             | History root, relative to the config (the default, to the working directory). Each run writes `<outDir>/<datetime>/` and updates `latest`, with `principals.json`, which holds no credential value                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `saveExchanges` | no       | on unless `profile` is `cheap`                            | Persist every HTTP exchange under the run dir. `--save-exchanges` / `--no-save-exchanges` override. `--quiet` does not                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `network`       | no       | `{ retries: 4, waitMs: 60000, requestTimeoutMs: 180000 }` | When `fetch` throws (offline / DNS / reset / timeout): retry, then wait once for the link. Not a 5xx policy. `requestTimeoutMs: 0` disables the per-attempt cap                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `query`         | no       |                                                           | Global query-catalog defaults. Overlay after `x-query`. Does not invent operators                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `entities`      | no       |                                                           | Per-entity overlays. This release only reads `query`. Unknown names are ignored; `doctor` warns                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `scenarios`     | no       | `[]`                                                      | Declared flows for operations the matrix cannot reach. See [Scenarios](#scenarios)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |

`spec` may be a path relative to `baseUrl` (`/v1/openapi/spec`) or an absolute URL or a file. Every relative file path a config holds (`spec`, each origin's `spec`, `baseline`, `outDir`, upload patterns) is read from the config file's folder, whatever the working directory.

CLI `--base-url`, `--ops`, `--only`, `--seed`, `--out`, `--max-in-flight`, `--keep-fixtures`, `--save-exchanges` / `--no-save-exchanges` override these when passed.

### Spec loading

Resolved in this order, never by guessing the string's "look":

1. Absolute `http(s)://` or `file://` — used as given.
2. A path that exists on disk, relative to the config file's folder (a `--spec` on the command line: the working directory).
3. Anything else, when `baseUrl` is known — resolved against it (`/v1/openapi/spec`, `openapi.json`).

JSON if the first non-space character is `{` or `[`, otherwise YAML. Empty files error. A JSON document with more opening than closing brackets is diagnosed as truncated (proxy / download limit), not as a syntax error.

oat reads OpenAPI 3.0–3.2 only. oat reads `paths`, operations, parameters, request/response JSON schemas, and `x-*` extensions. A Swagger 2.0 document, an OpenAPI version below 3.0, or one newer than 3.2 is refused with exit 2, naming its version (`oat: api.json is Swagger 2.0; oat reads OpenAPI 3.0–3.2 only — convert it first`). A document with no `openapi` version string is not an OpenAPI document and fails to load.

Internal `$ref`s are dereferenced. When the document is a file, a `$ref` to another file by relative path (`./schemas/pet.yaml#/Pet`) is read too, relative to the file that names it, recursively, so a document split across files loads as one; a cycle across files works like one inside a file. Every such file must resolve inside the document's own folder, compared by real path: a ref by absolute path or `file:` URL, one that climbs out with `..`, or a symlink that points outside is refused with exit 2, as is a ref to a missing file (the error names the file and the file that refers to it). URL refs, anchor refs (`#Name`), and every ref in a document fetched by URL stay unresolved and show up in `oat doctor` / the JSON `externalRefs` list.

### Principals

```ts
principals: {
  alpha: {
    email: "alpha@example.test",          // identity data: recipes read it as {principal.email}
    tenant: "acme",                       // principals in different tenants are isolation peers
    scope: { org_id: "org_alpha" },       // path or query parameters bound for this principal
    rank: 2,                              // higher can do everything a lower rank can; default 0
    inviteAs: "key_beta",                 // how an owner names this principal in an invite body
    readOnly: true,                       // a viewer: its every write must be refused (auth.role-enforced)
    security: { apiKey: { static: "${KEY_ALPHA}" } }, // this principal's own recipe for a scheme
  },
}
```

The key is the principal's id, the stable name in reports. Every other field that is not one of the named ones is identity data, read only as `{principal.<key>}` in recipes; it never fills a parameter.

Rules that matter:

- **Isolation** (`tenant.*`) needs two principals whose `tenant` differs.
- **Rank** (`auth.rank-is-monotonic`) needs two principals in the _same_ tenant with different `rank`.
- **Invite** (`auth.invite-grants-then-revokes`) needs `x-invite` on the spec and a _different-tenant_ principal with `inviteAs` set.
- Extra principals are not ignored. Isolation picks the first different-tenant peer. Rank uses the same-tenant pair.
- `readOnly: true` marks an account that may only read. The security checks send its writes to a record the run created and expect each to be refused. When present it must be `true`.
- `scope` is the only way a principal binds a parameter. A login can bind `tenant` and `scope.<param>` from its answer with `claims`.
- `security.<scheme>` overrides the base recipe for this principal alone: one naming a kind replaces it (keeping `format` and `placements`); one naming only options merges over it.

At the end of a run, `hooks.teardownPrincipal` removes exactly the principals the run created, by their identity's `address` or `email`: a `fresh: true` principal, which the run signs up through the operation the document marks `x-fresh-principal`; a principal whose effective login recipe has a step calling that marked operation, so it registers and then signs in; and a principal with `created: true`, the opt-in for a login that registers through an operation the document does not mark. Nothing else is ever torn down, whatever its login binds or answers, so a long-lived test account survives every run.

Example — two tenants plus a same-tenant lattice:

```ts
security: {
	bearer: { login: { steps: [{ operationId: "auth.token", body: { key: "{principal.key}" } }], from: "$.access_token" } },
},
principals: {
	alpha: { key: "key_alpha", tenant: "org_alpha", scope: { org_id: "org_alpha" }, rank: 2 },
	alpha_member: { key: "key_alpha_member", tenant: "org_alpha", scope: { org_id: "org_alpha" }, rank: 1 },
	beta: { key: "key_beta", tenant: "org_beta", scope: { org_id: "org_beta" }, rank: 2, inviteAs: "key_beta" },
},
```

### Security recipes

Each operation is sent the credentials its OpenAPI `security` requires, placed where its scheme says: a bearer token in `Authorization`, an apiKey in its header, query parameter or cookie. `security` says only how to get each scheme's value, one recipe per scheme the document declares:

```ts
security: {
	jwt: {
		login: {
			steps: [{ operationId: "auth.login", body: { email: "{principal.email}", password: "{principal.password}" } }],
			from: "$.access_token",
			claims: { tenant: "org_id", "scope.project_id": "$.project.id" },
		},
		refresh: { steps: [{ operationId: "auth.refresh", body: { refresh_token: "{refreshToken}" } }], from: "$.access_token" },
		expiresIn: { from: "$.expires_in" },
	},
	apiKey: { static: "${API_KEY}", format: "ApiKey {credential}" },
},
```

A recipe has exactly one kind:

| kind                                                   | the value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `login: { steps, from, claims?, revoke? }`             | Run the steps; `from` is where the credential is in the last answer. `claims` binds `tenant` and `scope.<param>`: a value starting with `$` is a JSON path into the last answer's body, any other a JWT claim name. `revoke` names the operation that ends a session, alone or as `{ operationId, body }` with `{credential}` in the body: oat ends the sessions its probes open with it, and each principal's own at the very end, unless `--keep-credentials`. It is sent with the session it ends, so a 401 counts as revoked. Name every operation that ends sessions here (a logout, a session or token delete): the contract floor then calls it with a dedicated credential, never a principal's own session |
| `mint: { with, operationId, body?, from, revoke? }`    | Call `operationId` with the `with` scheme's credential; `{scopes}` in `body` becomes the scopes an operation needs. `revoke` runs at the end                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `static: "…"` or `{ username, password }`              | A fixed value; a basic scheme takes the pair                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `hook: true`                                           | `hooks.resolveCredential` returns it. See [Credentials from a hook](#credentials-from-a-hook)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `oauth2: { flow, clientId, clientSecret?, scopes? … }` | A `clientCredentials` or `password` grant at the `tokenUrl` the document declares                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

Options on any recipe: `format` replaces the scheme's value template (`ApiKey {credential}` for an apiKey sent in `Authorization`); `expiresIn` is seconds or `{ from }` in the issuing answer, else a JWT `exp`; `refresh` renews a login by its own steps; `holds` lists the scopes a static or hooked credential carries; `placements` adds places: `[{ in: "header" | "query" | "cookie", name, template? }]`.

An operation with alternatives is sent the first one, in document order, whose every scheme the principal has a recipe for. `security: []` or `{}` sends nothing. A 401 on a request sent with a stored credential renews it once and retries once; a second 401 is evidence. A declared `refresh` that fails falls back to one fresh login, never one that signs up again. A login that fails blocks that principal for that scheme for the rest of the run: the refused request keeps its 401, what needs the credential later is untested with the reason, and it is not retried.

The config is checked against the document and each origin's before anything is sent; every mistake is named, with the fix, and the CLI exits 2. That covers a recipe for a scheme the document lacks (with the nearest name), two kinds or none, a mint that loops or names no operation, a `{principal.<key>}` a principal does not have, and a `globalHeaders` entry where a credential goes.

### Login steps

Each step is one of:

**Operation step** (prefer this — survives the path moving):

```ts
{
  operationId: "auth.token",
  body: { key: "${API_KEY}" },
  headers: { "x-extra": "1" },
  query: { realm: "test" },
  saveAs: { credential: "$.access_token", refreshToken: "$.refresh_token" },
  saveClaimsFrom: { token: "$.access_token", bind: { orgId: "orgs.0.oid" } },
  bind: { address: "user@example.test" }, // literals, with {name} interpolation
  expect: [200],                            // default: any 2xx
}
```

**Request step** (when the document has no sign-in operation, or the hop is not in the spec):

```ts
{
  method: "POST",
  path: "/v1/auth/register/email",
  body: { email: "{address}", password: "…" },
  bind: { address: "oat-alpha@example.test" },
}
```

`path` is joined to this origin's `baseUrl`, unless it is an absolute `http://` or `https://` URL — then oat dispatches to that URL as a recorded exchange (method, URL, status, redirects, response headers). That is how a consume page on the app origin is a login step when `baseUrl` is the API. Unknown host is allowed. `redirect` defaults to `"follow"` with a per-request cookie jar, so a 303 that sets `Set-Cookie` still leaves that cookie visible to `saveAs`. `redirect: "manual"` stops at the first 3xx (`expect: [303]` then bind from that response). An `operationId` step, and every call oat makes on its own, stops at the first 3xx when that operation documents a 3xx: the redirect is the documented answer, and the page behind it is not. A required query, header or cookie parameter the request leaves unnamed is sent with the value the document declares for it, written in its declared style ([Parameters](model.md#parameters)); with no declared value it is left out, never invented. Naming it, even as `undefined`, keeps it the caller's.

**Out-of-band step** (email link, OTP — oat cannot collect this itself):

```ts
{ outOfBand: { address: "{address}", kind: "email-verify", as: "verifyLink" } }
```

The hook returns a string. If that string is a URL, a later RequestStep must GET it — a hook-side `fetch` is not a recorded exchange.

oat tells the hook when the request this value answers was sent (`since`): the latest earlier request in the flow or scenario that names `address` in its URL or body. A later request to someone else does not move it. When no request names the address, oat passes no `since`. A value sent before the scenario began — by a scheduled job, or into a seeded inbox — sets `sentEarlier: true`, so a sign-in that names the address does not hide it:

```ts
{ outOfBand: { address: "{offerEmail}", as: "offerToken", kind: "upsell-offer", sentEarlier: true } }
```

Later steps interpolate `{name}` from the flow scope, `saveAs` addresses included (`cookie:rt.{userId}` reads a per-user cookie). `saveAs` addresses:

- `$.foo.bar` / `$.orgs.0.id` — JSON body (dot + numeric index only; no JSON Pointer, no filters)
- `cookie:<name>` — that cookie on `Set-Cookie` for this hop, including followed hops
- `header:<name>` — a non-set-cookie response header, case-insensitive

A login or refresh `from` and its steps' `saveAs`, an `oauth2` grant's tokens, and `expiresIn: { from }` read an answer whose media type is `application/x-www-form-urlencoded` (parameters such as `; charset=utf-8` ignored) as a form: `access_token` or `$.access_token` names a field. Form answers support top-level keys only. Any other answer is read as JSON, never sniffed, and a value it does not hold fails with a reason that names its type. Every value read from a form is a secret before the answer is recorded, as from JSON.

Missing cookie / header / JSON path fails the step closed. Bind `saveAs.refreshToken` from `$.refresh_token` or `cookie:refresh` so `{refreshToken}` interpolates in `refresh`. A `{name}` in a login or refresh step that nothing fills (an earlier `saveAs`, `bind`, `saveClaimsFrom` or out-of-band `as`; for a refresh, also what the login saved and `{credential}`) is a config error naming it; where only the run knows the value, a signup's answer say, the step is refused before it is sent and the principal is BLOCKED for that scheme. `saveClaimsFrom.token` is a JSON path into the response body (`$.access_token`) or a scope key already bound by `saveAs` (`credential`). Signature is not verified — oat is reading its own credential.

`bind` on a step runs **before** the request. `saveAs` then `saveClaimsFrom` run **after**. `from` is read from the last HTTP response unless a step already saved `credential`. `outOfBand.as = "credential"` still wins over `from`.

A login that registers the account it signs in to is torn down only when it calls the `x-fresh-principal` operation or the principal sets `created: true`; see [Principals](#principals).

### Removed in 0.25.0

A config with any of these exits 2, naming the replacement:

| removed                                                      | instead                                                            |
| ------------------------------------------------------------ | ------------------------------------------------------------------ |
| `principals` as an array                                     | a map of id → identity data                                        |
| `principals[].headers`                                       | `security.<scheme>: { static: … }`                                 |
| `principals[].auth`                                          | `security.<scheme>: { login: { steps, from } }`                    |
| `principals[].roots`, top-level `roots`                      | `principals.<id>.scope`, and `tenant`                              |
| `rootsFromFlow`                                              | `security.<scheme>.login.claims`                                   |
| `x-auth-flows`, in the config or the document                | a `security.<scheme>` recipe                                       |
| a credential in `globalHeaders` (`Authorization`, `Cookie`…) | the scheme places it; `redact.headers` for a non-credential secret |
| `hooks.resolvePrincipalAuth`                                 | `{ hook: true }` and `hooks.resolveCredential`                     |

### Scenarios

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

### Credentials from a hook

When the credential is produced outside oat (a human finishes Google OAuth on a harvest page, a pair lands in KV, a TOTP code), do not make oat drive `authorize` / `callback`. Declare a hook recipe:

```ts
security: { google: { hook: true } },
hooks: {
	resolveCredential: async (scheme, principal) => readHarvested(scheme, principal.id),
},
```

oat calls `hooks.resolveCredential(scheme, { id, identity })` on every acquire, so a renewal calls it again. Return the value, `{ value, expiresIn? }`, or `null`, which blocks that principal for that scheme with the reason in the report. oat does not speak OAuth.

### Secondary origins

One run, one primary `baseUrl`. A CDN (or any second host) keeps its own OpenAPI.

```ts
export default defineConfig({
	spec: "https://api.example.com/openapi.json",
	baseUrl: "https://api.example.com",
	security: {
		jwt: { login: { steps: [{ operationId: "auth.login", body: { email: "{principal.email}" } }], from: "$.token" } },
	},
	principals: { alpha: { email: "alpha@example.test", tenant: "acme" } },
	origins: [
		{
			id: "cdn",
			baseUrl: "https://cdn.example.com",
			spec: "https://cdn.example.com/openapi.json",
			security: { bearer: "jwt" },
		},
	],
})
```

Each origin's document is read once, at load, and the config is checked against it too. An origin scheme sends a primary recipe's credential only where `origins[].security` maps it (`{ <origin scheme>: <primary scheme> }`); an unmapped scheme sends nothing, and an origin scheme that shares a name with a primary recipe must be mapped. The same principals run the matrix against that document. Login steps may set `origin: "cdn"` to send one hop to a named origin.

Do not merge CDN routes into the API gateway document.

### Hooks

```ts
hooks: {
  // Return null to retry (attempt is 1-based). oat backs off until a value arrives.
  // `scope` is the flow at this step. No credential is passed: one travels only through oat's client.
  // `since` (unix ms) is when the request that named `address` was sent, when one did:
  // a mail delivered before it answers some earlier request, so return null and wait.
  resolveOutOfBand: async ({ address, kind, attempt, scope, since }) => {
    const mail = await readMailCatcher(address, kind)
    if (mail === null || (since !== undefined && mail.receivedAt < since)) return null
    return mail.link // URL or token string
  },
  // Remove a principal this run provisioned. `sends` places its last live credential as its scheme does.
  teardownPrincipal: async (address, { credential, sends }) => {
    await fetch(`https://api.example.com/v1/auth/account`, { method: "DELETE", headers: sends.headers })
  },
  // A path parameter oat cannot create. Told the principal it acts as, its scope and identity, and the
  // credential and placement the operation would carry as it: decode the token, or call the API as it.
  resolvePathValue: async ({ param, principal, credential, sends }) => {
    if (param !== "project_id" || credential === undefined) return null
    const res = await fetch("https://api.example.com/v1/projects", { headers: sends?.headers })
    return (await res.json())[0]?.id ?? null
  },
  // Return a file to send, `{ fields }` to replace the whole request, or null to fall through.
  resolveUpload: async ({ operationId, field, contentMediaType }) => {
    if (operationId === "extract.once" && field === "file") {
      const bytes = await Deno.readFile("./invoices/known.pdf")
      return { bytes, filename: "known.pdf", mediaType: "application/pdf" }
    }
    return null
  },
  // After globalHeaders; never a credential. Return null to add nothing.
  resolveHeaders: async ({ operationId, method, url }) => {
    if (operationId === "auth.register" || operationId === "auth.login") {
      return { "cf-turnstile-response": await harvestTurnstile() }
    }
    return null
  },
  // Replace a generated JSON field. Null keeps the generator.
  resolveInput: async ({ operationId, field }) => {
    if (operationId === "billing.subscribe" && field === "payment_method_id") {
      return process.env.STRIPE_TEST_PM
    }
    return null
  },
  // The credential for a `{ hook: true }` recipe, per scheme and principal. Called on every
  // acquire, so a TOTP code is fresh. Null blocks that principal for that scheme.
  resolveCredential: async (scheme, { id, identity }) => {
    const pair = await readHarvested(scheme, id)
    return pair === null ? null : { value: pair.access_token, expiresIn: pair.expires_in }
  },
  // After seed: add or replace any axis of the query catalog. Null keeps the merge.
  resolveQueryCapabilities: async ({ entity, get }) => {
    if (entity !== "row") return null
    const body = await get("table.get")
    return { filterable: /* harvest from body */ [] }
  },
  // A scenario `external` step: something only a browser or a person can do. Return the value
  // the next step needs, or null to fail the step.
  external: async (name, input) => {
    if (name === "pay-with-test-card") return await payInBrowser(String(input.url), "4242424242424242")
    return null
  },
  // Optional extra stop condition while x-wait polls.
  awaitSideEffect: async ({ operationId, record }) => {
    if (operationId !== "webhook.deliver") return null
    return Array.isArray((record as { items?: unknown }).items) && (record as { items: unknown[] }).items.length > 0
      ? true
      : null
  },
}
```

Without `resolveOutOfBand`, an `outOfBand` step cannot complete. oat polls the hook; the hook must not sleep. Returning `""` is treated like `null`. The hook is not a recorded hop: if the human GETs a mailed URL, a later RequestStep must GET that URL so it appears in `exchanges.jsonl` and can `expect` / `saveAs`.

Default schedule (0.6.2, unchanged unless `outOfBand` is set): **6** attempts, first sleep **200** ms, doubling, cap **3000** ms. oat sleeps after every miss, including the last, so the worst-case wait is

`200 + 400 + 800 + 1600 + 3000 + 3000 = 9000` ms.

That is too short for real mail (often 10–60 s) and for a human finishing Google OAuth or a Turnstile harvest. Configure it:

```ts
outOfBand: { attempts: 20, initialMs: 1000, maxMs: 8000 }
// worst case: 1000 + 2000 + 4000 + 8000×17 = 143000 ms
```

Worst-case wait is `sum_{i=0}^{attempts-1} min(initialMs × 2^i, maxMs)`. `worstCaseWaitMs()` from the package computes it. Existing configs that omit `outOfBand` do not slow down.

Without `teardownPrincipal`, provisioned accounts are reported as leftover rather than cascade-deleted. Per-record DELETE still runs for seeded rows when a delete (or `x-cleanup`) exists. The hook is called with the last live credential (`ctx.credential`, and `ctx.sends`: its headers, query and cookies as the scheme places them), not an already-cleared one, so authenticated delete-account is expressible without a tester-key god route. One-argument JavaScript callbacks still run.

#### Proving a record gone

Teardown counts a record gone when its delete answers 2xx and its list no longer holds it. A record its creator could never read back proves nothing that way, so teardown reads it once before the delete; one still never seen is a leftover (`its creator could never read it back, so teardown cannot tell whether it is gone`) unless an ancestor was removed earlier in the run. `hooks.verifyRemoved` settles it from somewhere HTTP does not reach:

```ts
hooks: {
  verifyRemoved: async ({ entity, id, scope, principal }) => {
    const row = await db.oneOrNone(`select 1 from ${entity}s where id = $1`, [id])
    return row === null ? "absent" : "present"
  },
}
```

It is asked about every record teardown counted removed and every one it could not show gone, four at a time. `"present"` makes the record a leftover (`hooks.verifyRemoved says it is still present`), `"absent"` clears one never seen, and `"unknown"` keeps teardown's own verdict. A hook that throws counts as `"unknown"`, and the run reports one `teardown.verify-hook` gap.

`resolveHeaders` is called on every dispatch (including the 401 retry). Merge order: `globalHeaders` → hook → per-request headers. The credential is placed by its scheme after them; a header from any of them that names a credential's place is an error, never an override. Use `ctx.operationId` / `ctx.method` / `ctx.url` to attach a one-shot captcha only on captcha ops. oat does not speak Turnstile.

`resolveInput` is the JSON twin of `resolveUpload`. Return a value to replace that field (`payment_method_id` on `billing.subscribe`); `null` keeps the generator. `request.value` is the generated value, or `undefined` when the field was left out. Return `null` for an omitted field or a value outside the schema's length or range bounds so a constraint check is the body the server receives.

`resolveQueryCapabilities` runs once per entity after seed. `get(operationId)` (or `"GET /path"`) uses the seeded parent scope so a follow-up read can harvest dynamic columns. A provided `filterable` / `sortable` / `searchable` / `selectable` list **replaces** that axis; omitted axes stay. JSON configs have no hook.

`resolveCredential` is documented under [Credentials from a hook](#credentials-from-a-hook); `awaitSideEffect` with `x-wait`.

Worked `query` overlay for a generic PostgREST-shaped API (not a named product):

```ts
export default defineConfig({
	spec: "https://api.example.com/openapi.json",
	baseUrl: "https://api.example.com",
	security: { bearer: { static: `${process.env.TOKEN}` } },
	principals: { alpha: {} },
	query: {
		operators: ["eq", "neq", "gt", "gte", "lt", "lte", "in", "nin", "like", "ilike", "is"],
		operatorsByType: {
			string: ["eq", "neq", "like", "ilike", "in", "nin", "is"],
			number: ["eq", "neq", "gt", "gte", "lt", "lte", "in", "nin", "is"],
			date: ["eq", "neq", "gt", "gte", "lt", "lte", "is"],
			boolean: ["eq", "neq", "is"],
		},
		aliases: { ne: "neq" },
		emptyIn: "match-none",
		maxInValues: 100,
		maxFilterConditions: 20,
		searchEmpty: "match-all",
		sort: { nulls: ["first", "last"], maxKeys: 3 },
		select: { nested: false, unknown: "reject" },
	},
})
```

New surface still has to be listed. oat will not silently enable `in` / `ilike` / `is` / `contains` / search modes / `nullsfirst` on every PostgREST-shaped document.

### Request fence

`hooks.beforeRequest(request)` sees every request before it leaves the process — the document fetch, sign-in, seeding, checks, scenarios, teardown and the reachability probe — and answers `{ allow: true }` or `{ allow: false, reason }`. `request` is `{ method, url, headers, body, operationId?, phase, principal?, schemes?, forged? }`, with `phase` one of `load`, `auth`, `seed`, `assertion`, `probe`, `teardown` or `request`. `principal` and `schemes` name whose credential the request carries and under which security schemes, `forged: true` marks a forged value a probe sends, and all three are absent for an anonymous request, so a fence can decide by who and which scheme without parsing `Authorization`. beforeRequest sees the request as sent, including placed credentials; never log it unredacted.

A refused request is never sent and never judged: its check is unresolved with a `fence` blocked entry, a refused seed blocks the entity, a refused delete is a leftover whose reason starts with `fenced`, and a refused sign-in or document fetch stops the run with exit 3. The report's **Fenced requests** section and `fenced` in `oat-report.json` list every refusal. Any refusal fails the run (exit 3) unless `fence: { failRun: false }`.

```ts
hooks: {
	beforeRequest: ({ method, operationId }) =>
		method === "DELETE" && operationId !== "row.delete"
			? { allow: false, reason: "only rows may be deleted on the shared backend" }
			: { allow: true },
},
```

### Uploads

Multipart and binary parts are filled in this order:

1. `hooks.resolveUpload` — a non-null `UploadFile` wins. `{ fields }` that includes a file part replaces the whole request. `{ fields }` that omits the file part overlays scalars and keeps the each / pool / dummy bytes.
2. `uploads.each` fixture for this invocation, when that operation is listed.
3. `uploads.pool` — first file whose extension / sniffed type matches the part's `contentMediaType`. Same `seed` + field + index → same pick. Ops not in `each` stay pick-one.
4. A tiny dummy with sniffable magic (`%PDF-1.1`, 1×1 PNG, empty zip, …). Unknown types become 16 octet-stream bytes, not a skip.

`uploads.each` is a matrix, not a source. `operationId → globs` means that operation is invoked once per matched file (after `eachMax`). Same seed does **not** collapse `each`. A hook that ignores `request.fixture` and always returns the same file will send that file N times.

Each invocation is still a citeable hop (method, URL, status, fixture name, content-addressed body). Live `FormData` / `Blob` payloads are **not** kept on `Client.transcript` for the rest of the run — they are replaced with `{ sha256, bytes, mediaType }` (and multipart `{ parts }`) after the hop is journaled, or immediately when the journal is off. Fan-out therefore multiplies requests, not retained fixture bytes.

```ts
export default defineConfig({
	spec: "openapi.json",
	baseUrl: "https://api.example.com",
	principals: [/* … */],
	uploads: {
		pool: ["./fixtures/**/*"],
		each: {
			"extract.once": ["./fixtures/**/*"],
			"extract.stream": ["./fixtures/**/*"],
		},
		eachMax: 24,
	},
	hooks: {
		resolveUpload: async ({ operationId, field, fixture }) => {
			if (operationId === "extract.once" && field === "file") {
				return { fields: { columns: "vendor,date,amount" } }
			}
			return null
		},
	},
})
```

| case                            | outcome                                                     |
| ------------------------------- | ----------------------------------------------------------- |
| `each` omitted                  | pick-one (today)                                            |
| glob matches 0 files            | warn once, no extra invocations, fall through to pool/dummy |
| one path in the list is missing | drop that slot, warn once, never `BACKEND_BUG`              |
| `eachMax` < match count         | first `eachMax` after sort, warn that it capped             |
| fixture unreadable              | drop that slot, warn once, not `BACKEND_BUG`                |

A missing pool path warns once and falls through. An empty pool match uses a dummy. The run does not fail. JSON configs may set `pool`, `each`, and `eachMax`. `resolveUpload` is TypeScript.

`--profile cheap` (or any profile that excludes the op) still drops the whole family. `each` does not punch through a profile.

Findings from an `each` invocation carry `fixture: "invoice.pdf"` and render as `extract.once · invoice.pdf`. One 5xx is one finding on that file.

oat does not OCR. It sends bytes and checks HTTP / JSON. A 200 with empty extract rows is not automatically a backend defect. A 4xx because the dummy is “not a real invoice” is not automatically a backend defect if the dummy matched the declared `contentMediaType`.

Prefer `multipart/form-data` when the operation documents it, even if JSON is also listed. Text form fields still use the string generator (`format` / `pattern` / `maxLength`). A part that is either text or file is sent as a file when the schema is binary.

### Environment interpolation

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

### Loading TypeScript configs

`.js` / `.mjs` / `.json` load everywhere.

`.ts` / `.mts` configs, such as the one `oat init` writes, load under plain `node` on oat's floor, Node 22.18 or later, where type stripping is on by default. The published `oat` binary is itself JS; it still has to `import()` your config. If that fails (an older Node, or `--no-experimental-strip-types`), the error says so. Workaround: write `.mjs`.
