import { describe, expect, it } from "vitest"
import { formatted, uuidFrom } from "./format.ts"
import type { Context, Variant } from "./types.ts"

const ctx = (variant: Variant, index = 13, nonce: string | null = "n0"): Context => ({
	defs: {},
	depth: 0,
	distinct: new Set(),
	index,
	nonce: nonce ?? undefined,
	optional: "all",
	rand: () => 0.5,
	refs: [],
	variant,
})

describe("uuidFrom", () => {
	it("is a v4-shaped UUID, the same for the same salt", () => {
		const one = uuidFrom("salt")
		expect(one).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
		expect(uuidFrom("salt")).toBe(one)
		expect(uuidFrom("other")).not.toBe(one)
	})
})

describe("formatted", () => {
	it("dates and times by variant: the earliest, the latest, or one per index", () => {
		expect(formatted("date", ctx("baseline"), false)).toBe("2024-02-14")
		expect(formatted("date", ctx("lexical-first"), false)).toBe("2000-01-01")
		expect(formatted("date", ctx("boundary"), false)).toBe("2000-01-01")
		expect(formatted("date", ctx("lexical-last"), false)).toBe("2099-12-28")
		expect(formatted("date-time", ctx("baseline"), false)).toBe("2024-02-14T11:31:00Z")
		expect(formatted("time", ctx("baseline", 0), false)).toBe("10:00:00Z")
	})

	it("addresses, hosts and URLs carry the nonce only when distinct", () => {
		expect(formatted("email", ctx("null-heavy"), false)).toBe("oat-null-heavy-13@example.test")
		expect(formatted("idn-email", ctx("baseline"), true)).toBe("oat-baseline-13-n0@example.test")
		expect(formatted("email", ctx("baseline", 13, null), true)).toBe("oat-baseline-13@example.test")
		for (const format of ["uri", "url", "iri", "uri-reference", "iri-reference"]) {
			expect(formatted(format, ctx("baseline"), true)).toBe("https://example.test/baseline-13-n0")
		}
		expect(formatted("hostname", ctx("baseline"), false)).toBe("host-13.example.test")
		expect(formatted("idn-hostname", ctx("baseline"), true)).toBe("host-13-n0.example.test")
	})

	it("addresses on the documentation networks, and bytes as base64", () => {
		expect(formatted("ipv4", ctx("baseline", 251), false)).toBe("192.0.2.2")
		expect(formatted("ipv6", ctx("baseline"), false)).toBe("2001:db8::14")
		expect(formatted("byte", ctx("baseline", 1), false)).toBe(Buffer.from("oat 1").toString("base64"))
	})

	it("UUIDs from the variant and index, and the nonce when distinct", () => {
		expect(formatted("uuid", ctx("baseline"), false)).toBe(uuidFrom("baseline:13"))
		expect(formatted("uuid", ctx("baseline"), true)).toBe(uuidFrom("baseline:13:n0"))
		expect(formatted("uuid", ctx("baseline", 13, null), true)).toBe(uuidFrom("baseline:13:"))
	})

	it("knows nothing of a format it does not list", () => {
		expect(formatted("color", ctx("baseline"), false)).toBeUndefined()
		expect(formatted("constructor", ctx("baseline"), false)).toBeUndefined()
	})
})
