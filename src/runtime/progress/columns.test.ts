import { describe, expect, it } from "vitest"
import { PROGRESS_GLOSSARY, PROGRESS_TSV_HEADER } from "./columns.ts"

describe("progress columns", () => {
	it("names twenty tab-separated columns, from the instant to the run's elapsed time", () => {
		const columns = PROGRESS_TSV_HEADER.split("\t")
		expect(columns).toHaveLength(20)
		expect([columns[0], columns[1], columns.at(-1)]).toEqual(["ts_ms", "status", "elapsed_ms"])
	})

	it("explains every column in a commented glossary", () => {
		const lines = PROGRESS_GLOSSARY.split("\n")
		expect(lines.every((line) => line.startsWith("# "))).toBe(true)
		expect(lines[0]).toBe("# logfmt — one event per line, full values, no truncation")
		for (const column of ["status", "phase", "req_id", "last_ms", "idle_ms", "elapsed_ms"]) {
			expect(PROGRESS_GLOSSARY).toContain(`# ${column}`)
		}
	})
})
