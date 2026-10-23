import { describe, expect, it } from "vitest"
import type { Sends } from "../credentials/ports.ts"
import type { Exchange } from "../runtime/exchange.ts"
import { REDACTED, Redactor } from "../security/redact.ts"
import {
	type CredentialRequest,
	type CredentialSource,
	CredentialCollision,
	type Resolution,
	UnsatisfiedSecurity,
} from "./credential-source.ts"
import { createControls } from "./control.ts"
import { NOTHING_PLACED, placeOn, placedNames, requestCredential } from "./placing.ts"

const sends = (more: Partial<Sends>): Sends => ({ cookies: {}, headers: {}, query: {}, ...more })
const secrets = { cookies: ["sid"], headers: ["Authorization"], query: ["key"], values: ["value-one-1"] }

/* A source that answers from a list, in order, and records each request it was asked to resolve. */
function sourceOf(...answers: Resolution[]): CredentialSource & { asked: CredentialRequest[] } {
	const asked: CredentialRequest[] = []
	return {
		asked,
		resolve: async (request) => {
			asked.push(request)
			return answers[Math.min(asked.length - 1, answers.length - 1)] as Resolution
		},
	}
}

function sendingOf(value: string, refreshed: Resolution = { kind: "anonymous" }, blocked: string[] = []): Resolution {
	return {
		block: (reason) => blocked.push(reason),
		kind: "sends",
		principal: "alpha",
		refresh: async () => refreshed,
		schemes: ["jwt"],
		secrets,
		sends: { jwt: sends({ headers: { Authorization: `Bearer ${value}` } }) },
		sentValues: { jwt: value },
	}
}

const R = "GET /rows"

describe("requestCredential: resolving", () => {
	it("asks the source for the actor, the operation and whether it is a probe, on every attempt", async () => {
		const source = sourceOf({ kind: "anonymous" })
		const wire = { credentials: source, controls: createControls(), redactor: new Redactor() }
		const credential = requestCredential(wire, {
			route: R,
			actor: { anonymous: true },
			operationId: "row.list",
			probe: true,
		})
		expect(await credential.next()).toEqual(NOTHING_PLACED)
		await credential.next()
		const unnamed = requestCredential(wire, { route: R, actor: { principal: "alpha" } })
		await unnamed.next()
		expect(source.asked).toEqual([
			{ route: R, actor: { anonymous: true }, operationId: "row.list", probe: true },
			{ route: R, actor: { anonymous: true }, operationId: "row.list", probe: true },
			{ route: R, actor: { principal: "alpha" }, probe: false },
		])
	})

	it("places nothing for an anonymous actor without a source, and refuses any other", async () => {
		const wire = { credentials: undefined, controls: createControls(), redactor: new Redactor() }
		expect(await requestCredential(wire, { route: R, actor: { anonymous: true } }).next()).toEqual(NOTHING_PLACED)
		const alpha = requestCredential(wire, { route: R, actor: { principal: "alpha" } })
		await expect(alpha.next()).rejects.toEqual(
			new UnsatisfiedSecurity("unsatisfied", "this client holds no credentials"),
		)
	})

	it("names the acting principal when its operation sends nothing, so the exchange is still theirs", async () => {
		const wire = { credentials: sourceOf({ kind: "anonymous" }), controls: createControls(), redactor: new Redactor() }
		const own = { forged: false, principal: "alpha", schemes: [], sends: {} }
		expect(await requestCredential(wire, { route: R, actor: { principal: "alpha" } }).next()).toEqual(own)
		const via = { principal: "alpha", via: { operationId: "row.list" } as Exchange }
		expect(await requestCredential(wire, { route: R, actor: via }).next()).toEqual(own)
		expect(await requestCredential(wire, { route: R, actor: { anonymous: true } }).next()).toEqual(NOTHING_PLACED)
	})

	it("raises an unsatisfied or blocked resolution before anything is placed", async () => {
		const unsatisfied = sourceOf({ kind: "unsatisfied", reason: "no credential for jwt" })
		const wire = { credentials: unsatisfied, controls: createControls(), redactor: new Redactor() }
		const error = await requestCredential(wire, { route: R, actor: { principal: "alpha" } })
			.next()
			.catch((caught: unknown) => caught)
		expect(error).toMatchObject({ kind: "unsatisfied", name: "UnsatisfiedSecurity", reason: "no credential for jwt" })
		const blocked = {
			credentials: sourceOf({ kind: "blocked", reason: "login failed" }),
			controls: createControls(),
			redactor: new Redactor(),
		}
		await expect(requestCredential(blocked, { route: R, actor: { principal: "alpha" } }).next()).rejects.toMatchObject({
			kind: "blocked",
			message: "login failed",
		})
	})
})

