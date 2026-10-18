import { describe, expect, it } from "vitest"
import type { OperationModel } from "../../spec/graph/types.ts"
import { accounts, accountsApi, accountsDoc, stageOf } from "./__fixtures__/accounts.ts"
import { runOne } from "./one.ts"
import type { DisposableInput, Session } from "./types.ts"

const session = (fields: Partial<Session> = {}): Session => ({
	headers: () => ({ authorization: "Bearer t9" }),
	known: { refresh_token: "r9" },
	roots: {},
	...fields,
})

/** `runOne` for `operationId` as `as`, the caller read being `profile.read`. */
async function runAs(input: DisposableInput, operationId: string, as: Session = session()): Promise<void> {
	const op = input.model.byOperationId.get(operationId) as OperationModel
	const read = input.model.byOperationId.get("profile.read") as OperationModel
	await runOne(input, { ends: false, op, read, session: as })
}

const needs = (input: DisposableInput, id: string) => [...(input.grades.needs.get(id) ?? [])]

/* Destructive routes with no list above them, one whose schema cannot be generated, and one under a team. */
const extra = {
	"/v1/orphans/{orphan_id}": {
		delete: {
			operationId: "orphans.delete",
			parameters: [{ in: "path", name: "orphan_id", required: true, schema: { type: "string" } }],
			responses: { "204": { description: "gone" } },
			"x-destructive": true,
		},
	},
	"/v1/wipe": {
		post: {
			operationId: "data.wipe",
			requestBody: {
				content: {
					"application/json": {
						schema: {
							properties: { code: { pattern: "(", type: "string" }, refresh_token: { type: "string" } },
							required: ["code"],
							type: "object",
						},
					},
				},
			},
			responses: { "200": { description: "ok" } },
			"x-destructive": true,
		},
	},
}

describe("runOne: the path", () => {
	it("takes a param from the session's roots without listing", async () => {
		const { input, seen } = stageOf(accountsDoc(), accountsApi(accounts({ keys: [{ id: "k7" }] })))
		await runAs(input, "keys.delete", session({ roots: { key_id: "k7" } }))
		expect(seen[0]).toMatchObject({ method: "DELETE", path: "/v1/keys/k7" })
	})

	it("skips an operation with no list above it, or whose list holds no id", async () => {
		const { input, seen } = stageOf(accountsDoc(extra), accountsApi(accounts({ keys: [] })))
		await runAs(input, "orphans.delete")
		expect(needs(input, "orphans.delete")).toEqual(["unresolved param orphan_id"])
		await runAs(input, "keys.delete")
		expect(needs(input, "keys.delete")).toEqual(["the list returned no id"])
		expect(seen.map((request) => request.path)).toEqual(["/v1/keys"])
	})
})

describe("runOne: the call", () => {
	it("sends what the signup knows, over an empty body when the schema cannot be generated", async () => {
		const { input, seen } = stageOf(accountsDoc(extra), accountsApi(accounts()))
		await runAs(input, "data.wipe")
		expect(seen[0]).toMatchObject({ body: { refresh_token: "r9" }, path: "/v1/wipe" })
	})

	it("passes the generated body through hooks.resolveInput", async () => {
		const { input, seen } = stageOf(accountsDoc(), accountsApi(accounts()), {
			nonce: undefined,
			resolveInput: async ({ field }) => (field === "refresh_token" ? "picked" : null),
			seed: undefined,
		})
		await runAs(input, "auth.logout", session({ known: {} }))
		expect(seen[0]?.body).toEqual({ refresh_token: "picked" })
	})

	it("fails a server error, and leaves a refusal for a scenario", async () => {
		const failing = stageOf(accountsDoc(), accountsApi(accounts({ answers: { "POST /v1/logout": { status: 503 } } })))
		await runAs(failing.input, "auth.logout")
		expect(failing.input.findings.findings[0]).toMatchObject({
			check: "auth.destructive-spares-the-caller",
			detail: "auth.logout returned 503.",
			entity: "profile",
			summary: "the disposable call failed",
		})
		expect(failing.input.grades.ran.get("auth.logout")?.size).toBe(1)
		const refused = stageOf(accountsDoc(), accountsApi(accounts({ answers: { "POST /v1/logout": { status: 403 } } })))
		await runAs(refused.input, "auth.logout")
		expect(needs(refused.input, "auth.logout")).toEqual([
			"destructive call returned 403; a scenario must set the scene",
		])
		const moved = stageOf(accountsDoc(), accountsApi(accounts({ answers: { "POST /v1/logout": { status: 302 } } })))
		await runAs(moved.input, "auth.logout")
		expect(needs(moved.input, "auth.logout")).toEqual(["destructive call returned 302; a scenario must set the scene"])
	})

	it("names the operation's own entity, else the caller read's, else `caller`", async () => {
		const failing = accountsApi(
			accounts({ answers: { "DELETE /v1/keys/k1": { status: 500 }, "POST /v1/logout": { status: 500 } } }),
		)
		const owned = stageOf(accountsDoc(), failing)
		const op = { ...(owned.input.model.byOperationId.get("auth.logout") as OperationModel), entity: "session" }
		const read = owned.input.model.byOperationId.get("profile.read") as OperationModel
		await runOne(owned.input, { ends: false, op, read, session: session() })
		await runOne(owned.input, {
			ends: false,
			op: { ...op, entity: null },
			read: { ...read, entity: null },
			session: session(),
		})
		expect(owned.input.findings.findings.map((finding) => finding.entity)).toEqual(["session", "caller"])
	})
})
