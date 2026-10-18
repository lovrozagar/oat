import { describe, expect, it } from "vitest"
import { JOB } from "./job.ts"

describe("JOB", () => {
	it("is an asynchronous job whose status and progress the server moves", () => {
		const generated = JOB.fields.filter((field) => field.generated === true).map((field) => field.name)
		expect(generated).toEqual(expect.arrayContaining(["status", "progress"]))
		expect(JOB.fields.find((field) => field.name === "status")?.enum).toEqual([
			"pending",
			"running",
			"complete",
			"failed",
		])
	})

	it("has a repeated client-set dimension and two independent writable texts", () => {
		expect(JOB.fields.find((field) => field.name === "kind")).toMatchObject({ enum: ["export", "import", "sync"] })
		const writable = JOB.fields.filter(
			(field) => field.type === "string" && field.generated !== true && field.enum === undefined,
		)
		expect(writable.map((field) => field.name)).toEqual(["name", "note"])
	})
})
