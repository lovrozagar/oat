# oat — Principals and security

[← back to the overview](../../README.md)

Who oat acts as, and how each OpenAPI security scheme gets its value.

## Principals

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

The key is the principal's id, the stable name in reports. One principal is the writer: it makes the records every check works on, and the rest act on them. `writer: "<id>"` at the top level names it; unset, the first principal in the map writes. A sort-keys lint rule reorders a map's keys, and with them the writer, so a config under one names its `writer`:

```ts
writer: "alpha",
principals: { admin: { … }, alpha: { … }, beta: { … } },
```

A `writer` that names no principal exits 2, listing the principals there are. `oat doctor` prints who writes and why. Every other field that is not one of the named ones is identity data, read only as `{principal.<key>}` in recipes; it never fills a parameter.

Rules that matter:

- **Isolation** (`tenant.*`) needs two principals whose `tenant` differs.
- **Rank** (`auth.rank-is-monotonic`) needs two principals in the _same_ tenant with different `rank`.
- **Invite** (`auth.invite-grants-then-revokes`) needs `x-invite` on the spec and a _different-tenant_ principal with `inviteAs` set.
- Extra principals are not ignored. Isolation picks the first different-tenant peer. Rank uses the same-tenant pair.
- `readOnly: true` marks an account that may only read. The security checks send its writes to a record the run created and expect each to be refused. When present it must be `true`.
- `scope` is the only way a principal binds a parameter. A login can bind `tenant` and `scope.<param>` from its answer with `claims`.
- `security.<scheme>` overrides the base recipe for this principal alone: one naming a kind replaces it (keeping `format` and `placements`); one naming only options merges over it.

Every account the run makes is ledgered before its request goes out, whatever sends it: a `fresh: true` principal, a disposable session, a login recipe whose step calls the operation the document marks `x-fresh-principal`, a scenario, or a check's generated body sent to that operation or to a create of the `identity: self` entity. A principal with `created: true` counts too: it is the opt-in for a login that registers through an operation the document does not mark. The ledger is `accounts.json` in the run folder. It keeps the names each account is found by (email, username, login, handle, phone), never its password, so a run that dies still names what it made.

At the end of a run, each account is removed in this order, each tried only when the one before could not:

1. The document's delete-self (a `DELETE` tagged `x-entity: { identity: self, action: delete }`), sent as the account itself.
2. The delete of the entity the sign-up creates, by the account's id, as each configured principal the run did not make, strongest first.
3. `hooks.teardownPrincipal`, with the account's address and the last credential the run holds for it.

A sign-up the document leaves untagged counts too. That is an open POST (its security is `[]`, or every alternative is empty) whose operationId or last path segment ends with the words register, registration, signup or sign up, as `/auth/admin-sign-up` does. It is also an open collection create whose body takes a `password`, a `passphrase` or a `format: password` property and that is named for no login, token or session, nor for a password reset, forgotten, recovered or changed. oat ledgers what it sends there like any sign-up. With no tag, it has no delete-self to send and cannot sign in as the account, so such an account is usually reported as a leftover: tag the operation `x-fresh-principal` to let oat sign in and remove it.

An account none of these removes is a leftover and fails the run with exit 4, named by its email or username so a person can remove it. An account whose name a configured principal holds, which the run did not make, is never removed, whatever answered its sign-up, so a long-lived test account survives every run. Teardown never sends a sign-up again to get a credential. Generated values for the fields that name an account carry the run's nonce, so two runs never send the same email.

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

## Security recipes

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

## Login steps

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

`path` is joined to this origin's `baseUrl`, unless it is an absolute `http://` or `https://` URL — then oat dispatches to that URL as a recorded exchange (method, URL, status, redirects, response headers). That is how a consume page on the app origin is a login step when `baseUrl` is the API. Unknown host is allowed. `redirect` defaults to `"follow"` with a per-request cookie jar, so a 303 that sets `Set-Cookie` still leaves that cookie visible to `saveAs`. `redirect: "manual"` stops at the first 3xx (`expect: [303]` then bind from that response). An `operationId` step, and every call oat makes on its own, stops at the first 3xx when that operation documents a 3xx: the redirect is the documented answer, and the page behind it is not. A required query, header or cookie parameter the request leaves unnamed is sent with the value the document declares for it, written in its declared style ([Parameters](../model.md#parameters)); with no declared value it is left out, never invented. Naming it, even as `undefined`, keeps it the caller's.

