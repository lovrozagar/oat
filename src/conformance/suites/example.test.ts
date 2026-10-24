import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { runExampleSpecSuite } from "./example.ts"

describe("runExampleSpecSuite", () => {
	it("finds the annotated example modeled as its comments claim", async () => {
		const results = await runExampleSpecSuite()
		expect(results.filter((r) => !r.ok).map((r) => `${r.name}: ${r.detail}`)).toEqual([])
		expect(results.length).toBeGreaterThan(10)
	})

	it("reports a document it cannot read as one failure", async () => {
		const results = await runExampleSpecSuite(join(tmpdir(), "oat-no-such-example.yaml"))
		expect(results.map((r) => [r.name, r.ok])).toEqual([["annotated-openapi.yaml", false]])
	})

	it("names what the model says where a claim does not hold", async () => {
		const dir = await mkdtemp(join(tmpdir(), "oat-example-"))
		try {
			const path = join(dir, "bare.json")
			await writeFile(path, JSON.stringify({ info: { title: "bare", version: "1" }, openapi: "3.1.0", paths: {} }))
			const results = await runExampleSpecSuite(path)
			expect(results.every((r) => !r.ok)).toBe(true)
			expect(results[0]?.detail).toBe('expected "postgrest", got undefined')
			expect(results.find((r) => r.name === "public catalog is unscoped")?.detail).toBe("expected null, got undefined")
		} finally {
			await rm(dir, { force: true, recursive: true })
		}
	})
})
