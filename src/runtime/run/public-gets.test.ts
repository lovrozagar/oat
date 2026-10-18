import { describe, expect, it } from "vitest"
import { contextOf, notesApi, notesDoc, optionsFor } from "./__fixtures__/api.ts"
import { publicGets } from "./public-gets.ts"

const withHealth = notesDoc({
	"/health": { get: { operationId: "health.get", responses: { "200": { description: "ok" } }, security: [] } },
})

describe("publicGets", () => {
	it("reads each GET that needs no auth and no fixture, once, before the entities", async () => {
		const notes = notesApi(withHealth)
		const options = optionsFor((method, path, request) =>
			path === "/health" ? { body: { ok: true }, status: 200 } : notes(method, path, request),
		)
		const ctx = await contextOf(options)
		await publicGets(ctx)
		expect(ctx.state.checksRun.has("response.public-get-returns-success")).toBe(true)
		expect(options.seen.some((request) => request.path === "/health")).toBe(true)
	})

	it("reads only the targeted ones in a targeted run", async () => {
		const notes = notesApi(withHealth)
		const options = optionsFor(
			(method, path, request) => (path === "/health" ? { body: {}, status: 200 } : notes(method, path, request)),
			{
				ops: ["notes.list"],
			},
		)
		await publicGets(await contextOf(options))
		expect(options.seen.some((request) => request.path === "/health")).toBe(false)
	})
})
