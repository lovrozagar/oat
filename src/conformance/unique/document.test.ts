import { describe, expect, it } from "vitest"
import { report } from "../../report/console/report.ts"
import { buildModel } from "../../spec/graph/build.ts"
import type { OpenApiDocument } from "../../spec/types.ts"
import { documentCases, doctorCase, planCase, untaggedDoctorCase } from "./document.ts"
import { widgetSpec } from "./spec.ts"

const untagged = buildModel(widgetSpec({ omitTag: true }))
const nothing = buildModel({ info: { title: "empty", version: "1" }, openapi: "3.1.0", paths: {} } as OpenApiDocument)

describe("documentCases", () => {
	it("finds x-unique parsed, dropped, refused and shown as documented", () => {
		const results = documentCases()
		expect(results.filter((r) => !r.ok)).toEqual([])
		expect(results.map((r) => r.detail)).toEqual([
			'list of sets=[["email"],["workspace_id","slug"]]; column objects=[["email"],["workspace_id","slug"]]; single string[]=[["email"]]',
			"[]",
			"unique=null gap=true",
			"[name]; [email]",
			"shown",
			"[]",
		])
	})
})

describe("planCase and doctorCase", () => {
	it("say so when the sets are missing from the report", () => {
		expect(planCase(untagged)).toMatchObject({ detail: "missing from plan", ok: false })
		expect(planCase(nothing)).toMatchObject({ detail: "missing from plan", ok: false })
		expect(doctorCase(untagged)).toMatchObject({ detail: "missing from doctor", ok: false })
	})
})

describe("untaggedDoctorCase", () => {
	it("passes a doctor report that names the locked checks", () => {
		expect(untaggedDoctorCase(report.doctor(untagged).text)).toMatchObject({ detail: "named", ok: true })
	})

	it("fails a report that never mentions the tag", () => {
		expect(untaggedDoctorCase(report.plan(untagged, false))).toMatchObject({
			detail: "missing from doctor",
			ok: false,
		})
	})
})
