import { describe, expect, it } from "vitest"
import type { SecurityConfig } from "../../../../config/types/security.ts"
import type { Responder } from "../../__fixtures__/harness.ts"
import { contextOf, ledgerNotes, LOGIN, notesApi, notesDoc, optionsFor } from "../../../run/__fixtures__/api.ts"
import { runWriteSecurity } from "../../../run/security.ts"
import { trackCreates } from "../../../run/teardown.ts"
import type { Record_ } from "../../../world/records.ts"
import { invalidBodyRefused } from "./request-invalid-body-refused.ts"

/*
 * The check as the security stage runs it, over the socket-free notes API: where its one invalid
 * body goes, where it never goes, and what becomes of an open write the backend applied.
 */

const json = (schema: unknown) => ({ content: { "application/json": { schema } } })
const created = { "201": { description: "made", ...json({ type: "object" }) } }
const account = {
	properties: { email: { format: "email", type: "string" }, name: { type: "string" } },
	required: ["email", "name"],
	type: "object",
}
/* A declared signup: the one open POST the check sends to. */
const signup = { security: [], "x-fresh-principal": true }
const doc = notesDoc({
	"/login": {
		post: { operationId: "auth.login", requestBody: json(account), responses: created, security: [] },
	},
	"/notes/register": {
		post: { operationId: "notes.register", requestBody: json(account), responses: created, ...signup },
	},
	"/register": {
		post: { operationId: "auth.register", requestBody: json(account), responses: created, ...signup },
	},
})

/** The notes API over `rows` behind `doc`, with `extra` answering first wherever it answers. */
function api(rows: Record_[], extra: Responder = () => undefined): Responder {
	const notes = notesApi(doc, rows)
	return (method, path, request) => extra(method, path, request) ?? notes(method, path, request)
}

describe("request.invalid-body-refused in the security stage", () => {
	it("sends an item write only to the record the run created, never one already there", async () => {
		const rows: Record_[] = [{ id: "pre", title: "there before" }]
		const options = optionsFor(api(rows))
		const ctx = await contextOf(options)
		rows.push({ id: "run-1", title: "t1" })
		ledgerNotes(ctx, ["run-1"])
		const since = options.seen.length
		await runWriteSecurity(ctx, [invalidBodyRefused])
		/* Besides its PATCH, the stage's own throwaway for notes.delete, and the open POST, both of the run's making. */
		const writes = options.seen.slice(since).filter((seen) => seen.method !== "GET")
		expect(writes.filter((seen) => seen.method === "PATCH").map((seen) => seen.path)).toEqual(["/notes/run-1"])
		expect(writes.filter((seen) => seen.path.includes("pre"))).toEqual([])
		expect(rows.find((row) => row["id"] === "pre")).toEqual({ id: "pre", title: "there before" })
	})

	it("never sends to a sign-in the recipe names by method and path, not by operationId", async () => {
		const byPath: SecurityConfig = {
			bearer: { login: { from: "$.token", steps: [{ method: "POST", path: "/login" }] } },
		}
		const options = optionsFor(
			api([], (_method, path) => (path === "/login" ? { body: { token: "t" }, status: 200 } : undefined)),
			{ security: byPath },
		)
		const ctx = await contextOf(options)
		const since = options.seen.length
		await runWriteSecurity(ctx, [invalidBodyRefused])
		expect(options.seen.slice(since).filter((seen) => seen.path === "/login")).toEqual([])
	})

	it("never sends to an open POST no recipe names and the document does not mark a signup", async () => {
		const options = optionsFor(api([]))
		const ctx = await contextOf(options)
		const since = options.seen.length
		await runWriteSecurity(ctx, [invalidBodyRefused])
		expect(options.seen.slice(since).filter((seen) => seen.path === "/login")).toEqual([])
		expect(options.seen.slice(since).filter((seen) => seen.path === "/register")).toHaveLength(1)
	})

	it("never sends to an operation a credential recipe names", async () => {
		const options = optionsFor(
			api([], (_method, path) => (path === "/login" ? { body: { token: "t" }, status: 200 } : undefined)),
			{ security: LOGIN },
		)
		const ctx = await contextOf(options)
		const since = options.seen.length
		await runWriteSecurity(ctx, [invalidBodyRefused])
		expect(options.seen.slice(since).filter((seen) => seen.path === "/login")).toEqual([])
		expect(ctx.state.checksSkipped).toContainEqual({
			check: "request.invalid-body-refused",
			entity: "auth.login",
			needs: "an operation no credential recipe names; auth.login is a step of one",
		})
	})
})

describe("request.invalid-body-refused in the security stage, on an open POST that applied", () => {
	it("reports an open POST that applied the invalid body as a record that may remain", async () => {
		const ctx = await contextOf(
			optionsFor(api([], (_method, path) => (path === "/register" ? { body: {}, status: 201 } : undefined))),
		)
		trackCreates(ctx)
		await runWriteSecurity(ctx, [invalidBodyRefused])
		expect(ctx.ledger.unidentifiedCreates).toMatchObject([
			{ method: "POST", operationId: "auth.register", status: 201 },
		])
		expect(ctx.findings.findings.map((finding) => [finding.check, finding.entity, finding.verdict])).toContainEqual([
			"request.invalid-body-refused",
			"auth.register",
			"BACKEND_BUG",
		])
	})

	it("ledgers what a declared signup made when its answer names a record that reads back", async () => {
		const rows: Record_[] = []
		const registering: Responder = (_method, path) => {
			if (path !== "/notes/register") return undefined
			rows.push({ id: "n9", title: "made by the probe" })
			return { body: { note_id: "n9" }, status: 201 }
		}
		const ctx = await contextOf(optionsFor(api(rows, registering)))
		trackCreates(ctx)
		await runWriteSecurity(ctx, [invalidBodyRefused])
		expect(ctx.ledger.entries().map(({ entity, id, inferred }) => [entity, id, inferred])).toEqual([
			["note", "n9", true],
		])
		expect(ctx.ledger.unidentifiedCreates).toEqual([])
	})
})
