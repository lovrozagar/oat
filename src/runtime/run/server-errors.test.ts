import { describe, expect, it } from "vitest"
import { contextOf, notesApi, optionsFor } from "./__fixtures__/api.ts"
import { serverErrors } from "./server-errors.ts"

describe("serverErrors", () => {
	it("reports a request the API answered with a server error", async () => {
		const notes = notesApi()
		const ctx = await contextOf(
			optionsFor((method, path, request) => (path === "/boom" ? { status: 500 } : notes(method, path, request))),
		)
		await ctx.client.get("/boom", { as: { principal: "alpha" }, operationId: "notes.list" })
		serverErrors(ctx)
		expect(ctx.state.checksRun.has("response.no-server-error")).toBe(true)
		expect(ctx.findings.findings.some((finding) => finding.check === "response.no-server-error")).toBe(true)
	})

	it("counts the server errors of every origin's client too", async () => {
		const notes = notesApi()
		const ctx = await contextOf(
			optionsFor((method, path, request) => (path === "/boom" ? { status: 503 } : notes(method, path, request)), {
				origins: [
					{
						baseUrl: "http://other.test",
						id: "other",
						security: { bearer: "bearer" },
						spec: "http://other.test/openapi.json",
					},
				],
			}),
		)
		await ctx.originClients.get("other")?.client.get("/boom", { as: { principal: "alpha" }, operationId: "notes.list" })
		serverErrors(ctx)
		expect(ctx.findings.findings.some((finding) => finding.check === "response.no-server-error")).toBe(true)
	})
})
