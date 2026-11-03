import { describe, expect, expectTypeOf, it } from "vitest"
import type { Scenario } from "../config/types/steps.ts"
import { steps } from "./steps.ts"

/* A caller's types, as a config derives them from its SDK. Type aliases, not interfaces: an
 * interface is not assignable to the index signature `OpMap` declares. */
type Ops = {
	"auth.reauthenticate": {
		body: { password: string; two_factor_code?: string }
		errors: { 403: "account_reauth_failed" }
	}
	"auth.deleteAccount": { errors: { 403: "account_reauth_required" | "forbidden"; 401: "unauthorized" } }
	"org.delete": { bind: { organization_id: string } }
	"table.export": { bind: { project_id: string }; query: { format: "csv" | "json" } }
	"billing.charge": { body: { amount: number; currency: "eur" | "usd"; items: { sku: string }[] } }
}
type Cdn = {
	"cdn.upload": { bind: { wildcard: string }; body: Uint8Array }
	"cdn.head": { bind: { wildcard: string } }
}
type Types = {
	ops: Ops
	origins: { cdn: Cdn }
	externals: { totp: { secret: string }; consent: undefined }
	mail: "magic-link" | "otp"
}

/* How a session held in the scope is sent is the config's to say: here, a bearer token. */
const b = steps<Types>({ session: (name) => ({ authorization: `Bearer {${name}}` }) })

/* Never run: `bun run check` proves each line is a compile error. */
function rejectedAtCompile(): void {
	// @ts-expect-error an operation id the document lacks
	b.self.call("auth.deleteAcount")
	// @ts-expect-error a body field the operation lacks
	b.self.call("auth.reauthenticate", { body: { pasword: "x" } })
	// @ts-expect-error a path parameter the route lacks
	b.self.call("org.delete", { bind: { org_id: "x" } })
	// @ts-expect-error a body on an operation that takes none, unless unchecked
	b.self.call("org.delete", { body: { a: 1 } })
	// @ts-expect-error an error key the status does not declare
	b.self.refused("auth.deleteAccount", { key: "account_reauth_requird", status: 403 })
	// @ts-expect-error a status the operation declares no error keys for
	b.self.refused("auth.deleteAccount", { key: "forbidden", status: 404 })
	// @ts-expect-error an error key declared under another status
	b.self.refused("auth.deleteAccount", { key: "unauthorized", status: 403 })
	// @ts-expect-error a cdn operation on the main document's sender
	b.self.call("cdn.upload")
	// @ts-expect-error an origin the config does not name
	b.origin("img")
	// @ts-expect-error an external input key the registry does not declare
	b.external("totp", { secrt: "x" })
	// @ts-expect-error an external that takes input, given none
	b.external("totp")
	// @ts-expect-error a mail kind the inbox does not answer
	b.mail("magic-lnk", "{address}")
	// @ts-expect-error an observed operation the document lacks
	b.self.call("org.delete").equals("$.a", "1").observes("org.delet")
	// @ts-expect-error a covered operation the document lacks
	b.scenario({ covers: ["org.delet"], id: "x", steps: [] })
}

describe("steps", () => {
	it("holds exactly the builders a scenario is written with", () => {
		expect(Object.keys(b).toSorted()).toEqual(
			["anon", "external", "mail", "origin", "principal", "scenario", "self", "session", "unchecked"].toSorted(),
		)
	})

	it("sends each sender's steps as its identity", () => {
		expect(b.self.call("auth.deleteAccount").toStep()).toStrictEqual({ operationId: "auth.deleteAccount" })
		expect(b.anon.call("auth.deleteAccount").toStep()).toStrictEqual({
			anonymous: true,
			operationId: "auth.deleteAccount",
		})
		expect(b.session("rotated").call("auth.deleteAccount").toStep()).toStrictEqual({
			anonymous: true,
			headers: { authorization: "Bearer {rotated}" },
			operationId: "auth.deleteAccount",
		})
		expect(b.principal("beta").call("auth.deleteAccount").toStep()).toStrictEqual({
			operationId: "auth.deleteAccount",
			principal: "beta",
		})
		expect(
			b
				.origin("cdn")
				.call("cdn.head", { bind: { wildcard: "o/1" } })
				.toStep(),
		).toStrictEqual({
			bind: { wildcard: "o/1" },
			operationId: "cdn.head",
			origin: "cdn",
		})
	})

	it("refuses a session when the config never said how one is sent", () => {
		expect(() => steps<Types>().session("rotated")).toThrow(
			"session(name) needs steps({ session }), the headers a session held in the scope is sent with",
		)
	})
})

describe("steps beyond requests", () => {
	it("builds mail and external steps", () => {
		expect(b.mail("otp", "{address}").as("code").toStep()).toStrictEqual({
			outOfBand: { address: "{address}", as: "code", kind: "otp" },
		})
		expect(b.external("totp", { secret: "{s}" }).as("c").toStep()).toStrictEqual({
			as: "c",
			external: "totp",
			input: { secret: "{s}" },
		})
		expect(b.external("consent").as("ok").toStep()).toStrictEqual({ as: "ok", external: "consent" })
		expect(b.unchecked(1)).toBe(1)
	})

	it("stamps the origin on a scenario of an origin's own set, and on none of its steps", () => {
		const cdn = steps<{ ops: Cdn }>({ origin: "cdn" })
		const files = cdn.scenario({
			covers: ["cdn.upload"],
			id: "cdn-files",
			steps: [cdn.self.call("cdn.upload", { bind: { wildcard: "o/1" }, body: Uint8Array.of(1) })],
		})
		expect(files).toStrictEqual({
			covers: ["cdn.upload"],
			id: "cdn-files",
			origin: "cdn",
			steps: [{ bind: { wildcard: "o/1" }, body: Uint8Array.of(1), operationId: "cdn.upload" }],
		})
		expect(b.scenario({ covers: [], id: "main", steps: [] })).toStrictEqual({ covers: [], id: "main", steps: [] })
	})
})

describe("steps types", () => {
	it("types every name a scenario writes against the caller's maps", () => {
		expectTypeOf(b.scenario).returns.toEqualTypeOf<Scenario>()
		/* Placeholders fill any scalar, at any depth. */
		b.self.call("billing.charge", { body: { amount: "{amt}", currency: "{cur}", items: [{ sku: "{sku}" }] } })
		b.self.call("table.export", { bind: { project_id: "{pid}" }, query: { format: "csv" } })
		b.self.refused("auth.deleteAccount", { key: "account_reauth_required", status: 403 })
		b.self.refused("auth.reauthenticate", { body: { password: "x" }, key: "account_reauth_failed", status: 403 })
		b.self
			.call("auth.reauthenticate", { body: { password: "x" } })
			.atLeast("$.until", 1)
			.observes("auth.deleteAccount")
		b.self.call("org.delete", { body: b.unchecked({ anything: true }) })
	})

	it("fails to compile each name the caller's maps lack", () => {
		expect(rejectedAtCompile).toBeTypeOf("function")
	})
})