describe("requestCredential: redaction", () => {
	it("registers every name and value a principal's credential places, and none of a forged one's", async () => {
		const redactor = new Redactor()
		const credential = requestCredential(
			{ controls: createControls(), credentials: sourceOf(sendingOf("value-one-1")), redactor },
			{
				actor: { principal: "alpha" },
				route: R,
			},
		)
		expect(await credential.next()).toMatchObject({ forged: false, principal: "alpha", schemes: ["jwt"] })
		expect(redactor.text("sid=s; value-one-1")).toBe(`sid=${REDACTED}; ${REDACTED}`)
		expect(redactor.url("https://x.test/?key=k")).not.toContain("=k")
		expect(redactor.isSecretHeader("Authorization")).toBe(true)
		const forged: Resolution = { kind: "forged", schemes: ["key"], sends: { key: sends({ query: { k: "forged-1" } }) } }
		const quiet = new Redactor()
		const probe = requestCredential(
			{ controls: createControls(), credentials: sourceOf(forged), redactor: quiet },
			{
				actor: { forged: { scheme: "key", value: "forged-1" } },
				route: R,
			},
		)
		expect(await probe.next()).toEqual({ forged: true, schemes: ["key"], sends: forged.sends })
		expect(quiet.url("https://x.test/?k=forged-1")).toBe("https://x.test/?k=forged-1")
	})

	it("registers what a derived forged value places, since it comes from a real credential", async () => {
		const redactor = new Redactor()
		const derived: Resolution = {
			kind: "forged",
			schemes: ["key"],
			secrets: { cookies: [], headers: [], query: ["k"], values: ["derived-1"] },
			sends: { key: sends({ query: { k: "derived-1" } }) },
		}
		const probe = requestCredential(
			{ controls: createControls(), credentials: sourceOf(derived), redactor },
			{ actor: { forged: { derived: true, scheme: "key", value: "derived-1" } }, route: R },
		)
		expect(await probe.next()).toMatchObject({ forged: true })
		expect(redactor.url("https://x.test/?k=derived-1")).not.toContain("derived-1")
	})
})

describe("requestCredential: a held value", () => {
	it("places it as the principal's, registers its secrets, and never renews it", async () => {
		const redactor = new Redactor()
		const held: Resolution = {
			kind: "held",
			principal: "alpha",
			schemes: ["jwt"],
			secrets,
			sends: { jwt: sends({ headers: { Authorization: "Bearer value-one-1" } }) },
		}
		const credential = requestCredential(
			{ controls: createControls(), credentials: sourceOf(held), redactor },
			{ actor: { principal: "alpha", scheme: "jwt", value: "value-one-1" }, route: R },
		)
		expect(await credential.next()).toEqual({ forged: false, principal: "alpha", schemes: ["jwt"], sends: held.sends })
		expect(redactor.text("value-one-1")).toBe(REDACTED)
		expect(await credential.renew()).toBe(false)
	})
})

