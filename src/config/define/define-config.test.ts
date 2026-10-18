import { describe, expect, it } from "vitest"
import { defineConfig } from "./define-config.ts"
import type { OatConfig } from "./types.ts"

describe("defineConfig", () => {
	it("returns the config it is given, unchanged", () => {
		const config: OatConfig = { baseUrl: "http://h.test", principals: [{ id: "alpha" }], spec: "openapi.json" }
		expect(defineConfig(config)).toBe(config)
	})
})
