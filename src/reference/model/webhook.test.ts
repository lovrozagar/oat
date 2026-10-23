import { describe, expect, it } from "vitest"
import { WEBHOOK } from "./webhook.ts"

describe("WEBHOOK", () => {
	it("is a project's record with no list, its id generated and its name and url required", () => {
		expect(WEBHOOK).toMatchObject({ name: "webhook", parents: ["project_id"], unlisted: true })
		const required = WEBHOOK.fields.filter((field) => field.required === true && field.generated !== true)
		expect(required.map((field) => field.name)).toEqual(["name", "url"])
	})

	it("has a nullable description and a status enum for create and validation defects to act on", () => {
		expect(WEBHOOK.fields.find((field) => field.name === "description")).toMatchObject({ nullable: true })
		expect(WEBHOOK.fields.find((field) => field.name === "status")?.enum).toEqual(["active", "paused"])
	})
})
