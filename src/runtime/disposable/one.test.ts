import { describe, expect, it } from "vitest"
import type { OperationModel } from "../../spec/graph/types.ts"
import { accounts, accountsApi, accountsDoc, sessionHolding, type Staged, stageOf } from "./__fixtures__/accounts.ts"
import { runOne } from "./one.ts"
import type { DisposableInput, Session } from "./types.ts"

/** The second user `t9`, bound in the staged run's store, who knows its refresh token. */
const session = (staged: Staged, fields: Partial<Session> = {}): Promise<Session> =>
	sessionHolding(staged, "t9", { known: { refresh_token: "r9" }, ...fields })

/** `runOne` for `operationId` as `as` (default: `t9`), the caller read being `profile.read`. */
async function runAs(staged: Staged, operationId: string, as?: Session): Promise<void> {
	const { input } = staged
	const op = input.model.byOperationId.get(operationId) as OperationModel
	const read = input.model.byOperationId.get("profile.read") as OperationModel
	await runOne(input, { ends: false, op, read, session: as ?? (await session(staged)) })
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
	it("takes a param from the session's scope without listing, and sends as that session", async () => {
		const staged = await stageOf(accountsDoc(), accountsApi(accounts({ keys: [{ id: "k7" }] })))
		await runAs(staged, "keys.delete", await session(staged, { scope: { key_id: "k7" } }))
		expect(staged.seen[0]).toMatchObject({
			headers: { authorization: "Bearer t9" },
			method: "DELETE",
			path: "/v1/keys/k7",
		})
		expect(staged.input.client.transcript.at(-1)?.principal).toBe("disposable-t9")
	})

	it("skips an operation with no list above it, or whose list holds no id", async () => {
		const staged = await stageOf(accountsDoc(extra), accountsApi(accounts({ keys: [] })))
		const { input, seen } = staged
		await runAs(staged, "orphans.delete")
		expect(needs(input, "orphans.delete")).toEqual(["unresolved param orphan_id"])
		await runAs(staged, "keys.delete")
		expect(needs(input, "keys.delete")).toEqual(["the list returned no id"])
		expect(seen.map((request) => request.path)).toEqual(["/v1/keys"])
	})
})

describe("runOne: the call", () => {
	it("sends what the signup knows, over an empty body when the schema cannot be generated", async () => {
		const staged = await stageOf(accountsDoc(extra), accountsApi(accounts()))
		await runAs(staged, "data.wipe")
		expect(staged.seen[0]).toMatchObject({ body: { refresh_token: "r9" }, path: "/v1/wipe" })
	})

	it("passes the generated body through hooks.resolveInput", async () => {
		const staged = await stageOf(accountsDoc(), accountsApi(accounts()), {
			input: {
				nonce: undefined,
				resolveInput: async ({ field }) => (field === "refresh_token" ? "picked" : null),
				seed: undefined,
			},
		})
		await runAs(staged, "auth.logout", await session(staged, { known: {} }))
		expect(staged.seen[0]?.body).toEqual({ refresh_token: "picked" })
	})
})

describe("runOne: the answer", () => {
	it("fails a server error, and leaves a refusal for a scenario", async () => {
		const failing = await stageOf(
			accountsDoc(),
			accountsApi(accounts({ answers: { "POST /v1/logout": { status: 503 } } })),
		)
		await runAs(failing, "auth.logout")
		expect(failing.input.findings.findings[0]).toMatchObject({
			check: "auth.destructive-spares-the-caller",
			detail: "auth.logout returned 503.",
			entity: "profile",
			summary: "the disposable call failed",
		})
		expect(failing.input.grades.ran.get("auth.logout")?.size).toBe(1)
		const refused = await stageOf(
			accountsDoc(),
			accountsApi(accounts({ answers: { "POST /v1/logout": { status: 403 } } })),
		)
		await runAs(refused, "auth.logout")
		expect(needs(refused.input, "auth.logout")).toEqual([
			"destructive call returned 403; a scenario must set the scene",
		])
		const moved = await stageOf(
			accountsDoc(),
			accountsApi(accounts({ answers: { "POST /v1/logout": { status: 302 } } })),
		)
		await runAs(moved, "auth.logout")
		expect(needs(moved.input, "auth.logout")).toEqual(["destructive call returned 302; a scenario must set the scene"])
	})

	it("names the operation's own entity, else the caller read's, else `caller`", async () => {
		const failing = accountsApi(
			accounts({ answers: { "DELETE /v1/keys/k1": { status: 500 }, "POST /v1/logout": { status: 500 } } }),
		)
		const owned = await stageOf(accountsDoc(), failing)
		const op = { ...(owned.input.model.byOperationId.get("auth.logout") as OperationModel), entity: "session" }
		const read = owned.input.model.byOperationId.get("profile.read") as OperationModel
		const as = await session(owned)
		await runOne(owned.input, { ends: false, op, read, session: as })
		await runOne(owned.input, {
			ends: false,
			op: { ...op, entity: null },
			read: { ...read, entity: null },
			session: as,
		})
		expect(owned.input.findings.findings.map((finding) => finding.entity)).toEqual(["session", "caller"])
	})
})
