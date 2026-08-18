import { mkdir, mkdtemp, readlink, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { allocateRunDir, DEFAULT_RUNS_ROOT, formatRunStamp, LATEST_LINK } from "../src/runtime/runs.ts"

const temps: string[] = []

afterEach(async () => {
	await Promise.all(temps.splice(0).map((dir) => rm(dir, { force: true, recursive: true })))
})

async function scratch(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "oat-runs-"))
	temps.push(dir)
	return dir
}

describe("formatRunStamp", () => {
	it("is UTC and filesystem-safe", () => {
		expect(formatRunStamp(new Date("2026-08-18T14:30:05.123Z"))).toBe("2026-08-18T14-30-05Z")
	})

	it("zero-pads and drops milliseconds", () => {
		expect(formatRunStamp(new Date("2026-01-02T03:04:05.000Z"))).toBe("2026-01-02T03-04-05Z")
	})
})

describe("allocateRunDir", () => {
	it("defaults the root name", () => {
		expect(DEFAULT_RUNS_ROOT).toBe(".oat/runs")
		expect(LATEST_LINK).toBe("latest")
	})

	it("creates a timestamped folder and a latest symlink", async () => {
		const root = await scratch()
		const at = new Date("2026-08-18T12:00:00.000Z")
		const allocated = await allocateRunDir(root, at)
		expect(allocated.root).toBe(resolve(root))
		expect(allocated.stamp).toBe("2026-08-18T12-00-00Z")
		expect(allocated.runDir).toBe(join(allocated.root, allocated.stamp))
		expect(allocated.latest).toBe(join(allocated.root, "latest"))
		expect(await readlink(allocated.latest)).toBe(allocated.stamp)
		await writeFile(join(allocated.runDir, "oat-report.json"), "{}\n")
		expect(await realpath(join(allocated.latest, "oat-report.json"))).toBe(
			await realpath(join(allocated.runDir, "oat-report.json")),
		)
	})

	it("does not overwrite a same-second collision", async () => {
		const root = await scratch()
		const at = new Date("2026-08-18T12:00:00.000Z")
		const first = await allocateRunDir(root, at)
		const second = await allocateRunDir(root, at)
		const third = await allocateRunDir(root, at)
		expect(first.stamp).toBe("2026-08-18T12-00-00Z")
		expect(second.stamp).toBe("2026-08-18T12-00-00Z-2")
		expect(third.stamp).toBe("2026-08-18T12-00-00Z-3")
		expect(first.runDir).not.toBe(second.runDir)
		expect(await readlink(third.latest)).toBe(third.stamp)
	})

	it("skips a file sitting on the stamp name", async () => {
		const root = await scratch()
		await writeFile(join(root, "2026-08-18T12-00-00Z"), "nope\n")
		const allocated = await allocateRunDir(root, new Date("2026-08-18T12:00:00.000Z"))
		expect(allocated.stamp).toBe("2026-08-18T12-00-00Z-2")
	})

	it("advances latest to the newest run", async () => {
		const root = await scratch()
		const older = await allocateRunDir(root, new Date("2026-08-18T12:00:00.000Z"))
		const newer = await allocateRunDir(root, new Date("2026-08-18T12:00:01.000Z"))
		expect(await readlink(newer.latest)).toBe(newer.stamp)
		expect(older.latest).toBe(newer.latest)
	})

	it("replaces a leftover latest directory", async () => {
		const root = await scratch()
		await mkdir(join(root, "latest"), { recursive: true })
		await writeFile(join(root, "latest", "stale.txt"), "old\n")
		const allocated = await allocateRunDir(root, new Date("2026-08-18T12:00:00.000Z"))
		expect(await readlink(allocated.latest)).toBe(allocated.stamp)
	})

	it("creates a missing root", async () => {
		const parent = await scratch()
		const root = join(parent, "nested", "runs")
		const allocated = await allocateRunDir(root, new Date("2026-08-18T12:00:00.000Z"))
		expect(allocated.root).toBe(resolve(root))
		expect(allocated.stamp).toBe("2026-08-18T12-00-00Z")
	})

	it("stamps from now when no date is given", async () => {
		const root = await scratch()
		const before = formatRunStamp(new Date())
		const allocated = await allocateRunDir(root)
		const after = formatRunStamp(new Date())
		expect([before, after, `${before}-2`, `${after}-2`]).toContain(allocated.stamp)
	})
})
