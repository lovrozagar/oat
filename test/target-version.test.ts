import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { renderJson, renderMarkdown, type ReportInput } from "../src/report/render.ts"
import { EXIT, exitCode } from "../src/runtime/exit.ts"
import { run } from "../src/runtime/run.ts"

/*
 * A finding is about a build. A run records which one it tested — read from a version route by a
 * JSON path or from a response header — so two reports can be lined up with two releases. A
 * version that cannot be read is noted, never a reason the run fails.
 */

const DOC = {
	info: { title: "versioned", version: "1" },
	openapi: "3.1.0",
	paths: {
		"/version": {
			get: {
				operationId: "version.get",
				responses: {
					"200": {
						content: {
							"application/json": {
								schema: { properties: { build: { type: "string" } }, type: "object" },
							},
						},
						description: "ok",
					},
				},
			},
		},
	},
}

let url = ""
let broken = false
let close: () => Promise<void> = async () => {}
beforeAll(async () => {
	const server = createServer((req, res) => {
		if (req.url === "/openapi.json") {
			res.writeHead(200, { "content-type": "application/json" })
			res.end(JSON.stringify(DOC))
			return
		}
		if (req.url === "/version") {
			res.writeHead(200, { "content-type": "application/json", "x-build": "1.0.88-hdr" })
			res.end(JSON.stringify({ build: "1.0.88" }))
			return
		}
		/* Not in the document, so nothing but the version read calls it, and breaking it changes nothing else. */
		if (req.url === "/build-info" && !broken) {
			res.writeHead(200, { "content-type": "application/json" })
			res.end(JSON.stringify({ build: "1.0.88" }))
			return
		}
		res.writeHead(500, { "content-type": "application/json" })
		res.end(JSON.stringify({ error: "down" }))
	})
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
	url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
	close = () => new Promise((resolve) => server.close(() => resolve()))
})
afterAll(() => close())

const runWith = (targetVersion: { operationId?: string; path?: string; from: string }) =>
	run({
		baseUrl: url,
		principals: [{ headers: { authorization: "Bearer alpha" }, id: "alpha" }],
		seed: 1,
		spec: `${url}/openapi.json`,
		targetVersion,
	})

/* A report needs only what it prints; the rest of a run result is irrelevant here. */
const reportOf = (result: Awaited<ReturnType<typeof runWith>>): ReportInput =>
	({
		...result,
		baseUrl: url,
		durationMs: 1,
		startedAt: new Date("2026-10-16T00:00:00.000Z"),
	}) as unknown as ReportInput

describe("targetVersion", () => {
	it("reads the build from a JSON path or a header and puts it in the report", async () => {
		const byPath = await runWith({ from: "$.build", path: "/build-info" })
		expect(byPath.targetVersion).toEqual({ value: "1.0.88" })
		expect(JSON.parse(renderJson(reportOf(byPath))).targetVersion).toEqual({ value: "1.0.88" })
		expect(renderMarkdown(reportOf(byPath))).toContain("**Target version**: 1.0.88")

		const byHeader = await runWith({ from: "header:x-build", operationId: "version.get" })
		expect(byHeader.targetVersion).toEqual({ value: "1.0.88-hdr" })
	})

	it("notes a version it cannot read, and leaves the exit code alone", async () => {
		const ok = await runWith({ from: "$.build", path: "/build-info" })
		broken = true
		try {
			const failed = await runWith({ from: "$.build", path: "/build-info" })
			expect(failed.targetVersion).toMatchObject({ error: expect.stringContaining("500") })
			expect(exitCode(failed)).toBe(exitCode(ok))
			const missing = await runWith({ from: "$.nope", path: "/build-info" })
			expect(missing.targetVersion).toHaveProperty("error")
		} finally {
			broken = false
		}
		expect(exitCode(ok)).not.toBe(EXIT.usage)
	})
})
