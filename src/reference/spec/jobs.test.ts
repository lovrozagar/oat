import { describe, expect, it } from "vitest"
import { ENTITIES, JOB } from "../model.ts"
import { jobPaths } from "./jobs.ts"
import type { Json } from "./types.ts"

const PROJECT = JOB.collectionPath.replace("/jobs", "")

function paths(rangeStatuses: boolean): Record<string, Record<string, Json & { responses: Json }>> {
	return jobPaths({ entities: ENTITIES, shape: { rangeStatuses } }, JOB) as never
}

describe("jobPaths", () => {
	const declared = paths(false)

	it("routes a job start, a notification and the inbox it lands in", () => {
		expect(Object.keys(declared)).toEqual([
			`${JOB.collectionPath}/start`,
			`${PROJECT}/notifications`,
			`${PROJECT}/inbox`,
		])
	})

	it("declares the async lifecycle polled on the job's item route", () => {
		const start = declared[`${JOB.collectionPath}/start`]?.post
		expect(start).toMatchObject({
			operationId: "job.start",
			"x-async": { idFrom: "$.job_id", poll: `GET ${JOB.itemPath}`, until: "status.in.(complete,failed)" },
			"x-effects": [{ count: 1, entity: "job", op: "create" }],
			"x-tenant": "project_id",
		})
		expect(Object.keys(start?.responses ?? {})).toEqual(["202", "400", "401", "403", "404", "415"])
	})

	it("declares where a notification's effect arrives and how long to wait", () => {
		const notify = declared[`${PROJECT}/notifications`]?.post
		expect(notify?.["x-wait"]).toEqual({ operationId: "job.inbox", timeoutMs: 2000, until: "$.messages[0]" })
		const inbox = declared[`${PROJECT}/inbox`]?.get
		expect(inbox?.operationId).toBe("job.inbox")
		expect(Object.keys(inbox?.responses ?? {})).toEqual(["200", "401", "403", "404"])
	})

	it("documents every answer as 2XX and default under range statuses", () => {
		const inbox = paths(true)[`${PROJECT}/inbox`]?.get
		expect(Object.keys(inbox?.responses ?? {})).toEqual(["2XX", "default"])
	})
})
