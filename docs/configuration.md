# oat — Configuration

[← back to the overview](../README.md)

## Complete configs

These are copy-paste starting points. Real configs import `defineConfig` from `@lovrozagar/oat`. Files inside this repository import from `../dist/index.js` because they live in the source tree.

### Static API keys, two tenants (smallest useful)

```ts
// oat.config.ts
import { defineConfig } from "@lovrozagar/oat"

export default defineConfig({
	spec: "https://api.example.com/openapi.json",
	baseUrl: "https://api.example.com",
	principals: [
		{
			id: "alpha",
			headers: { authorization: "Bearer ${API_TOKEN}" },
			roots: { project_id: "${PROJECT_A}" },
		},
		{
			id: "beta",
			headers: { authorization: "Bearer ${API_TOKEN_B}" },
			roots: { project_id: "${PROJECT_B}" },
		},
	],
})
```

```bash
export API_TOKEN=… API_TOKEN_B=… PROJECT_A=proj_a PROJECT_B=proj_b
oat run --config oat.config.ts
```

One principal is enough to seed and run CRUD / query / schema checks. The second principal, with different `roots`, is what makes `tenant.*` run. Without it those checks are **did not apply**, not a pass.

Shipped as `labs/minimal.config.ts` (and in the npm package).

### JSON config

Same object. `${NAME}` is interpolated after load. There is no `defineConfig` wrapper.

```json
{
	"spec": "https://api.example.com/openapi.json",
	"baseUrl": "https://api.example.com",
	"principals": [
		{
			"id": "alpha",
			"headers": { "authorization": "Bearer ${API_TOKEN}" },
			"roots": { "project_id": "${PROJECT_A}" }
		}
	],
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
	principals: [
		{
			id: "alpha",
			roots: { project_id: "proj_alpha" },
			auth: {
				credentialFrom: "$.access_token",
				steps: [{ operationId: "auth.token", body: { key: "key_alpha" } }],
			},
		},
		{
			id: "beta",
			roots: { project_id: "proj_beta" },
			auth: {
				credentialFrom: "$.access_token",
				steps: [{ operationId: "auth.token", body: { key: "key_beta" } }],
			},
		},
	],
})
```

`spec: "/v1/openapi/spec"` is resolved against `baseUrl`. `--base-url` on the CLI overrides the origin without editing the file.

### Two tenants plus a same-tenant rank lattice

