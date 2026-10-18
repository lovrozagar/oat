import { describe, expect, it } from "vitest"
import { fillPrincipal, MissingIdentityError } from "./interpolate.ts"

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