describe("requestCredential: renewing after a 401", () => {
	it("renews what the last attempt sent once per request, and sends the renewal next", async () => {
		const source = sourceOf(sendingOf("v1", sendingOf("v2")))
		const credential = requestCredential(
			{ credentials: source, controls: createControls(), redactor: new Redactor() },
			{
				actor: { principal: "alpha" },
				route: R,
			},
		)
		expect(await credential.renew()).toBe(false)
		await credential.next()
		expect(await credential.renew()).toBe(true)
		expect((await credential.next()).sends).toEqual({ jwt: sends({ headers: { Authorization: "Bearer v2" } }) })
		expect(await credential.renew()).toBe(false)
		expect(source.asked).toHaveLength(1)
		expect((await credential.next()).sends.jwt?.headers).toEqual({ Authorization: "Bearer v1" })
	})

	it("sends nothing more once the store blocked the renewal: the refusal stands", async () => {
		const blocked: Resolution = { kind: "blocked", reason: "could not refresh" }
		const credential = requestCredential(
			{ credentials: sourceOf(sendingOf("v1", blocked)), controls: createControls(), redactor: new Redactor() },
			{
				actor: { principal: "alpha" },
				route: R,
			},
		)
		await credential.next()
		expect(await credential.renew()).toBe(false)
		expect(await credential.renew()).toBe(false)
	})

	it("never renews a probe, a forged value or nothing", async () => {
		const wire = { credentials: sourceOf(sendingOf("v1")), controls: createControls(), redactor: new Redactor() }
		const probe = requestCredential(wire, { route: R, actor: { principal: "alpha" }, probe: true })
		await probe.next()
		expect(await probe.renew()).toBe(false)
		const forged: Resolution = { kind: "forged", schemes: ["jwt"], sends: {} }
		const forging = requestCredential(
			{ credentials: sourceOf(forged), controls: createControls(), redactor: new Redactor() },
			{
				actor: { forged: { scheme: "jwt", value: "f" } },
				route: R,
			},
		)
		await forging.next()
		expect(await forging.renew()).toBe(false)
		const anonymous = requestCredential(
			{ credentials: sourceOf({ kind: "anonymous" }), controls: createControls(), redactor: new Redactor() },
			{
				actor: { principal: "alpha" },
				route: R,
			},
		)
		await anonymous.next()
		expect(await anonymous.renew()).toBe(false)
	})
})

const placement = {
	forged: false,
	principal: "alpha",
	schemes: ["jwt", "key", "session"],
	sends: {
		jwt: sends({ headers: { Authorization: "Bearer t" } }),
		key: sends({ query: { key: "k1" } }),
		session: sends({ cookies: { sid: "s1" } }),
	},
}

/* A credential over a source sending v1, whose renewal is `refreshed`, and its controls. */
const controlled = (refreshed: Resolution) => {
	const controls = createControls()
	const credential = requestCredential(
		{ controls, credentials: sourceOf(sendingOf("v1", refreshed)), redactor: new Redactor() },
		{ actor: { principal: "alpha" }, route: R },
	)
	return { controls, credential }
}

describe("requestCredential: a renewal refused too", () => {
	const read = { method: "GET", operationId: "profile.get", options: { as: { principal: "alpha" } }, path: "/me" }
	const accepted = { method: "GET", principal: "alpha", schemes: ["jwt"], status: 200 } as Exchange

	it("sends the control with the renewal, and blocks by the renewal when the control is refused too", async () => {
		const blocked: string[] = []
		const { controls, credential } = controlled(sendingOf("v2", { kind: "anonymous" }, blocked))
		controls.note(accepted, read)
		await credential.next()
		await credential.refused(() => Promise.reject(new Error("not renewed yet: no control")))
		expect(await credential.renew()).toBe(true)
		await credential.next()
		const sentControls: string[] = []
		await credential.refused(async (control) => (sentControls.push(control.path), { status: 401 }) as Exchange)
		expect(sentControls).toEqual(["/me"])
		expect(blocked).toEqual([
			"signed in again, and the new credential is refused where the old one was accepted (profile.get)",
		])
	})

	it("never renews a value a renewal issued: its refusal goes to the control", async () => {
		const { controls, credential } = controlled(sendingOf("v2"))
		controls.renewed({ block: () => undefined, principal: "alpha", sentValues: { jwt: "v1" } })
		controls.note(accepted, read)
		await credential.next()
		expect(await credential.renew()).toBe(false)
		const sentControls: string[] = []
		await credential.refused(async (control) => (sentControls.push(control.path), { status: 200 }) as Exchange)
		expect(sentControls).toEqual(["/me"])
	})
})