See [Principals](#principals). Isolation keys off `roots`. Rank keys off `rank` with shared `roots`.

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
	principals: [/* at least one; see below */],
	hooks: {/* optional */},
	uploads: { pool: ["./fixtures/**/*"], eachMax: 24 },
	globalHeaders: { "x-request-id": "oat" }, // sent on every request; oat does not inspect them
	roots: { org_id: "org_shared" }, // path params oat cannot create; also declarable via x-root
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
	origins: [{ id: "cdn", baseUrl: "https://cdn.example.com", spec: "https://cdn.example.com/openapi.json" }],
	query: {
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
				identityFilter: "_id",
				filterable: [{ field: "_id", type: "string", ops: ["eq", "neq", "in"] }],
			},
		},
	},
})
```

| field           | required | default                                                   | notes                                                                                                                                                           |
| --------------- | -------- | --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `spec`          | yes      |                                                           | See [Spec loading](#spec-loading)                                                                                                                               |
| `baseUrl`       | yes      |                                                           | Primary origin. OpenAPI `servers[]` is ignored                                                                                                                  |
| `principals`    | yes      |                                                           | Non-empty. First is the writer                                                                                                                                  |
| `hooks`         | no       |                                                           | See [Hooks](#hooks)                                                                                                                                             |
| `uploads`       | no       |                                                           | `pool` globs; optional `each` (operationId → globs) and `eachMax`. JSON configs may set all three                                                               |
| `globalHeaders` | no       | `{}`                                                      | Merged first. `resolveHeaders` then caller headers then auth                                                                                                    |
| `origins`       | no       | `[]`                                                      | Extra `{ id, baseUrl, spec }` hosts. Auth JWT is reused. Do not merge those routes into `spec`                                                                  |
| `outOfBand`     | no       | `{ attempts: 6, initialMs: 200, maxMs: 3000 }`            | Backoff for `resolveOutOfBand` and `resolvePrincipalAuth`. See [Hooks](#hooks)                                                                                  |
| `roots`         | no       | `{}`                                                      | Shared path params (merged with each principal's `roots`)                                                                                                       |
| `seed`          | no       | `1`                                                       | Integer. Same seed → same fixture bodies                                                                                                                        |
| `cohortSize`    | no       | `7`                                                       | Sliced from the 7 built-in variants. Larger repeats the pattern                                                                                                 |
| `maxInFlight`   | no       | `4`                                                       | Across the whole run                                                                                                                                            |
| `payloads`      | no       | `"per-write-path"`                                        | String payload catalog: all 159 cases once per write path (media type + field type), one per family elsewhere; `"full"` sends every case to every field         |
| `only`          | no       | all                                                       | Entity names from `oat plan`                                                                                                                                    |
| `keepFixtures`  | no       | `false`                                                   | Skip DELETE at the end                                                                                                                                          |
| `outDir`        | no       | `./.oat/runs`                                             | History root. Each run writes `<outDir>/<datetime>/` and updates `latest`. Also writes `principals.json` after acquire                                          |
| `saveExchanges` | no       | on unless `profile` is `cheap`                            | Persist every HTTP exchange under the run dir. `--save-exchanges` / `--no-save-exchanges` override. `--quiet` does not                                          |
| `network`       | no       | `{ retries: 4, waitMs: 60000, requestTimeoutMs: 180000 }` | When `fetch` throws (offline / DNS / reset / timeout): retry, then wait once for the link. Not a 5xx policy. `requestTimeoutMs: 0` disables the per-attempt cap |
| `query`         | no       |                                                           | Global query-catalog defaults. Overlay after `x-query`. Does not invent operators                                                                               |
| `entities`      | no       |                                                           | Per-entity overlays. This release only reads `query`. Unknown names are ignored; `doctor` warns                                                                 |

`spec` may be a path relative to `baseUrl` (`/v1/openapi/spec`) or an absolute URL or a file.

CLI `--base-url`, `--ops`, `--only`, `--seed`, `--out`, `--max-in-flight`, `--keep-fixtures`, `--save-exchanges` / `--no-save-exchanges` override these when passed.

### Spec loading

Resolved in this order, never by guessing the string's "look":

1. Absolute `http(s)://` or `file://` — used as given.
2. A path that exists on disk, relative to the working directory.
3. Anything else, when `baseUrl` is known — resolved against it (`/v1/openapi/spec`, `openapi.json`).

JSON if the first non-space character is `{` or `[`, otherwise YAML. Empty files error. A JSON document with more opening than closing brackets is diagnosed as truncated (proxy / download limit), not as a syntax error.

OpenAPI 3.0 and 3.1 both work. oat reads `paths`, operations, parameters, request/response JSON schemas, and `x-*` extensions. It does not require a particular `openapi:` version string.

Internal `$ref`s are dereferenced. External `$ref`s stay unresolved and show up in `oat doctor` / the JSON `externalRefs` list.

### Principals

```ts
{
  id: "alpha",                          // required, stable name in reports
  headers: { authorization: "Bearer …" }, // static; enough for a long-lived key
  auth: { /* AuthFlow — see below */ },
  roots: { org_id: "org_alpha" },       // this principal's tenant / path params
  rootsFromFlow: { org_id: "orgId" },   // take path params from values the auth flow bound
  role: "owner",                        // free-form label in reports
  rank: 2,                              // higher can do everything a lower rank can; default 0
  inviteAs: "key_beta",                 // how an owner names this principal in an invite body
}
```

Rules that matter:

