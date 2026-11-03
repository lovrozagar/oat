# oat — Step builders

[← back to the overview](../README.md)

`@lovrozagar/oat/steps` writes [scenario](configuration/reference.md) steps as typed calls instead of
object literals. You give it your API's types once. After that, a scenario that names an operation,
a body field, a path parameter, an error key, an external or a mail kind your API lacks fails at
`tsc`, before anything is sent. Each builder emits the plain step object a hand-written config
holds, so oat runs a built scenario exactly as it runs the literal.

```ts
import { steps } from "@lovrozagar/oat/steps"

/* Where a credential goes is your API's to say: here, a session is a bearer token. */
const { anon, scenario, self, session } = steps<MyTypes>({ session: (name) => ({ authorization: `Bearer {${name}}` }) })
const rotated = session("rotated")

export const reauth = scenario({
	id: "reauth",
	covers: ["auth.reauthenticate", "auth.deleteAccount"],
	steps: [
		self.refused("auth.deleteAccount", { status: 403, key: "account_reauth_required" }),
		self
			.call("auth.reauthenticate", { body: { password: "{password}" } })
			.atLeast("$.reauthenticated_until", Date.now()),
		anon.call("auth.refreshToken", { body: { refresh_token: "{refreshToken}" } }).save({ rotated: "$.access_token" }),
		rotated.call("auth.deleteAccount").status(204),
	],
})
```

The second step is the literal
`{ operationId: "auth.reauthenticate", body: { password: "{password}" }, assert: { from: "$.reauthenticated_until", atLeast: … } }`.

## Your types

`steps<T>()` is typed over one `StepTypes`. Only `ops` is required. Write each map as a `type`
alias, not an `interface`: an interface does not satisfy the index signature `OpMap` declares.

```ts
type MyTypes = {
	/* Operation id → its OpShape: body, bind (path parameters), query, and error keys per status. */
	ops: {
		"auth.reauthenticate": { body: { password: string }; errors: { 403: "account_reauth_failed" } }
		"org.delete": { bind: { organization_id: string } }
	}
	/* A configured origins[] name → that origin's operations. */
	origins: { cdn: { "cdn.upload": { bind: { wildcard: string }; body: Uint8Array } } }
	/* External name → its input; derive it from your registry with ExternalInputs. */
	externals: ExternalInputs<typeof EXTERNALS>
	/* The kinds hooks.resolveOutOfBand answers. */
	mail: "magic-link" | "otp"
}
```

`steps<T>(options?)` takes `StepsOptions`: `session`, the headers a session held in the scope as
`{name}` is sent with (without it, `session(name)` throws), and `origin` (see below).

An `OpShape` part you leave out takes nothing: an operation with no `body` accepts only an
`unchecked(...)` one, and one with no `bind` accepts no path parameter. `Fillable<T>` lets every
scalar in a body also take a `Placeholder`, a text holding a `{name}`, so `amount: "{amt}"` passes
where `amount` is a number. Bytes pass as they are.

## The builder set

`steps<T>()` returns a `Builders<T>` with these names:

| builder                                                | emits                                                                         |
| ------------------------------------------------------ | ----------------------------------------------------------------------------- |
| `self`                                                 | the scenario principal's own step (no identity keys)                          |
| `anon`                                                 | `anonymous: true`                                                             |
| `session(name)`                                        | `anonymous: true` and the headers `StepsOptions.session(name)` gives          |
| `principal(name)`                                      | `principal: name`                                                             |
| `origin(name)`                                         | `self`'s step with `origin: name`, typed over that origin's operations        |
| `mail(kind, address).as(name)`                         | `outOfBand: { kind, address, as }`; `.sentEarlier()` adds `sentEarlier: true` |
| `external(name, input?).as(name)`                      | `external`, `input` (left out when the external takes none), `as`             |
| `scenario({ id, covers, steps, principal?, origin? })` | the plain `Scenario`                                                          |
| `unchecked(value)`                                     | the value itself, typed `V & Unchecked` past the body check                   |