describe("placeOn", () => {
	it("puts the header in, the query on a copy of the URL, and the cookie beside the caller's", () => {
		const url = new URL("http://api.test/v1/rows?page=2")
		const placed = placeOn(placement, {
			callerQuery: new Set(["page"]),
			layers: [{ g: "1" }, {}, { Cookie: "pref=dark" }],
			url,
		})
		expect(placed.url.toString()).toBe("http://api.test/v1/rows?page=2&key=k1")
		expect(url.toString()).toBe("http://api.test/v1/rows?page=2")
		expect(placed.headers).toEqual({ Authorization: "Bearer t", Cookie: "pref=dark; sid=s1", g: "1" })
		const header = { ...placement, schemes: ["jwt"], sends: { jwt: placement.sends.jwt } }
		expect(placeOn(header, { callerQuery: new Set(), layers: [{ cookie: "a=1" }], url }).headers).toEqual({
			Authorization: "Bearer t",
			cookie: "a=1",
		})
		const bare = placeOn(placement, { callerQuery: new Set(), layers: [], url })
		expect(bare.headers).toEqual({ Authorization: "Bearer t", cookie: "sid=s1" })
		expect(placeOn(NOTHING_PLACED, { callerQuery: new Set(), layers: [{ a: "1" }, { a: "2" }], url })).toEqual({
			headers: { a: "2" },
			url,
		})
	})

	it("refuses a global, hook or caller header under a placed name, in any case", () => {
		const url = new URL("http://api.test/v1/rows")
		for (const layers of [[{ authorization: "x" }], [{}, { AUTHORIZATION: "x" }], [{}, {}, { Authorization: "x" }]]) {
			expect(() => placeOn(placement, { callerQuery: new Set(), layers, url })).toThrow(
				new CredentialCollision("header", { name: Object.keys(layers.at(-1) as object)[0] as string, scheme: "jwt" }),
			)
		}
		expect(() => placeOn(placement, { callerQuery: new Set(), layers: [{}, {}, { Authorization: "x" }], url })).toThrow(
			'header "Authorization" collides with the jwt credential placement',
		)
	})

	it("adds a query credential without writing the query it joins in another encoding", () => {
		const url = new URL("http://api.test/v1/rows?q=a%20b&path=/x:y")
		const placed = placeOn(placement, { callerQuery: new Set(["q", "path"]), layers: [], url })
		expect(placed.url.search).toBe("?q=a%20b&path=/x:y&key=k1")
		const odd = { ...placement, sends: { ...placement.sends, key: sends({ query: { "k y": "a&b c" } }) } }
		expect(placeOn(odd, { callerQuery: new Set(), layers: [], url: new URL("http://api.test/r") }).url.search).toBe(
			"?k%20y=a%26b%20c",
		)
	})

	it("refuses a caller's query parameter or cookie under a placed name", () => {
		const url = new URL("http://api.test/v1/rows?key=mine")
		expect(() => placeOn(placement, { callerQuery: new Set(["key"]), layers: [], url })).toThrow(
			'query "key" collides with the key credential placement',
		)
		const cookie = [{ cookie: "pref=dark;  sid=mine" }]
		expect(() => placeOn(placement, { callerQuery: new Set(), layers: cookie, url })).toThrow(
			'cookie "sid" collides with the session credential placement',
		)
	})
})

describe("placedNames", () => {
	it("names the headers and query parameters a cross-origin hop strips", () => {
		expect(placedNames(placement)).toEqual({ headers: ["Authorization"], query: new Set(["key"]) })
		expect(placedNames(NOTHING_PLACED)).toEqual({ headers: [], query: new Set() })
	})
})

/*
 * doctor and plan read an unset env() as its `${NAME}` literal. A run never defers, so such a value
 * reaching a request is a bug in that rule: the client refuses to send it rather than send the name.
 */
/* A client's wire whose source always answers `resolution`. */
const wireOf = (resolution: Resolution) => ({
	controls: createControls(),
	credentials: sourceOf(resolution),
	redactor: new Redactor(),
})

describe("requestCredential: a deferred env literal", () => {
	it("throws rather than send a ${NAME} literal as a credential, alone or in a basic pair", async () => {
		const token = { ...sendingOf("${OAT_JWT_TOKEN}") }
		await expect(requestCredential(wireOf(token), { actor: { principal: "alpha" }, route: R }).next()).rejects.toThrow(
			"oat: the jwt credential is the unset variable ${OAT_JWT_TOKEN}; a run never defers env, so this is a bug",
		)
		const pair = { ...sendingOf("x"), sentValues: { basic: "${OAT_USER}:${OAT_PASS}" } }
		await expect(requestCredential(wireOf(pair), { actor: { principal: "alpha" }, route: R }).next()).rejects.toThrow(
			"the basic credential is the unset variable ${OAT_USER}",
		)
	})

	it("sends a value that only contains such a pattern among other text", async () => {
		const near = sendingOf("a${OAT_JWT_TOKEN}")
		const placed = await requestCredential(wireOf(near), { actor: { principal: "alpha" }, route: R }).next()
		expect(placed.schemes).toEqual(["jwt"])
		const lower = sendingOf("${lower}")
		expect((await requestCredential(wireOf(lower), { actor: { principal: "alpha" }, route: R }).next()).forged).toBe(
			false,
		)
	})
})
