import { describe, expect, it } from "vitest"
import { nonexistentIdentity } from "./nonexistent-identity.ts"

describe("nonexistentIdentity", () => {
	it("is an RFC 2606 .invalid address for an email field, by format or by name", () => {
		expect(nonexistentIdentity({ name: "login", schema: { format: "email", type: "string" } }, "n1")).toBe(
			"oat-nonexistent-n1@example.invalid",
		)
		expect(nonexistentIdentity({ name: "userEmail", schema: undefined }, "n1")).toBe(
			"oat-nonexistent-n1@example.invalid",
		)
		expect(nonexistentIdentity({ name: "e-mail", schema: { type: "string" } }, "n1")).toBe(
			"oat-nonexistent-n1@example.invalid",
		)
	})

	it("is a marked name for any other field", () => {
		expect(nonexistentIdentity({ name: "username", schema: { type: "string" } }, "n1")).toBe("oat-nonexistent-n1")
		expect(nonexistentIdentity({ name: "password", schema: undefined }, "n1")).toBe("oat-nonexistent-n1")
	})
})
