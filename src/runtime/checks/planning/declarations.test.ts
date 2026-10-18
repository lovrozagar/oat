import { describe, expect, it } from "vitest"
import { declarationAnswer } from "./declarations.ts"

/*
 * Only 400 and 422 say a declared capability is not supported. A request turned away before the
 * capability is consulted (401, 403, 404, 429), a crash, or no answer at all says nothing.
 */

describe("declarationAnswer", () => {
	it("reads any answer below 400 as accepted", () => {
		expect(declarationAnswer(200)).toBe("accepted")
		expect(declarationAnswer(304)).toBe("accepted")
	})

	it("reads 400 and 422 as refused", () => {
		expect(declarationAnswer(400)).toBe("refused")
		expect(declarationAnswer(422)).toBe("refused")
	})

	it("reads everything else, and no answer, as unknown", () => {
		for (const status of [0, 401, 403, 404, 429, 500]) expect(declarationAnswer(status)).toBe("unknown")
	})
})
