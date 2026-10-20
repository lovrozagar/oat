import { describe, expect, it } from "vitest"
import { fakeClient, modelOf, op } from "../checks/__fixtures__/harness.ts"
import { FindingCollector } from "../finding.ts"
import { me } from "./__fixtures__/me.ts"
import { operation, pathOf, sendUpdate, throttled } from "./requests.ts"

describe("reaching the caller's routes", () => {
	const model = modelOf(me({ secondRead: "/me/items/{item_id}" }))

	it("looks an operation up only when it is named", () => {
		expect(operation(model, "me.get")?.operationId).toBe("me.get")
		expect(operation(model, undefined)).toBeUndefined()
	})

	it("fills a route with no path id, and refuses one that needs an id", () => {
		expect(pathOf(op(model, "me.get"))).toBe("/me")
		expect(pathOf(op(model, "me.settings"))).toBeNull()
	})

	it("sends an update as the caller", async () => {
		const { client, sent } = fakeClient(() => ({ status: 200 }))
		const caller = { client, principal: "alpha" }
		expect((await sendUpdate(caller, { op: op(model, "me.update"), path: "/me" }, { a: 1 })).status).toBe(200)
		expect(sent).toEqual([
			{
				method: "PATCH",
				options: { as: { principal: "alpha" }, body: { a: 1 }, operationId: "me.update" },
				path: "/me",
			},
		])
	})

	it("takes a 429 that outlived the retries as no verdict", () => {
		const findings = new FindingCollector()
		expect(throttled(findings, "profile")).toEqual({
			kind: "unresolved",
			reason: "the request was rate-limited (429) after retries, so this check could not complete",
		})
		expect(findings.inconclusive).toHaveLength(1)
	})
})
