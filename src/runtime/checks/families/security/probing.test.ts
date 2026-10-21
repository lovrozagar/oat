import { describe, expect, it } from "vitest"
import { exchange, modelOf } from "../../__fixtures__/harness.ts"
import { actorOf, operationContextFor } from "./__fixtures__/operation-context.ts"
import { NOTE_TARGET, securedDoc, undeclaredDoc } from "./__fixtures__/secured-api.ts"
import {
	addressOf,
	BY_VALIDATION,
	allowsAnonymous,
	declaredPlan,
	describeSecurity,
	documentSchemes,
	judgeRefusals,
	refused,
	scopedAddress,
	securedPlan,
	send,
	singleSchemes,
} from "./probing.ts"

const model = modelOf(securedDoc())
const scoped = [actorOf("alpha", { scope: { project_id: "proj_a" } })] as [ReturnType<typeof actorOf>]

describe("declaredPlan", () => {
	it("stands down where the document declares no security, and passes a declared one on", () => {
		const bare = operationContextFor(modelOf(undeclaredDoc()), "notes.list")
		expect(declaredPlan(bare.ctx)).toEqual({ needs: "the document declares no security; add an overlay", ok: false })
		expect(declaredPlan(operationContextFor(model, "notes.list").ctx)).toEqual({ ok: true, value: undefined })
	})
})

describe("securedPlan", () => {
	it("passes a secured operation on, and stands down on an open or undeclared one", () => {
		expect(securedPlan(operationContextFor(model, "notes.list").ctx)).toEqual({ ok: true, value: undefined })
		expect(securedPlan(operationContextFor(model, "auth.login").ctx)).toEqual({
			needs: "an operation that requires a credential; auth.login lets anonymous callers in",
			ok: false,
		})
		expect(securedPlan(operationContextFor(modelOf(undeclaredDoc()), "notes.list").ctx).ok).toBe(false)
	})
})

describe("addressOf", () => {
	it("sends a collection read under the actor's scope, and stands down when the scope lacks a parameter", () => {
		expect(addressOf(operationContextFor(model, "notes.list", { principals: scoped }).ctx)).toEqual({
			ok: true,
			value: { path: "/projects/proj_a/notes" },
		})
		expect(addressOf(operationContextFor(model, "notes.list").ctx)).toEqual({
			needs: "a value for project_id in notes.list's path",
			ok: false,
		})
		expect(scopedAddress(operationContextFor(model, "notes.get").ctx)).toEqual({
			needs: "a value for project_id and note_id in notes.get's path",
			ok: false,
		})
	})

	it("sends a read of one record to the run-created target, with no body, and never without one", () => {
		const item = operationContextFor(model, "notes.get", { principals: scoped, target: NOTE_TARGET }).ctx
		expect(item.placement).toBe("item-read")
		expect(addressOf(item)).toEqual({ ok: true, value: { path: NOTE_TARGET.path } })
		expect(addressOf(operationContextFor(model, "notes.get", { principals: scoped }).ctx)).toEqual({
			needs: "a record this run created that notes.get can be sent to",
			ok: false,
		})
	})

	it("sends a write to the run-created target, its body the current state cut to the writable properties", () => {
		expect(addressOf(operationContextFor(model, "notes.update", { target: NOTE_TARGET }).ctx)).toEqual({
			ok: true,
			value: { body: { title: "first" }, path: NOTE_TARGET.path },
		})
		expect(addressOf(operationContextFor(model, "notes.delete", { target: NOTE_TARGET }).ctx)).toEqual({
			ok: true,
			value: { path: NOTE_TARGET.path },
		})
		const unread = { ...NOTE_TARGET, current: undefined }
		expect(addressOf(operationContextFor(model, "notes.update", { target: unread }).ctx)).toEqual({
			needs: "the target record's current state, for a harmless body",
			ok: false,
		})
	})

	it("never sends a write without a run-created target", () => {
		expect(addressOf(operationContextFor(model, "notes.update").ctx)).toEqual({
			needs: "a record this run created that notes.update can be sent to",
			ok: false,
		})
	})
})

describe("send", () => {
	it("names the operation, marks a refusal probe, fills required query and sends the body", async () => {
		const withQuery = modelOf(
			securedDoc({
				"/search": {
					get: {
						operationId: "notes.search",
						parameters: [{ in: "query", name: "mode", required: true, schema: { const: "all", type: "string" } }],
						responses: { "200": { description: "ok" } },
					},
				},
			}),
		)
		const { ctx, sent } = operationContextFor(withQuery, "notes.search")
		await send(ctx, { path: "/search" }, { anonymous: true })
		await send(ctx, { body: "{", contentType: "application/json", path: "/search" }, { principal: "alpha" }, "answer")
		expect(sent.map((s) => [s.method, s.path, s.options])).toEqual([
			["GET", "/search", { as: { anonymous: true }, operationId: "notes.search", probe: true, query: { mode: "all" } }],
			[
				"GET",
				"/search",
				{
					as: { principal: "alpha" },
					body: "{",
					contentType: "application/json",
					operationId: "notes.search",
					query: { mode: "all" },
				},
			],
		])
	})

	it("sends no query where none is required", async () => {
		const { ctx, sent } = operationContextFor(model, "gateway.health")
		await send(ctx, { path: "/health" }, { anonymous: true })
		expect(sent[0]?.options).toEqual({ as: { anonymous: true }, operationId: "gateway.health", probe: true })
	})
})

