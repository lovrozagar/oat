import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { wallClockExpectations } from "../support/wall-clock.ts"

/*
 * A unit test's verdict never depends on how fast the host runs. An expectation that reads the
 * real clock, or bounds an elapsed time with a number, passes on an idle machine and fails on a
 * loaded one; a file that fakes its timers is exempt, because its clock only moves when the test
 * moves it.
 */

const ROOT = join(import.meta.dirname, "..", "..")

describe("wall-clock expectations", () => {
	it("finds a real-clock read or a time bound in an expectation", () => {
		const seeded = [
			"expect(performance.now() - started).toBeLessThan(50)",
			"expect(Date.now() - began).toBeGreaterThanOrEqual(10)",
			"expect(outcome.elapsedMs).toBeLessThan(100)",
			"expect(result.polls).toBe(3)",
			"expect(timer.durationMs).toEqual(0)",
		].join("\n")
		expect(wallClockExpectations(seeded)).toEqual([1, 2, 3])
	})

	it("exempts a file that fakes its timers", () => {
		const faked = "vi.useFakeTimers()\nexpect(performance.now() - started).toBeLessThan(50)"
		expect(wallClockExpectations(faked)).toEqual([])
	})

	it("holds every unit test to it", () => {
		const files = execFileSync("git", ["ls-files", "src/**/*.test.ts", "lint/**/*.test.ts"], {
			cwd: ROOT,
			encoding: "utf8",
		})
			.split("\n")
			.filter(Boolean)
		const found = files.flatMap((file) =>
			wallClockExpectations(readFileSync(join(ROOT, file), "utf8")).map((line) => `${file}:${line}`),
		)
		expect(found).toEqual([])
	})
})
