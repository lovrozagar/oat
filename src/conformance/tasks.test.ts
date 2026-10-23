import { mkdtempSync, readdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { inProcess } from "./harness/launch.ts"
import { runTask } from "./tasks.ts"

/*
 * A task's answer carries what its worker held afterwards, and with OAT_HEAP_SNAPSHOTS set, a heap
 * snapshot after each task: how a leg's leftovers are found. Every kind runs against the reference
 * in process here; the gate's workers reach it behind a socket.
 */

const nothing = { defects: ["NO_SUCH_DEFECT"], kind: "scope", known: {} } as const

afterEach(() => {
	delete process.env["OAT_HEAP_SNAPSHOTS"]
})

describe("runTask", () => {
	it("answers with what the process holds after the task", async () => {
		const answer = await runTask({ ...nothing, defects: [...nothing.defects] }, 1, inProcess)
		expect(answer).toMatchObject({ kind: "results", requests: { sources: {}, total: 0 }, results: [] })
		expect(answer.memory.rss).toBeGreaterThan(answer.memory.heapUsed)
	})

	it("writes a heap snapshot after the task when asked", async () => {
		const dir = mkdtempSync(join(tmpdir(), "oat-heap-"))
		process.env["OAT_HEAP_SNAPSHOTS"] = dir
		await runTask({ ...nothing, defects: [...nothing.defects] }, 7, inProcess)
		expect(readdirSync(dir)).toEqual([expect.stringMatching(/^\d+-0007-scope\.heapsnapshot$/)])
	}, 60_000)

	it("writes none when the folder is empty", async () => {
		process.env["OAT_HEAP_SNAPSHOTS"] = ""
		const answer = await runTask({ ...nothing, defects: [...nothing.defects] }, 2, inProcess)
		expect(answer.kind).toBe("results")
	})
})

describe("a leg's tasks", () => {
	it("runs its two baselines clean", async () => {
		const answer = await runTask({ backend: "memory", dialect: "postgrest", kind: "baselines" }, 1, inProcess)
		expect(answer.kind).toBe("leg")
		const results = answer.kind === "leg" ? answer.results : []
		expect(results.map((result) => [result.label, result.detected, result.error])).toEqual([
			["baseline (correct backend)", true, undefined],
			["baseline (untagged spec)", true, undefined],
		])
		expect(results[0]?.findings.every((finding) => finding.evidence.length === 0)).toBe(true)
		/* Every request both runs sent, counted where it left, and each by who sent it. */
		const { sources, total } = answer.requests
		expect(total).toBeGreaterThan(1000)
		expect(Object.values(sources).reduce((sum, count) => sum + count, 0)).toBe(total)
		expect(sources).toMatchObject({ seed: expect.any(Number), teardown: expect.any(Number) })
	}, 120_000)

	it("judges its defects one by one", async () => {
		const task = { backend: "memory", defects: ["STALE_LIST"], dialect: "postgrest", kind: "defects" } as const
		const answer = await runTask({ ...task, defects: [...task.defects] }, 1, inProcess)
		expect(answer).toMatchObject({ kind: "leg", results: [{ defect: "STALE_LIST", detected: true }] })
	}, 120_000)

	it("targets the operations a defect's finding judged", async () => {
		const answer = await runTask(
			{ defects: ["PATCH_REPLACES"], kind: "scope", known: { PATCH_REPLACES: ["table.update"] } },
			1,
			inProcess,
		)
		expect(answer).toMatchObject({ kind: "results", results: [{ ok: true }] })
	}, 120_000)
})

describe("the shapes' tasks", () => {
	it("runs the default shape for the checks every shape must also run", async () => {
		const answer = await runTask({ kind: "shape-reference" }, 1, inProcess)
		expect(answer.kind === "reference" ? answer.checks?.length : 0).toBeGreaterThan(50)
	}, 120_000)

	it("judges one shape, and recall behind it", async () => {
		const shape = await runTask({ kind: "shape", name: "path-prefix", reference: null }, 1, inProcess)
		expect(shape).toMatchObject({ cases: [{ label: "shape:path-prefix", problems: [] }], kind: "cases" })
		const recall = await runTask({ defects: ["STALE_LIST"], kind: "recall", shape: "path-prefix" }, 2, inProcess)
		expect(recall).toMatchObject({ cases: [{ label: "recall:path-prefix:STALE_LIST", problems: [] }], kind: "cases" })
	}, 120_000)
})
