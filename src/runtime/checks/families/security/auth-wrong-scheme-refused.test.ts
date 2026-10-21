import { describe, expect, it } from "vitest"
import { modelOf } from "../../__fixtures__/harness.ts"
import { applyingBackend, untouched } from "./__fixtures__/applying.ts"
import { actorOf, operationContextFor, type SentResponder } from "./__fixtures__/operation-context.ts"
import { keyedStage } from "./__fixtures__/keyed-store.ts"
import { runOperationCheck } from "./__fixtures__/run.ts"
import { NOTE_TARGET, securedDoc, undeclaredDoc } from "./__fixtures__/secured-api.ts"
import { wrongSchemeRefused } from "./auth-wrong-scheme-refused.ts"

const ok = { "200": { description: "ok" } }
const project = { in: "path", name: "project_id", required: true, schema: { type: "string" } }
const noteId = { in: "path", name: "note_id", required: true, schema: { type: "string" } }
const model = modelOf(
	securedDoc({
		"/me": { get: { operationId: "me.read", responses: ok } },
		"/projects/{project_id}/notes/{note_id}/pin": {
			put: {
				operationId: "notes.pin",
				parameters: [project, noteId],
				requestBody: { content: { "application/json": { schema: { type: "object" } } } },
				responses: ok,
			},
		},
	}),
)
const principals = [actorOf("alpha", { scope: { project_id: "proj_a" } })] as [ReturnType<typeof actorOf>]
const held = { held: (request: { scheme: string }) => ({ value: request.scheme === "jwt" ? "jwt-1" : "ak_1" }) }
const answering =
	(status: number): SentResponder =>
	() => ({ status })

describe("auth.wrong-scheme-refused", () => {
	it("sends the actor's real credential of a scheme the operation does not list, redacted, and passes on a refusal", async () => {
		const { calls, ctx, findings, sent } = operationContextFor(model, "me.read", {
			principals,
			probe: held,
			respond: answering(401),
		})
		expect(await runOperationCheck(wrongSchemeRefused, ctx)).toEqual({ kind: "asserted" })
		expect(calls.held).toEqual([{ principal: "alpha", scheme: "apiKey", scopes: ["notes:read"] }])
		expect(sent.map((s) => [s.method, s.path, s.options])).toEqual([
			[
				"GET",
				"/me",
				{ as: { forged: { derived: true, scheme: "apiKey", value: "ak_1" } }, operationId: "me.read", probe: true },
			],
		])
		expect(findings.findings).toEqual([])
	})

	it("reports SECURITY when the operation accepts a scheme it does not list", async () => {
		const { ctx, findings } = operationContextFor(model, "me.read", {
			principals,
			probe: held,
			respond: answering(200),
		})
		expect(await runOperationCheck(wrongSchemeRefused, ctx)).toEqual({ kind: "finding", verdict: "SECURITY" })
		expect(findings.findings.map((f) => [f.summary, f.detail])).toEqual([
			[
				"an operation accepted a credential of a scheme it does not list",
				"me.read answered 200 to alpha's apiKey credential, a scheme it does not list. The document requires jwt.",
			],
		])
	})

	it("is untested when the actor holds no credential of another scheme", async () => {
		const { ctx, sent } = operationContextFor(model, "me.read", { principals, respond: answering(200) })
		expect(await runOperationCheck(wrongSchemeRefused, ctx)).toEqual({
			kind: "stood-down",
			reason: "no held credential in this test",
		})
		expect(sent).toEqual([])
	})

	it("probes a write only on the run-created record, with its current state", async () => {
		const backend = applyingBackend()
		const target = { ...NOTE_TARGET, path: "/projects/proj_a/notes/n1/pin" }
		const { ctx, sent } = operationContextFor(model, "notes.pin", {
			principals,
			probe: held,
			respond: backend.respond,
			target,
		})
		expect(await runOperationCheck(wrongSchemeRefused, ctx)).toEqual({ kind: "finding", verdict: "SECURITY" })
		expect(sent.map((s) => [s.method, s.path, s.options.body])).toEqual([["PUT", target.path, NOTE_TARGET.current]])
		expect(backend.records).toEqual(untouched())
	})
})

describe("auth.wrong-scheme-refused planning", () => {
	it("is mutating, so its write probes run after the lanes", () => {
		expect(wrongSchemeRefused).toMatchObject({ mutates: true, subject: "operation" })
	})

	it("stands down where the operation lists every scheme, is open, or declares nothing", () => {
		expect(wrongSchemeRefused.plan(operationContextFor(model, "notes.list", { principals }).ctx)).toEqual({
			needs: "a scheme the document uses that notes.list does not list",
			ok: false,
		})
		expect(wrongSchemeRefused.plan(operationContextFor(model, "auth.login").ctx).ok).toBe(false)
		expect(wrongSchemeRefused.plan(operationContextFor(modelOf(undeclaredDoc()), "notes.list").ctx).ok).toBe(false)
	})
})

describe("auth.wrong-scheme-refused at teardown", () => {
	it("acquires its key through the store, so revokeAll revokes it, and never calls the mint itself", async () => {
		const { ctx, mintCalls, revoked, sent, store } = keyedStage("me.read", () => ({ status: 401 }))
		expect(await runOperationCheck(wrongSchemeRefused, ctx)).toEqual({ kind: "asserted" })
		expect(mintCalls().map((call) => call.body)).toEqual([{ scopes: ["notes:read"] }])
		expect(sent.length).toBeGreaterThan(0)
		expect(await store.revokeAll()).toEqual([])
		expect(revoked()).toHaveLength(1)
	})
})