Each sender is a `Sender` with:

- `call(op, init?)`: `operationId` plus the `CallInit` parts given (`body`, `bind`, `query`,
  `headers`, `mediaType`). A session's headers merge under the call's, the call winning per key.
- `refused(op, { status, key, ...init })`: the call, `expect: [status]`, and
  `assert: { equals: key, from: "$.error_key" }`. `key` must be one the operation declares for
  that `status`. Its type is `Refusal`.
- `request(method, path, init?)`: a raw request; `RawInit` takes `body`, `headers`, `query` and
  `redirect`.
- `on(origin)`: the same sender with `origin` on every step it builds.

A call returns a `RequestBuilder`. Each chain call returns a new builder, so a builder shared by two
chains stays as it was:

| chain                                                        | writes                                                               |
| ------------------------------------------------------------ | -------------------------------------------------------------------- |
| `.save({ name: "$.path" })`                                  | `saveAs`, merged across calls                                        |
| `.claims(token, bind)`                                       | `saveClaimsFrom`                                                     |
| `.status(...codes)`                                          | `expect`                                                             |
| `.equals` / `.contains` / `.excludes` / `.omits(from, text)` | one assert each                                                      |
| `.atLeast(from, floor)`                                      | an assert with a number floor                                        |
| `.observes(...ops)`                                          | `observes` on the assert just before it; with no ops, `observes: []` |
| `.poll(within, everyMs?)`                                    | `poll`                                                               |
| `.scheme(name)`                                              | `scheme`                                                             |

One assert is written as an object and several as an array, as in a hand-written step. No
emitted object holds an own `undefined` key.

A builder is a `BuiltStep`. A scenario's steps are `StepItem`s, which are builders or plain steps,
so a sign-up flow's own steps mix in. `ScenarioInit` types `covers` over the document's
operations: it stays an explicit list, because a scenario grades only what it covers.

### A scenario that belongs to an origin

A scenario whose whole flow runs on one configured origin uses that origin's own set:

```ts
const cdn = steps<{ ops: CdnOps }>({ origin: "cdn" })
cdn.scenario({ id: "cdn-files", covers: ["cdn.upload"], steps: [cdn.self.call("cdn.upload", { … })] })
```

Its `scenario` writes `origin: "cdn"` on the scenario and none on the steps. A step's own `origin`
makes it a support call to another origin, which never counts toward `covers`. That is why
`origin(name)` and an origin's set are not the same thing.

## Externals

`defineExternals<Ctx, Meta>()(entries)` declares the externals your `hooks.external` answers, one
`ExternalEntry` each: your `Meta` fields (a `kind`, say) and `resolve(input, ctx)`. It returns the
entries unchanged, so the hook calls `entries[name].resolve(input, ctx)`, and
`ExternalInputs<typeof entries>` gives the scenario side each input type.

```ts
const EXTERNALS = defineExternals<{ stripe: Stripe }, { kind: "computed" | "api" }>()({
	totp: { kind: "computed", resolve: (input: { secret: string }) => nextTotp(input.secret) },
})
```

`ExternalDraft`, `MailDraft` and `MailStep` are the types of the drafts and steps those builders return.

## Testing scenarios

`stepsOf(scenarios, id)` returns a `ScenarioView` of one scenario for its unit tests:

```ts
const arm = stepsOf(scenarios(fakeRun), "offer-arm")
expect(arm.indexOf("auth.updateNotificationPreferences", { body: { marketing: true } })).toBeLessThan(
	arm.indexOf("domain.list"),
)
expect(stepsOf(scenarios(fakeRun), "account").observes("auth.logout")).toBe(true)
```

- `indexOf(op, where?)`: the first call of `op` whose fields include `where`, deep, with arrays
  matched item by item. It returns -1 when no call does.
- `calls(op)`: every call with its index.
- `asserts()`: every assert, flattened.
- `observes(op)`: true when the scenario covers `op`, calls it, and a later assert names it.

An unknown id throws and names the ids there are.
