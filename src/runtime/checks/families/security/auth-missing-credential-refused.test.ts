import { describe, expect, it } from "vitest"
import { modelOf } from "../../__fixtures__/harness.ts"
import { applyingBackend, FOREIGN_PATH, untouched } from "./__fixtures__/applying.ts"
import { actorOf, operationContextFor, type SentResponder } from "./__fixtures__/operation-context.ts"
import { runOperationCheck as runOn } from "./__fixtures__/run.ts"
import { NOTE_TARGET, securedDoc, undeclaredDoc } from "./__fixtures__/secured-api.ts"
import { missingCredentialRefused } from "./auth-missing-credential-refused.ts"

const model = modelOf(securedDoc())
const principals = [actorOf("alpha", { scope: { project_id: "proj_a" } })] as [ReturnType<typeof actorOf>]

const answering =
	(status: number): SentResponder =>
	() => ({ status })

describe("auth.missing-credential-refused", () => {
	it("passes when a secured read refuses a request with no credential", async () => {
		for (const status of [401, 403]) {
			const { ctx, findings, sent } = operationContextFor(model, "notes.list", {
				principals,
				respond: answering(status),
			})
			expect(await runOn(missingCredentialRefused, ctx)).toEqual({ kind: "asserted" })
			expect(sent.map((s) => [s.method, s.path, s.options])).toEqual([
				["GET", "/projects/proj_a/notes", { as: { anonymous: true }, operationId: "notes.list", probe: true }],
			])
			expect(findings.findings).toEqual([])
		}
	})

	it("reports SECURITY when a secured operation answers with no credential", async () => {
		const { ctx, findings } = operationContextFor(model, "notes.list", { principals, respond: answering(200) })
		expect(await runOn(missingCredentialRefused, ctx)).toEqual({ kind: "finding", verdict: "SECURITY" })
		expect(findings.findings[0]).toMatchObject({
			check: "auth.missing-credential-refused",
			detail:
				"notes.list answered 200 to a request with no credential. The document requires jwt, or apiKey with notes:read.",
			entity: "notes.list",
			summary: "a secured operation answered a request with no credential",
			verdict: "SECURITY",
		})
	})

	it("is unresolved on an answer that is neither a refusal nor a success", async () => {
		const { ctx } = operationContextFor(model, "notes.list", { principals, respond: answering(404) })
		expect((await runOn(missingCredentialRefused, ctx)).kind).toBe("unresolved")
	})

	it("probes a write only on the run-created record, with its current state, so applying it changes nothing", async () => {
		for (const operationId of ["notes.update", "notes.delete"]) {
			const backend = applyingBackend()
			const { ctx, findings, sent } = operationContextFor(model, operationId, {
				principals,
				respond: backend.respond,
				target: NOTE_TARGET,
			})
			expect(await runOn(missingCredentialRefused, ctx)).toEqual({ kind: "finding", verdict: "SECURITY" })
			expect(sent.map((s) => s.path)).toEqual([NOTE_TARGET.path])
			expect(findings.findings).toHaveLength(1)
			const expected = untouched()
			if (operationId === "notes.delete") expected.delete(NOTE_TARGET.path)
			expect(backend.records).toEqual(expected)
			expect(backend.records.get(FOREIGN_PATH)).toEqual(untouched().get(FOREIGN_PATH))
		}
	})
})

describe("auth.missing-credential-refused planning", () => {
	it("is mutating, so its write probes run after the lanes", () => {
		expect(missingCredentialRefused).toMatchObject({ mutates: true, subject: "operation" })
	})

	it("never sends a write without a run-created target", async () => {
		const { ctx, sent } = operationContextFor(model, "notes.update", { principals, respond: answering(200) })
		expect(await runOn(missingCredentialRefused, ctx)).toEqual({
			kind: "stood-down",
			reason: "a record this run created that notes.update can be sent to",
		})
		expect(sent).toEqual([])
	})

	it("plans only where security requires a credential, and stands down where none is declared", () => {
		expect(missingCredentialRefused.plan(operationContextFor(model, "auth.login").ctx)).toEqual({
			needs: "an operation that requires a credential; auth.login lets anonymous callers in",
			ok: false,
		})
		expect(missingCredentialRefused.plan(operationContextFor(modelOf(undeclaredDoc()), "notes.list").ctx)).toEqual({
			needs: "the document declares no security; add an overlay",
			ok: false,
		})
	})
})