- **Isolation** (`tenant.*`) needs two principals whose `roots` differ.
- **Rank** (`auth.rank-is-monotonic`) needs two principals with the _same_ `roots` and different `rank`.
- **Invite** (`auth.invite-grants-then-revokes`) needs `x-invite` on the spec and a _different-tenant_ principal with `inviteAs` set.
- Extra principals are not ignored. Isolation picks the first different-`roots` peer. Rank uses the same-tenant pair.
- `headers` and `auth` compose: static headers are sent, then the flow's credential header is merged on top.
- A principal with only `headers` (no `auth`) never hits a login route.
- `auth` may be a harvested credential instead of a step chain: `{ fromHook: "oauth-google" }`. See [Harvested principal](#harvested-principal).

Example — two tenants plus a same-tenant lattice:

```ts
principals: [
	{
		id: "alpha",
		role: "owner",
		rank: 2,
		auth: {
			credentialFrom: "$.access_token",
			steps: [{ operationId: "auth.token", body: { key: "key_alpha" } }],
		},
		roots: { org_id: "org_alpha" },
	},
	{
		id: "alpha_member",
		role: "member",
		rank: 1,
		auth: {
			credentialFrom: "$.access_token",
			steps: [{ operationId: "auth.token", body: { key: "key_alpha_member" } }],
		},
		roots: { org_id: "org_alpha" },
	},
	{
		id: "beta",
		role: "owner",
		rank: 2,
		inviteAs: "key_beta",
		auth: {
			credentialFrom: "$.access_token",
			steps: [{ operationId: "auth.token", body: { key: "key_beta" } }],
		},
		roots: { org_id: "org_beta" },
	},
]
```

### Auth flows

```ts
auth: {
  steps: [ /* register / verify — first acquire only */ ],
  credentialFrom: "$.access_token", // JSON path in the last (or saved) response
  expiresInFrom: "$.expires_in",    // lifetime in seconds
  header: "authorization",          // default
  template: "Bearer {credential}",  // default
  assumeTtlMs: 3600000,             // used only if neither expiresInFrom nor JWT exp is present
  refreshBufferMs: 30_000,          // optional; default 30s. Proactive when expiresAt - now <= this
  refresh: {                        // signup flows must set this — re-running steps is not a refresh
    steps: [
      {
        operationId: "auth.refreshToken",
        body: { refresh_token: "{refreshToken}" },
        saveAs: {
          credential: "$.access_token",
          refreshToken: "$.refresh_token",
        },
      },
    ],
  },
}
```

Expiry is `expiresInFrom` (seconds) → JWT `exp` claim → `assumeTtlMs`. `assumeTtlMs` is only the fallback lifetime when nothing else revealed expiry — it is not used for the refresh threshold when `expiresAt` is known.

Refresh is countdown-based (`expiresAt - refreshBufferMs`, default 30s) before every dispatch and before each async poll. Signup flows declare `auth.refresh` (refresh-token operation). Re-running `steps` is only the fallback when `refresh` is omitted (API-key / token-exchange principals). A register-like first hop without `refresh` fails closed (`AUTH_REFRESH_REQUIRED`) rather than signing up again.

One 401 → force refresh + single retry with live headers. A second 401 is evidence. 5xx / 429 are never a refresh trigger. `expiresAt === null` (static-header principal) never proactive-refreshes.

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

**Request step** (when the document has no auth operations, or the hop is not in the spec):

```ts
{
  method: "POST",
  path: "/v1/auth/register/email",
  body: { email: "{address}", password: "…" },
  bind: { address: "oat-alpha@example.test" },
}
```

`path` is joined to this origin's `baseUrl`, unless it is an absolute `http://` or `https://` URL — then oat dispatches to that URL as a recorded exchange (method, URL, status, redirects, response headers). That is how a consume page on the app origin is an auth step when `baseUrl` is the API. Unknown host is allowed. `redirect` defaults to `"follow"` with a per-request cookie jar, so a 303 that sets `Set-Cookie` still leaves that cookie visible to `saveAs`. `redirect: "manual"` stops at the first 3xx (`expect: [303]` then bind from that response).

**Out-of-band step** (email link, OTP — oat cannot collect this itself):

```ts
{ outOfBand: { address: "{address}", kind: "email-verify", as: "verifyLink" } }
```

The hook returns a string. If that string is a URL, a later RequestStep must GET it — a hook-side `fetch` is not a recorded exchange.

Later steps interpolate `{name}` from the flow scope, `saveAs` addresses included (`cookie:rt.{userId}` reads a per-user cookie). `saveAs` addresses:

- `$.foo.bar` / `$.orgs.0.id` — JSON body (dot + numeric index only; no JSON Pointer, no filters)
- `cookie:<name>` — that cookie on `Set-Cookie` for this hop, including followed hops
- `header:<name>` — a non-set-cookie response header, case-insensitive

Missing cookie / header / JSON path fails the auth step closed. Bind `saveAs.refreshToken` from `$.refresh_token` or `cookie:refresh` so `{refreshToken}` interpolates in `auth.refresh`. `saveClaimsFrom.token` is a JSON path into the response body (`$.access_token`) or a scope key already bound by `saveAs` (`credential`). Signature is not verified — oat is reading its own credential. `rootsFromFlow` maps path parameter names to those bound keys.

`bind` on a step runs **before** the request. `saveAs` then `saveClaimsFrom` run **after**. `credentialFrom` is read from the last HTTP response unless a step already saved `credential`. `outOfBand.as = "credential"` still wins over `credentialFrom`.

If a step's status is not acceptable, auth fails the run (not a finding): `oat: principal "alpha" failed at auth step 2 (POST /v1/…)`.

A complete register → mailed GET → cookie session example:

```ts
function signUp(email: string): AuthFlow {
	return {
		credentialFrom: "$.access_token",
		expiresInFrom: "$.access_token_expires_in",
		header: "cookie",
		template: "session={credential}",
		refresh: {
			steps: [
				{
					body: { refresh_token: "{refreshToken}" },
					method: "POST",
					path: "/v1/auth/refresh",
					saveAs: { credential: "$.access_token", refreshToken: "$.refresh_token" },
				},
			],
		},
		steps: [
			{
				bind: { address: email },
				body: { email, password: "…" },
				method: "POST",
				path: "/v1/auth/register/email",
				saveAs: { credential: "$.access_token", refreshToken: "$.refresh_token" },
			},
			{ outOfBand: { address: email, as: "verifyLink", kind: "email-verify" } },
			{
				method: "GET",
				path: "{verifyLink}", // absolute URL; not joined to baseUrl
				expect: [200, 303],
				saveAs: {
					credential: "cookie:session",
					refreshToken: "cookie:refresh",
				},
				saveClaimsFrom: {
					token: "credential",
					bind: { orgId: "orgs.0.oid", projectId: "orgs.0.pids.0" },
				},
			},
		],
	}
}
```

When the user path **is** POST-token, keep that chain — it is still valid:

```ts
{ outOfBand: { address: email, as: "verifyToken", kind: "email-verify" } },
{
  body: { token: "{verifyToken}" },
  method: "POST",
  path: "/v1/auth/email/verify",
  saveAs: { credential: "$.access_token", refreshToken: "$.refresh_token" },
  saveClaimsFrom: { token: "$.access_token", bind: { orgId: "orgs.0.oid" } },
}
```

```ts
principals: [
	{
		id: "alpha",
		auth: signUp("oat-alpha@example.test"),
		rootsFromFlow: { organization_id: "orgId", project_id: "projectId" },
	},
]
```

The address used for `teardownPrincipal` is `scope.address` or `scope.email` (set via `bind: { address }` or `bind: { email }`).

### Harvested principal

When the credential is produced outside oat (a human finishes Google OAuth on a harvest page, a pair lands in KV), do not make oat drive `authorize` / `callback`:

```ts
{
  id: "google-user",
  auth: { fromHook: "oauth-google" },
}
```

oat polls `hooks.resolvePrincipalAuth("oauth-google")` with the same `outOfBand` backoff as mail. Return `{ credential, refreshToken?, expiresIn? }` or `null` to retry. Refresh re-calls the hook (401 and countdown). oat does not speak OAuth.

### Secondary origins

One run, one primary `baseUrl`. A CDN (or any second host) keeps its own OpenAPI.

```ts
export default defineConfig({
	spec: "https://api.example.com/openapi.json",
	baseUrl: "https://api.example.com",
	principals: [/* acquire JWT on the API */],
	origins: [{ id: "cdn", baseUrl: "https://cdn.example.com", spec: "https://cdn.example.com/openapi.json" }],
})
```

After primary auth, oat snapshots the principals, binds those credentials to the other host, and runs the matrix against that document. Auth steps may set `origin: "cdn"` to send one hop to a named origin during acquire.

Do not merge CDN routes into the API gateway document.

A second `defineConfig` can reuse the first run's snapshot instead:

```ts
import { defineConfig, loadPersistedPrincipals } from "@lovrozagar/oat"

export default defineConfig({
	spec: "https://cdn.example.com/openapi.json",
	baseUrl: "https://cdn.example.com",
	principals: loadPersistedPrincipals("./.oat/runs/latest/principals.json"),
})
```

The CLI writes `principals.json` into each run folder (and `.oat/runs/latest/principals.json` via the `latest` symlink).

### Hooks

```ts
hooks: {
  // Return null to retry (attempt is 1-based). oat backs off until a value arrives.
  // `scope` is the flow at this step; `headers` are the live principal credential headers.
  resolveOutOfBand: async ({ address, kind, attempt, scope, headers }) => {
    const link = await readMailCatcher(address, kind)
    return link // URL or token string, or null
  },
  // Remove a principal this run provisioned. `ctx` is the last live credential.
  teardownPrincipal: async (address, { credential, headers }) => {
    await fetch(`https://api.example.com/v1/auth/account`, { method: "DELETE", headers })
  },
  // Return a file to send, `{ fields }` to replace the whole request, or null to fall through.
  resolveUpload: async ({ operationId, field, contentMediaType }) => {
    if (operationId === "extract.once" && field === "file") {
      const bytes = await Deno.readFile("./invoices/known.pdf")
      return { bytes, filename: "known.pdf", mediaType: "application/pdf" }
    }
    return null
  },
  // After globalHeaders, before auth. Return null to add nothing.
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
  // Harvested OAuth pair. Null retries with the outOfBand backoff.
  resolvePrincipalAuth: async (fromHook) => {
    if (fromHook !== "oauth-google") return null
    const pair = await readHarvestedGoogle()
    return pair === null ? null : { credential: pair.access_token, refreshToken: pair.refresh_token, expiresIn: pair.expires_in }
  },
  // After seed: add or replace any axis of the query catalog. Null keeps the merge.
  resolveQueryCapabilities: async ({ entity, get }) => {
    if (entity !== "row") return null
    const body = await get("table.get")
    return { filterable: /* harvest from body */ [] }
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

Without `teardownPrincipal`, provisioned accounts are reported as leftover rather than cascade-deleted. Per-record DELETE still runs for seeded rows when a delete (or `x-cleanup`) exists. The hook is called with the last live credential (`ctx.credential` / `ctx.headers`), not an already-cleared one, so authenticated delete-account is expressible without a tester-key god route. One-argument JavaScript callbacks still run.

`resolveHeaders` is called on every dispatch (including the 401 retry). Merge order: `globalHeaders` → hook → per-request headers → principal credential. Use `ctx.operationId` / `ctx.method` / `ctx.url` to attach a one-shot captcha only on captcha ops. oat does not speak Turnstile.

`resolveInput` is the JSON twin of `resolveUpload`. Return a value to replace that field (`payment_method_id` on `billing.subscribe`); `null` keeps the generator. `request.value` is the generated value, or `undefined` when the field was left out. Return `null` for an omitted field or a value outside the schema's length or range bounds so a constraint check is the body the server receives.

`resolveQueryCapabilities` runs once per entity after seed. `get(operationId)` (or `"GET /path"`) uses the seeded parent scope so a follow-up read can harvest dynamic columns. A provided `filterable` / `sortable` / `searchable` / `selectable` list **replaces** that axis; omitted axes stay. JSON configs have no hook.

`resolvePrincipalAuth` and `awaitSideEffect` are documented below.

Worked `query` overlay for a generic PostgREST-shaped API (not a named product):

```ts
export default defineConfig({
	spec: "https://api.example.com/openapi.json",
	baseUrl: "https://api.example.com",
	principals: [{ id: "alpha", headers: { authorization: `Bearer ${process.env.TOKEN}` } }],
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
headers: {
	authorization: "Bearer ${API_TOKEN}"
}
```

If `API_TOKEN` is unset, oat exits with an error. Do not commit secrets; put them in the environment.

Template literals in a `.ts` config (`Bearer ${process.env.API_TOKEN}`) are evaluated by Node _before_ oat sees the object. Either style works; `${NAME}` is what a `.json` config can use.

Names match `[A-Z0-9_]+` case-insensitively.

### Loading TypeScript configs

`.js` / `.mjs` / `.json` load everywhere.

`.ts` configs require a runtime that can import TypeScript: Node 22.6+ with `--experimental-strip-types`, or Node 23+. The published `oat` binary is itself JS; it still has to `import()` your config. If that fails, the error says so. Workaround: compile the config, or write `.mjs`.

```bash
node --experimental-strip-types ./node_modules/@lovrozagar/oat/dist/cli.js run --config oat.config.ts
```
