import { describe, expect, it } from "vitest"
import type { HeldCredential } from "../../credentials/store-types.ts"
import type { Exchange } from "../exchange.ts"
import { exchangeOf, modelOf } from "../checks/__fixtures__/harness.ts"
import { madeByRun } from "./made-by-run.ts"
import { doc, ok, pathParam } from "./__fixtures__/stage.ts"

/* Keys an API mints, and notes: two collections whose records both answer `id`. */
const model = modelOf(
	doc({
		"/keys": { post: { operationId: "keys.create", responses: { "201": { description: "made" } } } },
		"/keys/{id}": { delete: { operationId: "keys.revoke", parameters: [pathParam("id")], responses: ok() } },
		"/notes": { post: { operationId: "notes.create", responses: { "201": { description: "made" } } } },
		"/notes/{id}": { delete: { operationId: "notes.delete", parameters: [pathParam("id")], responses: ok() } },
		"/raw": { post: { responses: { "201": { description: "made" } } } },
	}),
)

/* A create of `operationId` answered `status` with `body`, sent by the credential store or not. */
function create(operationId: string | undefined, answer: { body: unknown; status?: number }, issued = true): Exchange {
	const sent = exchangeOf(
		{
			method: "POST",
			options: { as: { anonymous: true }, ...(operationId === undefined ? {} : { operationId }) },
			path: "/keys",
		},
		{ body: answer.body, status: answer.status ?? 201 },
	)
	return issued ? { ...sent, issuedBy: "credentials" } : sent
}

/* A ledger that holds nothing. */
const none = { holds: () => false }

/* A credential the store holds for `principal`. */
const held = (principal: string, value: string): HeldCredential => ({
	credential: { expiresAt: null, value } as HeldCredential["credential"],
	principal,
	scheme: "apiKey",
	scopes: [],
})

/* The revoke of key `id`, answered `status`. */
const revoke = (id: string, status: number): Exchange =>
	exchangeOf(
		{ method: "DELETE", options: { as: { anonymous: true }, operationId: "keys.revoke" }, path: `/keys/${id}` },
		{ status },
	)

describe("madeByRun", () => {
	it("takes a record the ledger holds, of that entity only", () => {
		const made = madeByRun({
			client: { transcript: [] },
			held: [],
			ledger: { holds: (entity, id) => entity === "note" && id === "n1" },
			model,
		})
		expect(made("note", "n1")).toBe(true)
		expect(made("key", "n1")).toBe(false)
	})

	it("takes a dedicated credential the store's own create answered, which the ledger leaves out", () => {
		const transcript = [
			create("keys.create", { body: { id: "k_minted", key: "v-probe" } }),
			create("keys.create", { body: { id: "k_shown", key: "v-probe" } }, false),
			create("keys.create", { body: { id: "k_refused", key: "v-probe" }, status: 409 }),
			create("keys.create", { body: "k_text" }),
			create(undefined, { body: { id: "k_raw", key: "v-probe" } }),
			create("notes.create", { body: { id: "n_minted", key: "v-probe" } }),
		]
		const made = madeByRun({ client: { transcript }, held: [held("alpha#probe-1", "v-probe")], ledger: none, model })
		expect(made("key", "k_minted")).toBe(true)
		for (const id of ["k_shown", "k_refused", "k_text", "k_raw", "n_minted"]) expect(made("key", id)).toBe(false)
		expect(made("note", "n_minted")).toBe(true)
		expect(made("ghost", "k_minted")).toBe(false)
	})

	it("never takes a credential the store holds live for a principal, nor one it no longer holds", () => {
		const transcript = [
			create("keys.create", { body: { expires_in: 3600, id: "k_alpha", key: "v-alpha" } }),
			create("keys.create", { body: { id: "k_dropped", key: "v-dropped" } }),
			create("keys.create", { body: { id: "k_revoked", key: "v-revoked" } }),
			create("keys.create", { body: { id: "k_refused", key: "v-refused" } }),
			revoke("k_revoked", 200),
			revoke("k_refused", 404),
		]
		const made = madeByRun({ client: { transcript }, held: [held("alpha", "v-alpha")], ledger: none, model })
		expect(made("key", "k_alpha")).toBe(false)
		expect(made("key", "k_dropped")).toBe(false)
		expect(made("key", "k_refused")).toBe(false)
		expect(made("key", "k_revoked")).toBe(true)
	})
})
