import { describe, expect, it } from "vitest"
import { modelOf } from "../../__fixtures__/harness.ts"
import { applyingBackend, untouched } from "./__fixtures__/applying.ts"
import { actorOf, operationContextFor, type SentResponder } from "./__fixtures__/operation-context.ts"
import { keyedStage } from "./__fixtures__/keyed-store.ts"
import { runOperationCheck } from "./__fixtures__/run.ts"
import { NOTE_TARGET, securedDoc, undeclaredDoc } from "./__fixtures__/secured-api.ts"
import { flipSignature, GARBAGE, invalidCredentialRefused, isJwt } from "./auth-invalid-credential-refused.ts"

const model = modelOf(securedDoc())
const principals = [actorOf("alpha", { scope: { project_id: "proj_a" } })] as [ReturnType<typeof actorOf>]
const segment = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url")
const JWT = `${segment({ alg: "HS256", typ: "JWT" })}.${segment({ sub: "alpha" })}.Sig-nature_1`
const FLIPPED = `${segment({ alg: "HS256", typ: "JWT" })}.${segment({ sub: "alpha" })}.Aig-nature_1`
const held = { held: (request: { scheme: string }) => ({ value: request.scheme === "jwt" ? JWT : "ak_1" }) }

/* Accepts only a forged value equal to `value`; refuses every other with 401. */
const accepting =
	(value?: string): SentResponder =>
	({ options }) =>
		"forged" in options.as && options.as.forged.value === value ? { status: 200 } : { status: 401 }

describe("auth.invalid-credential-refused", () => {
	it("sends garbage for each scheme, and the actor's JWT with its signature altered, all refused", async () => {
		const { calls, ctx, findings, sent } = operationContextFor(model, "notes.list", {
			principals,
			probe: held,
			respond: accepting(),
		})
		expect(await runOperationCheck(invalidCredentialRefused, ctx)).toEqual({ kind: "asserted" })
		expect(sent.map((s) => [s.path, s.options.as, s.options.probe])).toEqual([
			["/projects/proj_a/notes", { forged: { scheme: "jwt", value: GARBAGE } }, true],
			["/projects/proj_a/notes", { forged: { derived: true, scheme: "jwt", value: FLIPPED } }, true],
			["/projects/proj_a/notes", { forged: { scheme: "apiKey", value: GARBAGE } }, true],
		])
		expect(calls.held).toEqual([
			{ principal: "alpha", scheme: "jwt", scopes: [] },
			{ principal: "alpha", scheme: "apiKey", scopes: ["notes:read"] },
		])
		expect(findings.findings).toEqual([])
	})

	it("reports SECURITY when a JWT with an altered signature is accepted", async () => {
		const { ctx, findings } = operationContextFor(model, "notes.list", {
			principals,
			probe: held,
			respond: accepting(FLIPPED),
		})
		expect(await runOperationCheck(invalidCredentialRefused, ctx)).toEqual({ kind: "finding", verdict: "SECURITY" })
		expect(findings.findings.map((f) => [f.summary, f.detail])).toEqual([
			[
				"a secured operation accepted a JWT whose signature was altered",
				"notes.list answered 200 to alpha's jwt JWT with its signature altered. The document requires jwt, or apiKey with notes:read.",
			],
		])
	})
})

describe("auth.invalid-credential-refused, garbage and writes", () => {
	it("reports SECURITY when a garbage credential is accepted", async () => {
		const { ctx, findings } = operationContextFor(model, "notes.list", { principals, respond: accepting(GARBAGE) })
		expect(await runOperationCheck(invalidCredentialRefused, ctx)).toEqual({ kind: "finding", verdict: "SECURITY" })
		expect(findings.findings.map((f) => f.summary)).toEqual([
			"a secured operation accepted an invalid credential",
			"a secured operation accepted an invalid credential",
		])
		expect(findings.findings[1]?.detail).toContain("answered 200 to an invalid apiKey credential")
	})

	it("sends garbage alone where the actor holds no credential to alter", async () => {
		const { ctx, sent } = operationContextFor(model, "notes.list", { principals, respond: accepting() })
		expect(await runOperationCheck(invalidCredentialRefused, ctx)).toEqual({ kind: "asserted" })
		expect(sent.map((s) => s.options.as)).toEqual([
			{ forged: { scheme: "jwt", value: GARBAGE } },
			{ forged: { scheme: "apiKey", value: GARBAGE } },
		])
	})

	it("probes a write only on the run-created record, with its current state", async () => {
		const backend = applyingBackend()
		const { ctx, sent } = operationContextFor(model, "notes.update", {
			principals,
			probe: held,
			respond: backend.respond,
			target: NOTE_TARGET,
		})
		expect(await runOperationCheck(invalidCredentialRefused, ctx)).toEqual({ kind: "finding", verdict: "SECURITY" })
		expect(new Set(sent.map((s) => s.path))).toEqual(new Set([NOTE_TARGET.path]))
		for (const s of sent) expect(s.options.body).toEqual({ title: "first" })
		expect(backend.records).toEqual(untouched())
	})
})

describe("a JWT and its altered signature", () => {
	it("tells a JWT by its header, and alters the signature's first character", () => {
		expect(isJwt(JWT)).toBe(true)
		expect(isJwt("ak_1")).toBe(false)
		expect(isJwt("a.b.c")).toBe(false)
		expect(isJwt(`${segment({ typ: "JWT" })}.e30.sig`)).toBe(false)
		expect(isJwt(`${segment("HS256")}.e30.sig`)).toBe(false)
		expect(flipSignature(JWT)).toBe(FLIPPED)
		expect(flipSignature(FLIPPED)).toBe(FLIPPED.replace(".Aig", ".Big"))
	})
})

describe("auth.invalid-credential-refused planning", () => {
	it("is mutating, so its write probes run after the lanes", () => {
		expect(invalidCredentialRefused).toMatchObject({ mutates: true, subject: "operation" })
	})

	it("stands down without a single-scheme alternative, on an open operation, and where none is declared", () => {
		const paired = modelOf(
			securedDoc({
				"/pair": {
					get: {
						operationId: "pair",
						responses: { "200": { description: "ok" } },
						security: [{ apiKey: [], jwt: [] }],
					},
				},
			}),
		)
		expect(invalidCredentialRefused.plan(operationContextFor(paired, "pair").ctx)).toEqual({
			needs: "an alternative of one scheme, for a credential to stand in for",
			ok: false,
		})
		expect(invalidCredentialRefused.plan(operationContextFor(model, "gateway.health").ctx)).toEqual({
			needs: "an operation that requires a credential; gateway.health lets anonymous callers in",
			ok: false,
		})
		expect(invalidCredentialRefused.plan(operationContextFor(modelOf(undeclaredDoc()), "notes.list").ctx).ok).toBe(
			false,
		)
	})
})

describe("auth.invalid-credential-refused at teardown", () => {
	it("acquires its key through the store, so revokeAll revokes it, and never calls the mint itself", async () => {
		const { ctx, mintCalls, revoked, sent, store } = keyedStage("notes.list", () => ({ status: 401 }))
		expect(await runOperationCheck(invalidCredentialRefused, ctx)).toEqual({ kind: "asserted" })
		expect(mintCalls().map((call) => call.body)).toEqual([{ scopes: ["notes:read"] }])
		expect(sent.length).toBeGreaterThan(0)
		expect(await store.revokeAll()).toEqual([])
		expect(revoked()).toHaveLength(1)
	})
})
