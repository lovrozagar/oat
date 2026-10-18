import { describe, expect, it } from "vitest"
import { contextOf, flow, notesApi, notesDoc, optionsFor, withLogin } from "./__fixtures__/api.ts"
import { disposable } from "./disposable.ts"

/* An operation that consumes its subject runs on a principal of its own, never the run's. */

const withAccountDelete = {
	"/account": {
		delete: { operationId: "account.delete", responses: { "204": { description: "gone" } }, "x-destructive": true },
	},
}

describe("disposable", () => {
	it("stands an operation down when nothing can read the caller back", async () => {
		const ctx = await contextOf(optionsFor(notesApi(notesDoc(withAccountDelete))))
		await disposable(ctx)
		expect(ctx.state.checksRun.has("auth.destructive-spares-the-caller")).toBe(true)
		expect(ctx.findings.findings).toEqual([])
	})

	it("hands the first principal's flow and the input hook to the signup it would use", async () => {
		const login = withLogin()
		const notes = notesApi(
			notesDoc({
				...withAccountDelete,
				"/login": { post: { operationId: "auth.login", responses: { "200": { description: "ok" } }, security: [] } },
			}),
		)
		const ctx = await contextOf(
			optionsFor(
				(method, path, request) => (path === "/login" ? login(method, path, request) : notes(method, path, request)),
				{
					hooks: { resolveInput: async () => null } as never,
					principals: [flow],
				},
			),
		)
		await disposable(ctx)
		expect(ctx.state.checksRun.has("auth.destructive-spares-the-caller")).toBe(true)
	})

	it("takes only the targeted operations in a targeted run", async () => {
		const ctx = await contextOf(optionsFor(notesApi(notesDoc(withAccountDelete)), { ops: ["notes.list"] }))
		await disposable(ctx)
		expect(ctx.state.checksRun.has("auth.destructive-spares-the-caller")).toBe(false)
	})
})
