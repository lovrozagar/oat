import { describe, expect, it } from "vitest"
import { modelOf } from "../../__fixtures__/harness.ts"
import { applyingBackend, untouched } from "./__fixtures__/applying.ts"
import { keyedStage } from "./__fixtures__/keyed-store.ts"
import { actorOf, operationContextFor, type SentResponder } from "./__fixtures__/operation-context.ts"
import { runOperationCheck } from "./__fixtures__/run.ts"
import { NOTE_TARGET, securedDoc, undeclaredDoc } from "./__fixtures__/secured-api.ts"
import { scopeEnforced } from "./auth-scope-enforced.ts"

const model = modelOf(securedDoc())
const principals = [actorOf("alpha", { scope: { project_id: "proj_a" } })] as [ReturnType<typeof actorOf>]
const minting = {
	held: (request: { scopes?: readonly string[] }) => ({ value: `ak_${(request.scopes ?? []).join("+") || "bare"}` }),
	recipes: { apiKey: { issue: "apiKey.create", kind: "mint" as const }, jwt: { kind: "login" as const } },
}
const answering =
	(status: number): SentResponder =>
	() => ({ status })
/* Refuses the key issued without a scope, and lets in every other credential. */
const scoping: SentResponder = (sent) => {
	const forged = (sent.options.as as { forged?: { value: string } } | undefined)?.forged
	return { status: forged?.value === "ak_bare" || forged?.value === "k1" ? 403 : 200 }
}

describe("auth.scope-enforced", () => {
	it("passes when the key without the scope is refused and the actor's key with it is let in", async () => {
		const { calls, ctx, findings, sent } = operationContextFor(model, "notes.list", {
			principals,
			probe: minting,
			respond: scoping,
		})
		expect(await runOperationCheck(scopeEnforced, ctx)).toEqual({ kind: "asserted" })
		expect(calls.held).toEqual([
			{ principal: "alpha", scheme: "apiKey", scopes: [] },
			{ principal: "alpha", scheme: "apiKey", scopes: ["notes:read"] },
		])
		expect(calls.dedicated).toEqual([])
		expect(sent.map((s) => [s.path, s.options.as, s.options.probe])).toEqual([
			["/projects/proj_a/notes", { forged: { derived: true, scheme: "apiKey", value: "ak_bare" } }, true],
			["/projects/proj_a/notes", { forged: { derived: true, scheme: "apiKey", value: "ak_notes:read" } }, true],
		])
		expect(findings.findings).toEqual([])
	})

	it("is untested when the key without the scope cannot be had", async () => {
		const { ctx, sent } = operationContextFor(model, "notes.list", {
			principals,
			probe: { recipes: minting.recipes },
			respond: answering(200),
		})
		expect(await runOperationCheck(scopeEnforced, ctx)).toEqual({
			kind: "stood-down",
			reason: "no held credential in this test",
		})
		expect(sent).toEqual([])
	})

	it("probes a write only on the run-created record, with its current state", async () => {
		const backend = applyingBackend()
		const { ctx, sent } = operationContextFor(model, "notes.update", {
			principals,
			probe: minting,
			respond: backend.respond,
			target: NOTE_TARGET,
		})
		expect(await runOperationCheck(scopeEnforced, ctx)).toEqual({ kind: "finding", verdict: "SECURITY" })
		expect(sent.map((s) => [s.method, s.path, s.options.body])).toEqual([
			["PATCH", NOTE_TARGET.path, { title: "first" }],
		])
		expect(backend.records).toEqual(untouched())
	})
})

describe("auth.scope-enforced's control", () => {
	it("is unresolved when the actor's key with the scope is refused too", async () => {
		const { ctx, findings } = operationContextFor(model, "notes.list", {
			principals,
			probe: minting,
			respond: answering(401),
		})
		expect(await runOperationCheck(scopeEnforced, ctx)).toEqual({
			kind: "unresolved",
			reason:
				"notes.list refused alpha's apiKey credential issued with notes:read too (401), " +
				"so the refusal without the scope proves nothing",
		})
		expect(findings.findings).toEqual([])
	})

	it("reports SECURITY when a key without the scope is accepted", async () => {
		const { ctx, findings } = operationContextFor(model, "notes.list", {
			principals,
			probe: minting,
			respond: answering(200),
		})
		expect(await runOperationCheck(scopeEnforced, ctx)).toEqual({ kind: "finding", verdict: "SECURITY" })
		expect(findings.findings.map((f) => [f.summary, f.detail])).toEqual([
			[
				"an operation accepted a credential without the scope it requires",
				"notes.list answered 200 to alpha's apiKey credential issued without notes:read. The document requires jwt, or apiKey with notes:read.",
			],
		])
	})

	it("stands down when the actor's key with the scope cannot be had", async () => {
		const bareOnly = {
			held: (request: { scopes?: readonly string[] }) =>
				(request.scopes ?? []).length === 0 ? { value: "ak_bare" } : { untested: "no key for notes:read" },
			recipes: minting.recipes,
		}
		const { ctx } = operationContextFor(model, "notes.list", { principals, probe: bareOnly, respond: scoping })
		expect(await runOperationCheck(scopeEnforced, ctx)).toEqual({ kind: "stood-down", reason: "no key for notes:read" })
	})
})

/* A stage whose actor's apiKey recipe is `apiKey`. */
const recipes = (apiKey: unknown) => ({ principals, probe: { recipes: { apiKey } as never } })

describe("auth.scope-enforced planning", () => {
	it("is mutating, so its write probes run after the lanes", () => {
		expect(scopeEnforced).toMatchObject({ mutates: true, subject: "operation" })
	})

	it("probes only a scheme whose mint issues a credential for the scopes asked", () => {
		expect(scopeEnforced.plan(operationContextFor(model, "notes.list", recipes({ kind: "login" })).ctx)).toEqual({
			needs: "a mint recipe, which issues a credential for the scopes asked; alpha's apiKey recipe is a login recipe",
			ok: false,
		})
		expect(
			scopeEnforced.plan(operationContextFor(model, "notes.list", recipes({ untested: "no recipe" })).ctx),
		).toEqual({
			needs: "no recipe",
			ok: false,
		})
	})

	it("stands down without a scoped alternative, on an open operation, and where none is declared", () => {
		const jwtOnly = operationContextFor(model, "auth.revoke", { probe: minting })
		expect(scopeEnforced.plan(jwtOnly.ctx)).toEqual({ needs: "an alternative that requires a scope", ok: false })
		expect(scopeEnforced.plan(operationContextFor(model, "auth.login").ctx).ok).toBe(false)
		expect(scopeEnforced.plan(operationContextFor(modelOf(undeclaredDoc()), "notes.list").ctx).ok).toBe(false)
	})
})

describe("auth.scope-enforced at teardown", () => {
	it("mints its key through the store, so revokeAll revokes it, and never calls the mint itself", async () => {
		const { ctx, mintCalls, revoked, sent, store } = keyedStage("notes.list", scoping)
		expect(await runOperationCheck(scopeEnforced, ctx)).toEqual({ kind: "asserted" })
		expect(mintCalls().map((call) => call.body)).toEqual([{ scopes: [] }, { scopes: ["notes:read"] }])
		expect(sent.map((s) => s.options.as)).toEqual([
			{ forged: { derived: true, scheme: "key", value: "k1" } },
			{ forged: { derived: true, scheme: "key", value: "k2" } },
		])
		expect(await store.revokeAll()).toEqual([])
		expect(revoked()).toHaveLength(2)
	})
})