describe("security shapes", () => {
	it("reads anonymous alternatives, single-scheme alternatives and every scheme the document uses", () => {
		const list = operationContextFor(model, "notes.list").ctx.security
		expect(allowsAnonymous(list)).toBe(false)
		expect(allowsAnonymous(operationContextFor(model, "auth.login").ctx.security)).toBe(true)
		const paired = {
			alternatives: [
				[
					{ scheme: "jwt", scopes: [] },
					{ scheme: "apiKey", scopes: [] },
				],
			],
			source: "root",
		}
		expect(singleSchemes(paired as never)).toEqual([])
		const twice = { alternatives: [[{ scheme: "jwt", scopes: [] }], [{ scheme: "jwt", scopes: ["x"] }]] }
		expect(singleSchemes(twice as never)).toEqual([{ scheme: "jwt", scopes: [] }])
		expect(singleSchemes(list)).toEqual([
			{ scheme: "jwt", scopes: [] },
			{ scheme: "apiKey", scopes: ["notes:read"] },
		])
		expect(documentSchemes(model)).toEqual([
			{ scheme: "jwt", scopes: [] },
			{ scheme: "apiKey", scopes: ["notes:read"] },
		])
	})

	it("leaves a scheme the document never declares out of the schemes it uses", () => {
		const ghost = modelOf(
			securedDoc({
				"/ghost": {
					get: { operationId: "ghost", responses: { "200": { description: "ok" } }, security: [{ ghost: [] }] },
				},
			}),
		)
		expect(documentSchemes(ghost).map((r) => r.scheme)).toEqual(["jwt", "apiKey"])
	})

	it("describes a security requirement in words", () => {
		expect(describeSecurity(operationContextFor(model, "notes.list").ctx.security)).toBe(
			"jwt, or apiKey with notes:read",
		)
		const both = {
			alternatives: [
				[
					{ scheme: "jwt", scopes: [] },
					{ scheme: "apiKey", scopes: ["a", "b"] },
				],
				[],
			],
		}
		expect(describeSecurity(both as never)).toBe("jwt and apiKey with a b, or no credential")
	})
})

/* A probe of notes.list that must be refused, answered with `status`. */
const probe = (status: number, sent = "a request with no credential") => ({
	exchange: exchange("GET", "/projects/proj_a/notes", { status }),
	sent,
	summary: "a secured operation answered a request with no credential",
})

describe("judgeRefusals", () => {
	it("passes when every probe is refused with 401 or 403", () => {
		const { ctx, findings } = operationContextFor(model, "notes.list")
		expect(refused(401) && refused(403) && !refused(404)).toBe(true)
		expect(judgeRefusals(ctx, "auth.missing-credential-refused", [probe(401), probe(403)])).toEqual({
			kind: "asserted",
		})
		expect(findings.findings).toEqual([])
	})

	it("reports SECURITY for each probe answered with a success, naming what was sent and what is required", () => {
		const { ctx, findings } = operationContextFor(model, "notes.list")
		const outcome = judgeRefusals(ctx, "auth.missing-credential-refused", [probe(200), probe(401), probe(204, "x")])
		expect(outcome).toEqual({ kind: "finding", verdict: "SECURITY" })
		expect(findings.findings.map((f) => [f.check, f.entity, f.summary, f.detail])).toEqual([
			[
				"auth.missing-credential-refused",
				"notes.list",
				"a secured operation answered a request with no credential",
				"notes.list answered 200 to a request with no credential. The document requires jwt, or apiKey with notes:read.",
			],
			[
				"auth.missing-credential-refused",
				"notes.list",
				"a secured operation answered a request with no credential",
				"notes.list answered 204 to x. The document requires jwt, or apiKey with notes:read.",
			],
		])
		expect(findings.findings[0]?.evidence[0]?.status).toBe(200)
	})

	it("is inconclusive, never a pass, when a probe is refused by validation", () => {
		const { ctx } = operationContextFor(model, "notes.list")
		expect(judgeRefusals(ctx, "auth.missing-credential-refused", [probe(401), probe(422)])).toEqual({
			kind: "unresolved",
			reason: `notes.list answered 422 to a request with no credential: ${BY_VALIDATION}`,
		})
	})

	it("is unresolved when a probe is neither refused nor answered", () => {
		const { ctx, findings } = operationContextFor(model, "notes.list")
		expect(judgeRefusals(ctx, "auth.missing-credential-refused", [probe(401), probe(404)])).toEqual({
			kind: "unresolved",
			reason: "notes.list answered 404 to a request with no credential: neither a refusal nor a success",
		})
		expect(findings.inconclusive).toHaveLength(1)
	})
})
