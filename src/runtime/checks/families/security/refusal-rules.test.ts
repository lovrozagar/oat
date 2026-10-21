import { describe, expect, it } from "vitest"
import { modelOf, type Sent } from "../../__fixtures__/harness.ts"
import type { OperationCheck } from "../../core/check.ts"
import type { WriteTarget } from "../../core/operation-context.ts"
import { actorOf, operationContextFor, type SentResponder } from "./__fixtures__/operation-context.ts"
import { runOperationCheck } from "./__fixtures__/run.ts"
import { NOTE_TARGET, securedDoc } from "./__fixtures__/secured-api.ts"
import { crossTenantKeyRefused } from "./auth-cross-tenant-key-refused.ts"
import { invalidCredentialRefused } from "./auth-invalid-credential-refused.ts"
import { missingCredentialRefused } from "./auth-missing-credential-refused.ts"
import { roleEnforced } from "./auth-role-enforced.ts"
import { scopeEnforced } from "./auth-scope-enforced.ts"
import { wrongSchemeRefused } from "./auth-wrong-scheme-refused.ts"
import { BY_VALIDATION } from "./probing.ts"

/*
 * The rules every refusal check that writes obeys. A write probe's body is the record cut to what the
 * request accepts from any writer, so it never carries a readOnly or x-privileged property a strict
 * API refuses before it judges the caller. And a 400 or 422 is never a pass: only 401 or 403 is, since an API that validates before it
 * authenticates would otherwise hide an unguarded route behind its validation.
 */

const project = { in: "path", name: "project_id", required: true, schema: { type: "string" } }
const noteId = { in: "path", name: "note_id", required: true, schema: { type: "string" } }
const note = {
	properties: {
		id: { readOnly: true, type: "string" },
		title: { type: "string" },
		verified: { type: "boolean", "x-privileged": true },
	},
	type: "object",
}
/* `notes.pin` writes one note with jwt alone, so the wrong-scheme check has a scheme to send it. */
const model = modelOf(
	securedDoc({
		"/projects/{project_id}/notes/{note_id}/pin": {
			put: {
				operationId: "notes.pin",
				parameters: [project, noteId],
				requestBody: { content: { "application/json": { schema: note } }, required: true },
				responses: { "200": { description: "ok" } },
			},
		},
	}),
)
const PIN_TARGET: WriteTarget = { ...NOTE_TARGET, path: "/projects/proj_a/notes/n1/pin" }
const alpha = actorOf("alpha", { rank: 2, scope: { project_id: "proj_a" }, tenant: "proj_a" })
const viewer = actorOf("alpha_viewer", { readOnly: true, scope: { project_id: "proj_a" }, tenant: "proj_a" })
const beta = actorOf("beta", { scope: { project_id: "proj_b" }, tenant: "proj_b" })
const probe = {
	held: (request: { scheme: string }) => ({ value: `${request.scheme}-value` }),
	recipes: { apiKey: { kind: "mint" as const }, jwt: { kind: "login" as const } },
}

/* Each refusal check that writes, with a write it probes and the run-created record it may send to. */
const WRITES: ReadonlyArray<{ check: OperationCheck; operationId: string; target: WriteTarget }> = [
	{ check: missingCredentialRefused, operationId: "notes.update", target: NOTE_TARGET },
	{ check: invalidCredentialRefused, operationId: "notes.update", target: NOTE_TARGET },
	{ check: wrongSchemeRefused, operationId: "notes.pin", target: PIN_TARGET },
	{ check: scopeEnforced, operationId: "notes.update", target: NOTE_TARGET },
	{ check: roleEnforced, operationId: "notes.update", target: NOTE_TARGET },
]

function staged(at: { operationId: string; target?: WriteTarget }, respond: SentResponder) {
	return operationContextFor(model, at.operationId, {
		peer: beta,
		principals: [alpha, viewer, beta],
		probe,
		respond,
		...(at.target === undefined ? {} : { target: at.target }),
	})
}

const writes = (sent: Sent[]) => sent.filter((s) => s.method !== "GET")

/* A backend that checks no credential but validates first: a body with a readOnly id is a 400. */
const validatesFirst: SentResponder = ({ method, options }) => {
	if (method === "GET") return { status: 200 }
	const body = options.body as Record<string, unknown> | undefined
	return body === undefined || "id" in body ? { status: 400 } : { status: 200 }
}

describe("a refusal check's write probe", () => {
	it("sends the record cut to the request's writable properties: never a readOnly one", async () => {
		for (const at of WRITES) {
			const stage = staged(at, () => ({ status: 401 }))
			expect(await runOperationCheck(at.check, stage.ctx)).toEqual({ kind: "asserted" })
			expect(writes(stage.sent).length).toBeGreaterThan(0)
			for (const s of writes(stage.sent)) expect(s.options.body).toEqual({ title: "first" })
		}
		const crossTenant = staged({ operationId: "notes.update", target: NOTE_TARGET }, () => ({ status: 401 }))
		expect((await runOperationCheck(crossTenantKeyRefused, crossTenant.ctx)).kind).toBe("stood-down")
		expect(crossTenant.sent).toEqual([])
	})

	it("carries the record's current value in every field it sends: no refusal probe changes one", async () => {
		const current = { id: "n9", title: "kept", verified: true }
		for (const at of WRITES) {
			const stage = staged({ ...at, target: { ...at.target, current } }, () => ({ status: 401 }))
			await runOperationCheck(at.check, stage.ctx)
			expect(writes(stage.sent).length).toBeGreaterThan(0)
			for (const s of writes(stage.sent)) {
				const body = s.options.body as Record<string, unknown>
				expect(Object.keys(body)).toEqual(["title"])
				for (const [field, value] of Object.entries(body)) expect(value).toEqual(current[field as keyof typeof current])
			}
		}
	})

	it("fails on a backend that skips the credential but validates first", async () => {
		for (const at of WRITES) {
			const stage = staged(at, validatesFirst)
			expect(await runOperationCheck(at.check, stage.ctx)).toEqual({ kind: "finding", verdict: "SECURITY" })
		}
	})
})

describe("a refusal answered by validation", () => {
	it("is inconclusive, never a pass, on a write", async () => {
		for (const status of [400, 422]) {
			for (const at of WRITES) {
				const stage = staged(at, ({ method }) => (method === "GET" ? undefined : { status }))
				const outcome = await runOperationCheck(at.check, stage.ctx)
				expect(outcome.kind).toBe("unresolved")
				expect(outcome).toMatchObject({ reason: expect.stringContaining(BY_VALIDATION) })
				expect(stage.findings.inconclusive.at(-1)?.reason).toContain(`${status}`)
			}
		}
	})

	it("is inconclusive on a read, and for another tenant's key", async () => {
		const read = staged({ operationId: "notes.list" }, () => ({ status: 400 }))
		expect(await runOperationCheck(missingCredentialRefused, read.ctx)).toEqual({
			kind: "unresolved",
			reason: `notes.list answered 400 to a request with no credential: ${BY_VALIDATION}`,
		})
		const crossed = staged({ operationId: "notes.list" }, () => ({ status: 422 }))
		expect(await runOperationCheck(crossTenantKeyRefused, crossed.ctx)).toEqual({
			kind: "unresolved",
			reason: `beta's apiKey key drew 422 under proj_a: ${BY_VALIDATION}`,
		})
	})
})
