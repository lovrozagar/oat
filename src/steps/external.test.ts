import { describe, expect, expectTypeOf, it } from "vitest"
import { defineExternals, external, externalKinds, type ExternalInputs } from "./external.ts"

describe("external", () => {
	it("names the external, its input and the scope name its answer binds to", () => {
		expect(external("totp", { secret: "{tfSecret}" }).as("tfEnable").toStep()).toStrictEqual({
			as: "tfEnable",
			external: "totp",
			input: { secret: "{tfSecret}" },
		})
	})

	it("leaves the input out when the external takes none", () => {
		expect(external("google-consent").as("consent").toStep()).toStrictEqual({
			as: "consent",
			external: "google-consent",
		})
	})
})

describe("defineExternals", () => {
	interface Ctx {
		offset: number
	}
	const registry = defineExternals<Ctx, { kind: "computed" | "device" }>()({
		totp: { kind: "computed", resolve: (input: { secret: string }, ctx) => `${input.secret}${ctx.offset}` },
		consent: { kind: "device", resolve: async () => "granted" },
	})

	it("returns the entries as given, metadata included", async () => {
		expect(registry.totp.kind).toBe("computed")
		expect(registry.totp.resolve({ secret: "s" }, { offset: 1 })).toBe("s1")
		expect(await registry.consent.resolve()).toBe("granted")
	})

	it("reads each entry's input type for the scenario side", () => {
		expectTypeOf<ExternalInputs<typeof registry>>().toEqualTypeOf<{ totp: { secret: string }; consent: undefined }>()
	})
})

describe("externalKinds", () => {
	it("maps each registry entry that declares a string kind to it, for config.externals.kinds", () => {
		const entries = defineExternals<object, { kind?: string }>()({
			consent: { kind: "device", resolve: () => "code" },
			pay: { kind: "headless", resolve: () => "paid" },
			totp: { resolve: () => "123456" },
		})
		expect(externalKinds(entries)).toStrictEqual({ consent: "device", pay: "headless" })
	})
})
