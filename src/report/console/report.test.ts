import { describe, expect, it } from "vitest"
import { referenceModel } from "./__fixtures__/models.ts"
import { doctor } from "./doctor.ts"
import { plan } from "./plan.ts"
import { report } from "./report.ts"

describe("report", () => {
	it("is the doctor and plan renderers the offline commands call", () => {
		expect(report).toEqual({ doctor, plan })
	})

	it("renders every dialect and shape of the reference, tagged and untagged", async () => {
		const variants = [
			{},
			{ untagged: true },
			{ dialect: "jsonapi" },
			{ dialect: "classic", untagged: true },
			{ shape: "path-prefix" },
			{ shape: "wrapped-records", untagged: true },
		]
		for (const options of variants) {
			const { model, externalRefs } = await referenceModel(options)
			expect(report.doctor(model, { externalRefs }).text).toContain("  testable   ")
			expect(report.plan(model, false)).toContain(" operations · ")
		}
	})
})
