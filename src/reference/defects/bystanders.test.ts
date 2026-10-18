import { describe, expect, it } from "vitest"
import { DAMAGES_BYSTANDERS } from "./bystanders.ts"

describe("DAMAGES_BYSTANDERS", () => {
	it("is empty: no defect rewrites records nobody asked it to touch", () => {
		expect([...DAMAGES_BYSTANDERS]).toEqual([])
	})
})
