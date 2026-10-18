import { describe, expect, it } from "vitest"
import { describeSuccess, documentsStatus, readStatuses } from "./statuses.ts"

describe("readStatuses", () => {
	it("reads exact codes, ranges and default, each sorted, ignoring anything else", () => {
		expect(readStatuses({ "201": {}, "200": {}, "4xx": {}, "2XX": {}, default: {}, "600": {}, "2X": {} })).toEqual({
			default: true,
			exact: [200, 201],
			ranges: [2, 4],
		})
		expect(readStatuses(undefined)).toEqual({ default: false, exact: [], ranges: [] })
	})
})

describe("documentsStatus", () => {
	it("covers a status named exactly, by its range, or by default", () => {
		const statuses = readStatuses({ "200": {}, "4XX": {} })
		expect([200, 404, 500].map((status) => documentsStatus(statuses, status))).toEqual([true, true, false])
		expect(documentsStatus(readStatuses({ default: {} }), 500)).toBe(true)
	})
})

describe("describeSuccess", () => {
	it("spells the success statuses as the document does", () => {
		expect(describeSuccess(readStatuses({ "200": {}, "204": {}, "2XX": {}, "302": {}, "4XX": {} }))).toEqual([
			"200",
			"204",
			"2XX",
		])
	})
})
