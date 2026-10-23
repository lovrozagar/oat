import { describe, expect, it } from "vitest"
import { fillCredential, fillPrincipal, MissingIdentityError, principalValues } from "./interpolate.ts"

const principal = { id: "ann", identity: { age: 30, email: "ann@x.io", verified: true } }

describe("fillPrincipal", () => {
	it("fills `{principal.<key>}` in strings, deep in arrays and objects", () => {
		expect(
			fillPrincipal(principal, {
				body: { email: "{principal.email}", tags: ["{principal.age}", 1, null, "{principal.verified}"] },
				path: "/users/{principal.email}/{id}",
			}),
		).toEqual({ body: { email: "ann@x.io", tags: ["30", 1, null, "true"] }, path: "/users/ann@x.io/{id}" })
	})

	it("fills `{principal.id}` with the principal's id unless its identity names one", () => {
		expect(fillPrincipal(principal, "{principal.id}")).toBe("ann")
		expect(fillPrincipal({ id: "ann", identity: { id: "u-1" } }, "{principal.id}")).toBe("u-1")
	})

	it("refuses a key the principal does not carry, or carries as structured data", () => {
		const nested = { id: "ann", identity: { org: { id: 1 } } }
		expect(() => fillPrincipal(principal, ["{principal.password}"])).toThrow(MissingIdentityError)
		expect(() => fillPrincipal(nested, "{principal.org}")).toThrow(
			'principal "ann" has no text value for {principal.org}',
		)
	})
})

describe("principalValues", () => {
	it("lists each identity value a `{principal.<key>}` fills, once, deep in arrays and objects", () => {
		const sent = { body: { email: "{principal.email}", tags: ["{principal.age}", 1, null, "to {principal.email}"] } }
		expect(principalValues(principal, sent)).toEqual(["ann@x.io", "30"])
	})

	it("leaves out the id `{principal.id}` falls back to, a name every report prints, and keys it lacks", () => {
		expect(principalValues(principal, ["{principal.id}", "{principal.org}"])).toEqual([])
		expect(principalValues({ id: "ann", identity: { id: "u-100" } }, "{principal.id}")).toEqual(["u-100"])
	})
})

describe("fillCredential", () => {
	it("puts the credential wherever {credential} stands, deep through arrays and objects", () => {
		expect(fillCredential({ list: ["{credential}", 2], token: "{credential}", why: "end {credential}" }, "t1")).toEqual(
			{
				list: ["t1", 2],
				token: "t1",
				why: "end t1",
			},
		)
		expect(fillCredential(null, "t1")).toBeNull()
	})
})
