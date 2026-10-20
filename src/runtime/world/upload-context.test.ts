import { describe, expect, it } from "vitest"
import { uploadContext } from "./upload-context.ts"

describe("uploadContext", () => {
	it("is the run's uploads, or a seed-only context when it configured none", () => {
		const uploads = { configDir: "/tmp", seed: 3 }
		expect(uploadContext({ principal: "alpha", roots: {}, seed: 1, uploads })).toBe(uploads)
		expect(uploadContext({ principal: "alpha", roots: {}, seed: 1 })).toEqual({ seed: 1 })
	})
})
