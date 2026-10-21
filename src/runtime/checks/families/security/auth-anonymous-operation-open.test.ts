import { describe, expect, it } from "vitest"
import { modelOf } from "../../__fixtures__/harness.ts"
import { actorOf, operationContextFor, type SentResponder } from "./__fixtures__/operation-context.ts"
import { runOperationCheck } from "./__fixtures__/run.ts"
import { securedDoc, undeclaredDoc } from "./__fixtures__/secured-api.ts"
import { anonymousOperationOpen, MALFORMED } from "./auth-anonymous-operation-open.ts"

const project = { in: "path", name: "project_id", required: true, schema: { type: "string" } }
const model = modelOf(
	securedDoc({
		"/projects/{project_id}/board": {
			get: {
				operationId: "board.read",
				parameters: [project],
				responses: { "200": { description: "ok" } },
				security: [],
			},
		},
	}),
)
const principals = [actorOf("alpha", { scope: { project_id: "proj_a" } })] as [ReturnType<typeof actorOf>]
const answering =
	(status: number): SentResponder =>
	() => ({ status })

describe("auth.anonymous-operation-open", () => {
	it("reads an open operation with no credential, and passes on anything but a refusal", async () => {
		for (const status of [200, 404, 500]) {
			const { ctx, findings, sent } = operationContextFor(model, "board.read", {
				principals,
				respond: answering(status),
			})
			expect(await runOperationCheck(anonymousOperationOpen, ctx)).toEqual({ kind: "asserted" })
			expect(sent.map((s) => [s.method, s.path, s.options])).toEqual([
				["GET", "/projects/proj_a/board", { as: { anonymous: true }, operationId: "board.read", probe: true }],
			])
			expect(findings.findings).toEqual([])
		}
	})

	it("never sends a real anonymous write: an open write gets a body no server can read", async () => {
		const { ctx, sent } = operationContextFor(model, "auth.login", { respond: answering(400) })
		expect(await runOperationCheck(anonymousOperationOpen, ctx)).toEqual({ kind: "asserted" })
		expect(sent.map((s) => [s.method, s.path, s.options])).toEqual([
			[
				"POST",
				"/auth/login",
				{
					as: { anonymous: true },
					body: MALFORMED,
					contentType: "application/json",
					operationId: "auth.login",
					probe: true,
				},
			],
		])
		expect(() => JSON.parse(MALFORMED)).toThrow("JSON")
	})
	it("reports BACKEND_BUG when an open read demands a credential", async () => {
		const { ctx, findings } = operationContextFor(model, "board.read", { principals, respond: answering(401) })
		expect(await runOperationCheck(anonymousOperationOpen, ctx)).toEqual({ kind: "finding", verdict: "BACKEND_BUG" })
		expect(findings.findings.map((f) => [f.check, f.entity, f.summary, f.detail])).toEqual([
			[
				"auth.anonymous-operation-open",
				"board.read",
				"an operation the document declares open demanded a credential",
				"board.read answered 401 to a request with no credential, though the document declares it open.",
			],
		])
	})

	it("reports BACKEND_BUG when an open write refuses before it reads the body", async () => {
		const { ctx, findings } = operationContextFor(model, "auth.login", { respond: answering(403) })
		expect(await runOperationCheck(anonymousOperationOpen, ctx)).toEqual({ kind: "finding", verdict: "BACKEND_BUG" })
		expect(findings.findings[0]?.detail).toBe(
			"auth.login answered 403 to a request with no credential, though the document declares it open. " +
				"The body was malformed JSON, so the refusal came before the body was read.",
		)
	})
})

describe("auth.anonymous-operation-open on an open write that applied", () => {
	it("reports an open write that accepted the unreadable body: a validation defect, not a security one", async () => {
		for (const status of [200, 201]) {
			const { ctx, findings } = operationContextFor(model, "auth.login", { respond: answering(status) })
			expect(await runOperationCheck(anonymousOperationOpen, ctx)).toEqual({ kind: "finding", verdict: "BACKEND_BUG" })
			expect(findings.findings.map((f) => [f.check, f.verdict, f.summary, f.detail])).toEqual([
				[
					"auth.anonymous-operation-open",
					"BACKEND_BUG",
					"an open write accepted a body it could not have read: a validation defect",
					`auth.login answered ${status} to a body that is not JSON, so it accepted input it could not have ` +
						"read. The route is open, as the document declares; its validation is the defect. The write is " +
						"taken as applied: teardown removes what it made, or reports it as a record that may remain.",
				],
			])
		}
	})
})

describe("auth.anonymous-operation-open planning", () => {
	it("is mutating: it sends writes, if only unreadable ones", () => {
		expect(anonymousOperationOpen).toMatchObject({ mutates: true, subject: "operation" })
	})

	it("plans only an open operation, and leaves a public read to response.public-get-returns-success", () => {
		expect(anonymousOperationOpen.plan(operationContextFor(model, "notes.list").ctx)).toEqual({
			needs: "an operation whose security lets anonymous callers in",
			ok: false,
		})
		expect(anonymousOperationOpen.plan(operationContextFor(model, "gateway.health").ctx)).toEqual({
			needs: "an open operation response.public-get-returns-success does not already read; it grades gateway.health",
			ok: false,
		})
		expect(anonymousOperationOpen.plan(operationContextFor(model, "board.read").ctx)).toEqual({
			needs: "a value for project_id in board.read's path",
			ok: false,
		})
		expect(anonymousOperationOpen.plan(operationContextFor(modelOf(undeclaredDoc()), "gateway.health").ctx)).toEqual({
			needs: "the document declares no security; add an overlay",
			ok: false,
		})
	})
})