**Out-of-band step** (email link, OTP — oat cannot collect this itself):

```ts
{ outOfBand: { address: "{address}", kind: "email-verify", as: "verifyLink" } }
```

The hook returns a string. If that string is a URL, a later RequestStep must GET it — a hook-side `fetch` is not a recorded exchange.

oat tells the hook when the request this value answers was sent (`since`): the latest earlier request in the flow or scenario that names `address` in its URL or body. A later request to someone else does not move it. When no request names the address, oat passes no `since`. A value sent before the scenario began — by a scheduled job, or into a seeded inbox — sets `sentEarlier: true`, so a sign-in that names the address does not hide it:

```ts
{ outOfBand: { address: "{offerEmail}", as: "offerToken", kind: "upsell-offer", sentEarlier: true } }
```

Later steps interpolate `{name}` from the flow scope, `saveAs` addresses included (`cookie:rt.{userId}` reads a per-user cookie). A name is letters, digits and `_`, with single hyphens between them, as path parameters are written: `{user-id}`. A `{name}` still unfilled when a step is sent, in its path, body, headers or query, fails the step as oat's own error naming the placeholder; it never reaches the backend. `saveAs` addresses:

- `$.foo.bar` / `$.orgs.0.id` — JSON body (dot + numeric index only; no JSON Pointer, no filters)
- `cookie:<name>` — that cookie on `Set-Cookie` for this hop, including followed hops
- `header:<name>` — a non-set-cookie response header, case-insensitive

A login or refresh `from` and its steps' `saveAs`, an `oauth2` grant's tokens, and `expiresIn: { from }` read an answer whose media type is `application/x-www-form-urlencoded` (parameters such as `; charset=utf-8` ignored) as a form: `access_token` or `$.access_token` names a field. Form answers support top-level keys only. Any other answer is read as JSON, never sniffed, and a value it does not hold fails with a reason that names its type. Every value read from a form is a secret before the answer is recorded, as from JSON.

Missing cookie / header / JSON path fails the step closed. Bind `saveAs.refreshToken` from `$.refresh_token` or `cookie:refresh` so `{refreshToken}` interpolates in `refresh`. A `{name}` in a login or refresh step that nothing fills (an earlier `saveAs`, `bind`, `saveClaimsFrom` or out-of-band `as`; for a refresh, also what the login saved and `{credential}`) is a config error naming it; where only the run knows the value, a signup's answer say, the step is refused before it is sent and the principal is BLOCKED for that scheme. `saveClaimsFrom.token` is a JSON path into the response body (`$.access_token`) or a scope key already bound by `saveAs` (`credential`). Signature is not verified — oat is reading its own credential.

`bind` on a step runs **before** the request. `saveAs` then `saveClaimsFrom` run **after**. `from` is read from the last HTTP response unless a step already saved `credential`. `outOfBand.as = "credential"` still wins over `from`.

A login that registers the account it signs in to is torn down only when it calls the `x-fresh-principal` operation or the principal sets `created: true`; see [Principals](#principals).

## Credentials from a hook

When the credential is produced outside oat (a human finishes Google OAuth on a harvest page, a pair lands in KV, a TOTP code), do not make oat drive `authorize` / `callback`. Declare a hook recipe:

```ts
security: { google: { hook: true } },
hooks: {
	resolveCredential: async (scheme, principal) => readHarvested(scheme, principal.id),
},
```

oat calls `hooks.resolveCredential(scheme, { id, identity })` on every acquire, so a renewal calls it again. Return the value, `{ value, expiresIn? }`, or `null`, which blocks that principal for that scheme with the reason in the report. oat does not speak OAuth.
