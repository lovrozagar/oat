# oat — Hooks

[← back to the overview](../../README.md)

## Hooks

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

Without `teardownPrincipal`, an account no delete removes is reported as a leftover rather than cascade-deleted. Per-record DELETE still runs for seeded rows when a delete (or `x-cleanup`) exists. The hook is called with the last live credential (`ctx.credential`, and `ctx.sends`: its headers, query and cookies as the scheme places them), not an already-cleared one, so authenticated delete-account is expressible without a tester-key god route. One-argument JavaScript callbacks still run.

### Proving a record gone

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

`resolveCredential` is documented under [Credentials from a hook](principals-and-security.md#credentials-from-a-hook); `awaitSideEffect` with `x-wait`.

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

## Request fence

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
