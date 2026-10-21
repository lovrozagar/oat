import { describe, expect, it } from "vitest"
import { undeliverable } from "./undeliverable.ts"

const NOWHERE = "oat-nonexistent-n0@example.invalid"

describe("undeliverable", () => {
	it("gives every email-format value an identity no account holds, and every URL-format one an .invalid host", () => {
		const schema = {
			properties: {
				backup: { format: "idn-email", type: "string" },
				email: { format: "email", type: "string" },
				hook: { format: "uri", type: "string" },
				link: { format: "iri-reference", type: "string" },
				name: { type: "string" },
				site: { format: "url", type: "string" },
			},
			type: "object",
		}
		const body = { backup: "b@x.com", email: "a@x.com", hook: "https://x.com", link: "/a", name: "n", site: "x.com" }
		expect(undeliverable(body, schema, "n0")).toEqual({
			backup: NOWHERE,
			email: NOWHERE,
			hook: "https://oat-nonexistent-n0.invalid/",
			link: "https://oat-nonexistent-n0.invalid/",
			name: "n",
			site: "https://oat-nonexistent-n0.invalid/",
		})
	})

	it("reaches into arrays and nested objects, and leaves out nothing the body did not hold", () => {
		const schema = {
			properties: {
				contacts: { items: { format: "email" }, type: "array" },
				owner: { properties: { email: { format: "email" } }, type: "object" },
				unused: { format: "email" },
			},
		}
		expect(undeliverable({ contacts: ["a@x.com", "b@x.com"], owner: { email: "o@x.com" } }, schema, "n0")).toEqual({
			contacts: [NOWHERE, NOWHERE],
			owner: { email: NOWHERE },
		})
	})

	it("keeps a value whose type is not the format's: an invalid body stays invalid", () => {
		const schema = { properties: { email: { format: "email", type: "string" } } }
		expect(undeliverable({ email: 7 }, schema, "n0")).toEqual({ email: 7 })
	})

	it("passes through what the schema says nothing about", () => {
		expect(undeliverable({ a: 1 }, true, "n0")).toEqual({ a: 1 })
		expect(undeliverable("text", { format: "date" }, "n0")).toBe("text")
		expect(undeliverable(["x"], { type: "array" }, "n0")).toEqual(["x"])
		expect(undeliverable({ a: "b@x.com" }, { properties: null }, "n0")).toEqual({ a: "b@x.com" })
	})
})
