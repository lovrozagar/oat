import { describe, expect, it } from "vitest"
import type { Finding } from "../../runtime/finding.ts"
import { checkReproSyntax, checkScripts } from "./repro-syntax.ts"

const finding: Finding = {
	check: "sort.order-is-applied",
	detail: "d",
	entity: "row",
	evidence: [
		{
			at: 0,
			durationMs: 0,
			method: "GET",
			requestBody: undefined,
			requestBytes: 0,
			requestHeaders: { "x-note": "it's" },
			requestId: "",
			responseBody: null,
			responseBytes: 0,
			responseHeaders: {},
			seq: 1,
			status: 200,
			url: "https://example.test/rows?order=name.asc",
		},
	],
	summary: "s",
	verdict: "BACKEND_BUG",
}

describe("checkReproSyntax", () => {
	it("finds oat's generated reproducers runnable", async () => {
		expect(await checkReproSyntax([finding])).toEqual([])
		expect(await checkReproSyntax([])).toEqual([])
	})
})

describe("checkScripts", () => {
	it("reports a script bash cannot parse", async () => {
		const [failure] = await checkScripts([{ content: "if then\n", filename: "broken.sh" }])
		expect(failure).toMatch(/^broken\.sh: /)
	})

	it("reports $BASE or $TOKEN inside single quotes, outside comments", async () => {
		const content = "# the schema's '$BASE' in prose\ncurl '$BASE/rows'\ncurl \"$TOKEN\"\n"
		expect(await checkScripts([{ content, filename: "quoted.sh" }])).toEqual([
			"quoted.sh: $BASE/$TOKEN appears inside single quotes and will not expand — curl '$BASE/rows'",
		])
	})
})
