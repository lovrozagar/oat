import { describe, expect, it } from "vitest"
import type { OpenApiDocument } from "../spec/types.ts"
import { exchange, modelOf } from "./checks/__fixtures__/harness.ts"
import type { Exchange } from "./exchange.ts"
import { FindingCollector } from "./finding.ts"
import { GradeLedger } from "./grades.ts"
import { reportServerErrors, SERVER_ERROR_CHECK_ID, serverErrorCheck, type ServerErrorInput } from "./server-errors.ts"
import { TARGET_VERSION_READ } from "./target-version.ts"

const model = modelOf({
	info: { title: "t", version: "1" },
	openapi: "3.1.0",
	paths: {
		"/rows": {
			get: {
				operationId: "rows.list",
				responses: {
					"200": {
						content: { "application/json": { schema: { items: { type: "object" }, type: "array" } } },
						description: "ok",
					},
				},
			},
		},
	},
} as unknown as OpenApiDocument)

function crash(path: string, status: number, extra: Partial<Exchange> = {}): Exchange {
	return { ...exchange("GET", path, { status }), ...extra }
}

function judge(transcripts: Exchange[][], over: Partial<ServerErrorInput> = {}): ServerErrorInput {
	const input: ServerErrorInput = {
		checksRun: new Set(),
		findings: new FindingCollector(),
		grades: new GradeLedger(),
		inScope: () => true,
		mode: "full",
		model,
		networkDown: false,
		transcripts,
		...over,
	}
	reportServerErrors(input)
	return input
}

describe("reportServerErrors", () => {
	it("reports every unreported 5xx once per operation, graded and attributed to it", () => {
		const first = crash("/rows", 500, { operationId: "rows.list" })
		const again = crash("/rows", 503, { responseHeaders: { "Retry-After": "1" }, operationId: "rows.list" })
		const { checksRun, findings, grades } = judge([[first, crash("/rows", 200, { operationId: "rows.list" })], [again]])
		expect(checksRun.has(SERVER_ERROR_CHECK_ID)).toBe(true)
		expect(grades.ran.get("rows.list")).toEqual(new Set([SERVER_ERROR_CHECK_ID]))
		expect(findings.findings).toMatchObject([
			{
				check: SERVER_ERROR_CHECK_ID,
				detail: expect.stringMatching(/^2 request\(s\) to rows\.list returned 500, 503\. /),
				entity: "row",
				evidence: [first, again],
				operations: ["rows.list"],
				summary: "rows.list was unavailable (503) even after waiting out its Retry-After",
				verdict: "BACKEND_BUG",
			},
		])
	})

	it("names a request no operation owns by its method and path, on the run", () => {
		const { findings, grades } = judge([[crash("/health?x=1", 502), crash("/x", 500, { operationId: "ghost.op" })]])
		expect(findings.findings.map((f) => [f.summary, f.entity, f.operations])).toEqual([
			["GET /health answered with a server error (502)", "run", []],
			["ghost.op answered with a server error (500)", "run", []],
		])
		expect(grades.ran.size).toBe(0)
	})

	it("counts a timeout as the operation failing, unless the host itself went down", () => {
		const timeout = crash("/rows", 0, {
			network: { attempt: 1, kind: "timeout", message: "t" },
			operationId: "rows.list",
		})
		const refused = crash("/rows", 0, {
			network: { attempt: 1, kind: "refused", message: "r" },
			operationId: "rows.list",
		})
		expect(judge([[timeout, refused]]).findings.findings.map((f) => f.summary)).toEqual([
			"rows.list did not answer before the request timed out",
		])
		expect(judge([[timeout]], { networkDown: true }).findings.findings).toEqual([])
	})
})

describe("what reportServerErrors leaves alone", () => {
	it("skips what is superseded, the version read, and what a check already reported", () => {
		const reported = crash("/rows", 500, { operationId: "rows.list" })
		const findings = new FindingCollector()
		findings.backend("filter.empty-in", "row", { detail: "d", evidence: [reported], summary: "s" })
		findings.gap("filter.empty-in", "row", { detail: "d", summary: "s" })
		const quiet = judge(
			[
				[
					reported,
					crash("/rows", 500, { superseded: true, operationId: "rows.list" }),
					crash("/version", 500, { check: TARGET_VERSION_READ }),
				],
			],
			{ findings },
		)
		expect(quiet.findings.findings.filter((f) => f.check === SERVER_ERROR_CHECK_ID)).toEqual([])
	})

	it("in a targeted run, judges only operations in scope", () => {
		const input = judge([[crash("/health", 500), crash("/rows", 500, { operationId: "rows.list" })]], {
			inScope: () => false,
			mode: "targeted",
		})
		expect(input.findings.findings).toEqual([])
	})
})

describe("serverErrorCheck", () => {
	it("keeps the id registered, and plans and runs nothing itself", async () => {
		expect(serverErrorCheck.plan(undefined as never)).toEqual({ ok: false })
		expect(await serverErrorCheck.run(undefined as never, undefined as never)).toEqual({ kind: "asserted" })
		expect(serverErrorCheck.subjects(undefined as never, model)).toEqual([])
	})
})
