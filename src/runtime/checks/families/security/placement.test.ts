import { describe, expect, it } from "vitest"
import { modelOf } from "../../__fixtures__/harness.ts"
import { placementOf } from "../../core/operation.ts"
import { actorOf, operationContextFor, type SentResponder } from "./__fixtures__/operation-context.ts"
import { runOperationCheck } from "./__fixtures__/run.ts"
import { NOTE_TARGET, securedDoc } from "./__fixtures__/secured-api.ts"
import { alternativeAccepted } from "./auth-alternative-accepted.ts"
import { anonymousOperationOpen } from "./auth-anonymous-operation-open.ts"
import { invalidCredentialRefused } from "./auth-invalid-credential-refused.ts"
import { missingCredentialRefused } from "./auth-missing-credential-refused.ts"
import { scopeEnforced } from "./auth-scope-enforced.ts"
import { wrongSchemeRefused } from "./auth-wrong-scheme-refused.ts"

/*
 * Where the refusal checks' probes run: a collection read before the lanes, a read of one record and
 * a write after them, each of those two on a record the run created.
 */

const project = { in: "path", name: "project_id", required: true, schema: { type: "string" } }
const noteId = { in: "path", name: "note_id", required: true, schema: { type: "string" } }
/* `pins.get` reads one record with jwt alone, so the wrong-scheme check has a scheme to send it. */
const model = modelOf(
	securedDoc({
		"/projects/{project_id}/pins/{note_id}": {
			get: { operationId: "pins.get", parameters: [project, noteId], responses: { "200": { description: "ok" } } },
		},
	}),
)
const PIN_TARGET = { ...NOTE_TARGET, path: "/projects/proj_a/pins/n1" }
/* Each check with a read of one record it probes, and the run-created record it may send to. */
const ITEM_READS = [
	{ check: missingCredentialRefused, operationId: "notes.get", target: NOTE_TARGET },
	{ check: invalidCredentialRefused, operationId: "notes.get", target: NOTE_TARGET },
	{ check: wrongSchemeRefused, operationId: "pins.get", target: PIN_TARGET },
	{ check: scopeEnforced, operationId: "notes.get", target: NOTE_TARGET },
] as const
const REFUSALS = [missingCredentialRefused, invalidCredentialRefused, wrongSchemeRefused, scopeEnforced]
const principals = [actorOf("alpha", { scope: { project_id: "proj_a" } })] as [ReturnType<typeof actorOf>]
const probe = {
	held: (request: { scheme: string; scopes?: readonly string[] }) => ({ value: `${request.scheme}-value` }),
	recipes: { apiKey: { kind: "mint" as const }, jwt: { kind: "login" as const } },
}
const refusing: SentResponder = () => ({ status: 401 })

describe("the refusal checks' placement", () => {
	it("plans a collection read before the lanes, and a read of one record and a write after them", () => {
		for (const check of REFUSALS) {
			expect(check.mutates).toBe(true)
			expect(placementOf(check, model.byOperationId.get("notes.list")!)).toBe("read")
			expect(placementOf(check, model.byOperationId.get("notes.get")!)).toBe("item-read")
			expect(placementOf(check, model.byOperationId.get("notes.update")!)).toBe("write")
		}
	})

	it("sends a read of one record to the run-created record, with no body", async () => {
		for (const { check, operationId, target } of ITEM_READS) {
			const { ctx, sent } = operationContextFor(model, operationId, { principals, probe, respond: refusing, target })
			expect(ctx.placement).toBe("item-read")
			expect(await runOperationCheck(check, ctx)).toEqual({ kind: "asserted" })
			expect(sent.length).toBeGreaterThan(0)
			for (const s of sent) expect([s.method, s.path, s.options.body]).toEqual(["GET", target.path, undefined])
		}
	})

	it("stands a read of one record down, sending nothing, when the run created none", async () => {
		for (const { check, operationId } of ITEM_READS) {
			const { ctx, sent } = operationContextFor(model, operationId, { principals, probe, respond: refusing })
			expect(await runOperationCheck(check, ctx)).toEqual({
				kind: "stood-down",
				reason: `a record this run created that ${operationId} can be sent to`,
			})
			expect(sent).toEqual([])
		}
	})
})

describe("the read-only probes' placement", () => {
	const open = modelOf(
		securedDoc({
			"/projects/{project_id}/boards/{note_id}": {
				get: {
					operationId: "boards.get",
					parameters: [project, noteId],
					responses: { "200": { description: "ok" } },
					security: [],
				},
			},
		}),
	)

	it("sends an alternative's read of one record to the run-created record", async () => {
		const { ctx, sent } = operationContextFor(model, "notes.get", {
			principals,
			respond: () => ({ status: 200 }),
			target: NOTE_TARGET,
		})
		expect(await runOperationCheck(alternativeAccepted, ctx)).toEqual({ kind: "asserted" })
		expect(sent.map((s) => [s.method, s.path])).toEqual([["GET", NOTE_TARGET.path]])
	})

	it("sends an open read of one record to the run-created record", async () => {
		const target = { ...NOTE_TARGET, path: "/projects/proj_a/boards/n1" }
		const { ctx, sent } = operationContextFor(open, "boards.get", {
			principals,
			respond: () => ({ status: 200 }),
			target,
		})
		expect(await runOperationCheck(anonymousOperationOpen, ctx)).toEqual({ kind: "asserted" })
		expect(sent.map((s) => [s.method, s.path])).toEqual([["GET", target.path]])
	})
})
