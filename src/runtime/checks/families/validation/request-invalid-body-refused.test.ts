import { describe, expect, it } from "vitest"
import { modelOf } from "../../__fixtures__/harness.ts"
import { actorOf, operationContextFor, type SentResponder } from "../security/__fixtures__/operation-context.ts"
import { runOperationCheck } from "../security/__fixtures__/run.ts"
import { NOTE_TARGET, securedDoc } from "../security/__fixtures__/secured-api.ts"
import { invalidBodyRefused, SIDE_EFFECT, SIGN_IN } from "./request-invalid-body-refused.ts"

const json = (schema: unknown) => ({ content: { "application/json": { schema } } })
const ok = { "200": { description: "ok", ...json({ type: "object" }) } }
const writes = [{ jwt: [] }, { apiKey: ["notes:write"] }]
const project = { in: "path", name: "project_id", required: true, schema: { type: "string" } }
const noteId = { in: "path", name: "note_id", required: true, schema: { type: "string" } }
const account = {
	properties: { email: { format: "email", type: "string" }, name: { minLength: 2, type: "string" } },
	required: ["email", "name"],
	type: "object",
}
const model = modelOf(
	securedDoc({
		"/projects/{project_id}/notes/archive": {
			post: {
				operationId: "notes.archive",
				parameters: [project],
				requestBody: json({ properties: { before: { type: "string" } }, type: "object" }),
				responses: ok,
				security: writes,
			},
		},
		"/projects/{project_id}/notes/{note_id}/import": {
			post: {
				operationId: "notes.import",
				parameters: [project, noteId],
				requestBody: { content: { "application/x-www-form-urlencoded": { schema: { type: "object" } } } },
				responses: ok,
				security: writes,
			},
		},
		"/projects/{project_id}/notes/{note_id}/share": {
			post: {
				operationId: "notes.share",
				parameters: [project, noteId],
				requestBody: json({
					properties: {
						contacts: { items: { format: "email", type: "string" }, type: "array" },
						email: { format: "email", type: "string" },
						hook: { format: "uri", type: "string" },
						owner: { properties: { email: { format: "email", type: "string" } }, type: "object" },
						title: { type: "string" },
					},
					required: ["title"],
					type: "object",
				}),
				responses: ok,
				security: writes,
			},
		},
		"/register": {
			post: {
				operationId: "auth.register",
				requestBody: json(account),
				responses: ok,
				security: [],
				"x-fresh-principal": true,
			},
		},
		"/scores": {
			post: {
				operationId: "scores.submit",
				requestBody: json({
					properties: { code: { type: "string" }, score: { maximum: 1000, minimum: 0, type: "number" } },
					required: ["code", "score"],
					type: "object",
				}),
				responses: ok,
				security: [],
				"x-fresh-principal": true,
			},
		},
		"/settings": {
			put: { operationId: "settings.replace", requestBody: json(account), responses: ok, security: [] },
		},
		"/tags": {
			post: {
				operationId: "tags.create",
				requestBody: json({
					properties: { label: { maxLength: 1, minLength: 3, type: "string" } },
					required: ["label"],
				}),
				responses: ok,
				security: [],
				"x-fresh-principal": true,
			},
		},
	}),
)
/* The note update over a schema that requires its title, as a document sharing one schema says. */
const merged = modelOf(
	securedDoc({
		"/projects/{project_id}/notes/{note_id}": {
			patch: {
				operationId: "notes.update",
				parameters: [project, noteId],
				requestBody: json({ properties: { title: { type: "string" } }, required: ["title"], type: "object" }),
				responses: ok,
				security: writes,
			},
		},
	}),
)
/* A note replaced whole by PUT, whose only required property is its identity, which the path names. */
const replaced = modelOf(
	securedDoc({
		"/projects/{project_id}/notes/{note_id}": {
			get: { operationId: "notes.get", parameters: [project, noteId], responses: ok, security: writes },
			put: {
				operationId: "notes.replace",
				parameters: [project, noteId],
				requestBody: json({
					properties: { id: { type: "string" }, title: { type: "string" } },
					required: ["id"],
					type: "object",
				}),
				responses: ok,
				security: writes,
			},
		},
	}),
)
const alpha = actorOf("alpha", { scope: { project_id: "proj_a" } })
const answering =
	(status: number): SentResponder =>
	() => ({ status })

/** The note update, staged on the run-created note and answered `status`. */
function noteUpdate(status: number) {
	return operationContextFor(model, "notes.update", {
		principals: [alpha],
		respond: answering(status),
		target: NOTE_TARGET,
	})
}

/** The bodies the open score POST is sent under `seed`. */
async function bodies(seed: number): Promise<unknown[]> {
	const { ctx, sent } = operationContextFor(model, "scores.submit", { respond: answering(400), seed })
	await runOperationCheck(invalidBodyRefused, ctx)
	return sent.map((s) => s.options.body)
}

/** What the check needs to plan `operationId` on the run-created note, or "planned". */
function needs(operationId: string): string | undefined {
	const plan = invalidBodyRefused.plan(operationContextFor(model, operationId, { target: NOTE_TARGET }).ctx)
	return plan.ok ? "planned" : plan.needs
}

describe("request.invalid-body-refused on a record the run created", () => {
	it("fails an update that applies an invalid body: BACKEND_BUG naming what was wrong", async () => {
		const { ctx, findings, sent } = noteUpdate(200)
		expect(await runOperationCheck(invalidBodyRefused, ctx)).toEqual({ kind: "finding", verdict: "BACKEND_BUG" })
		expect(sent.map((s) => [s.method, s.path, s.options])).toEqual([
			[
				"PATCH",
				"/projects/proj_a/notes/n1",
				{
					as: { principal: "alpha" },
					body: { title: 7 },
					contentType: "application/json",
					operationId: "notes.update",
					probe: true,
				},
			],
		])
		expect(findings.findings.map((f) => [f.check, f.entity, f.verdict, f.summary, f.detail])).toEqual([
			[
				"request.invalid-body-refused",
				"notes.update",
				"BACKEND_BUG",
				"a write accepted a body its schema rules out",
				'notes.update answered 200 to a body whose "title" is 7, a type the schema does not allow. ' +
					"A write must refuse invalid input with a 4xx; this one applied what it could parse.",
			],
		])
	})

	it("sends a PATCH the wrong type, never a required property left out: a merge need not resend it", async () => {
		const { ctx, sent } = operationContextFor(merged, "notes.update", { respond: answering(200), target: NOTE_TARGET })
		await runOperationCheck(invalidBodyRefused, ctx)
		expect(sent.map((s) => s.options.body)).toEqual([{ title: 7 }])
	})
})

describe("request.invalid-body-refused's verdicts on a record the run created", () => {
	it("never leaves out the identity a PUT's path names: its body gets the wrong type, and a correct backend passes", async () => {
		const { ctx, sent } = operationContextFor(replaced, "notes.replace", {
			respond: (request) => ({
				status: typeof (request.options.body as { title?: unknown }).title === "string" ? 200 : 422,
			}),
			target: NOTE_TARGET,
		})
		expect(await runOperationCheck(invalidBodyRefused, ctx)).toEqual({ kind: "asserted" })
		expect(sent.map((s) => s.options.body)).toEqual([{ id: "n1", title: 7 }])
	})

	it("passes on 422, and on any other 4xx", async () => {
		for (const status of [422, 400, 403, 404, 409]) {
			const { ctx, findings } = noteUpdate(status)
			expect(await runOperationCheck(invalidBodyRefused, ctx)).toEqual({ kind: "asserted" })
			expect(findings.findings).toEqual([])
		}
	})

	it("fails on a server error: invalid input must be refused, not crash the handler", async () => {
		const { ctx, findings } = noteUpdate(500)
		expect(await runOperationCheck(invalidBodyRefused, ctx)).toEqual({ kind: "finding", verdict: "BACKEND_BUG" })
		expect(findings.findings.map((f) => [f.summary, f.detail])).toEqual([
			[
				"an invalid body drew a server error",
				'notes.update answered 500 to a body whose "title" is 7, a type the schema does not allow. ' +
					"Invalid input must be refused with a 4xx, not crash the handler.",
			],
		])
	})

	it("is unresolved on an answer that neither refuses nor applies", async () => {
		const { ctx, findings } = noteUpdate(302)
		expect(await runOperationCheck(invalidBodyRefused, ctx)).toMatchObject({ kind: "unresolved" })
		expect(findings.inconclusive.map((i) => i.reason)).toEqual([
			"notes.update answered 302 to the invalid body: neither a refusal nor a success",
		])
	})
})

describe("request.invalid-body-refused: where an item write goes", () => {
	it("sends as the record's creator, so a refusal is the body's and not the caller's", async () => {
		const beta = actorOf("beta", { scope: { project_id: "proj_a" } })
		const { ctx, sent } = operationContextFor(model, "notes.update", {
			principals: [alpha, beta],
			respond: answering(422),
			target: { ...NOTE_TARGET, owner: "beta" },
		})
		await runOperationCheck(invalidBodyRefused, ctx)
		expect(sent.map((s) => s.options.as)).toEqual([{ principal: "beta" }])
	})

	it("sends an item write only to a run-created record: none, and it stands down with the stage's reason", async () => {
		const { ctx, sent } = operationContextFor(model, "notes.update", { principals: [alpha], respond: answering(200) })
		expect(await runOperationCheck(invalidBodyRefused, ctx)).toEqual({
			kind: "stood-down",
			reason: "a record this run created that notes.update can be sent to",
		})
		ctx.untargeted = "notes.update's target could not be read back: alpha's credential is BLOCKED (x)"
		expect(invalidBodyRefused.plan(ctx)).toEqual({ needs: ctx.untargeted, ok: false })
		expect(sent).toEqual([])
	})

	it("needs the target's current state for the rest of the body", async () => {
		const { ctx } = operationContextFor(model, "notes.update", {
			principals: [alpha],
			target: { ...NOTE_TARGET, current: undefined },
		})
		expect(invalidBodyRefused.plan(ctx)).toEqual({
			needs: "the target record's current state, for a harmless body",
			ok: false,
		})
	})
})

describe("request.invalid-body-refused on an action of a record", () => {
	it("never holds a deliverable address: every email is one no account holds, every URL an .invalid host", async () => {
		const current = {
			contacts: ["a@example.com"],
			email: "real@example.com",
			hook: "https://hooks.example.com/x",
			id: "n1",
			owner: { email: "owner@example.com" },
			title: "first",
		}
		const { ctx, sent } = operationContextFor(model, "notes.share", {
			principals: [alpha],
			respond: answering(422),
			target: { ...NOTE_TARGET, current },
		})
		await runOperationCheck(invalidBodyRefused, ctx)
		expect(sent.map((s) => s.options.body)).toEqual([
			{
				contacts: ["oat-nonexistent-test@example.invalid"],
				email: "oat-nonexistent-test@example.invalid",
				hook: "https://oat-nonexistent-test.invalid/",
				owner: { email: "oat-nonexistent-test@example.invalid" },
			},
		])
	})

	it("leaves the entity's update as the record holds it: it is no action", async () => {
		const { ctx, sent } = operationContextFor(model, "notes.update", {
			respond: answering(422),
			target: { ...NOTE_TARGET, current: { id: "n1", title: "a@example.com" } },
		})
		await runOperationCheck(invalidBodyRefused, ctx)
		expect(sent.map((s) => s.options.body)).toEqual([{ title: 7 }])
	})
})

describe("request.invalid-body-refused on a collection", () => {
	it("stands down on a write outside a record unless the operation is open to all", async () => {
		const { ctx, sent } = operationContextFor(model, "notes.archive", { principals: [alpha], respond: answering(200) })
		expect(await runOperationCheck(invalidBodyRefused, ctx)).toEqual({ kind: "stood-down", reason: SIDE_EFFECT })
		expect(SIDE_EFFECT).toBe("an action outside a run-created record could apply a side effect the run cannot undo")
		expect(sent).toEqual([])
	})

	it("stands down on an open collection write that is not a POST: no answer could show what it changed", () => {
		const { ctx } = operationContextFor(model, "settings.replace", { principals: [alpha] })
		expect(invalidBodyRefused.plan(ctx)).toEqual({ needs: SIDE_EFFECT, ok: false })
	})

	it("never sends an open POST the document does not mark x-fresh-principal: it could be a sign-in", async () => {
		const { ctx, sent } = operationContextFor(model, "auth.login", { principals: [alpha], respond: answering(201) })
		expect(await runOperationCheck(invalidBodyRefused, ctx)).toEqual({ kind: "stood-down", reason: SIGN_IN })
		expect(SIGN_IN).toBe(
			"an open POST the document marks x-fresh-principal; any other could be a sign-in, where a malformed body can count toward a lockout",
		)
		expect(sent).toEqual([])
	})

	it("sends an open POST anonymously, as a probe, missing its first required property", async () => {
		const { ctx, findings, sent } = operationContextFor(model, "auth.register", {
			principals: [alpha],
			respond: answering(201),
		})
		expect(await runOperationCheck(invalidBodyRefused, ctx)).toEqual({ kind: "finding", verdict: "BACKEND_BUG" })
		const [request] = sent
		expect([request?.method, request?.path, request?.options.as, request?.options.probe]).toEqual([
			"POST",
			"/register",
			{ anonymous: true },
			true,
		])
		expect(Object.keys(request?.options.body as object)).toEqual(["name"])
		expect(findings.findings.map((f) => f.detail)).toEqual([
			'auth.register answered 201 to a body missing the required property "email". A write must refuse ' +
				"invalid input with a 4xx; this one applied what it could parse. The write is taken as applied: " +
				"teardown removes what it made, or reports it as a record that may remain.",
		])
	})

	it("draws the rest of the body under the run seed: the same seed, the same body", async () => {
		expect(await bodies(7)).toEqual(await bodies(7))
		expect(await bodies(7)).toEqual([{ score: 1 }])
		expect(await bodies(8)).toEqual([{ score: 1.1 }])
	})

	it("stands down when no valid body can be drawn to break", () => {
		const { ctx } = operationContextFor(model, "tags.create")
		const plan = invalidBodyRefused.plan(ctx)
		expect(plan.ok).toBe(false)
		expect(plan.ok ? "" : plan.needs).toMatch(/^a valid body for tags\.create to break: /)
	})
})

describe("request.invalid-body-refused planning", () => {
	it("is a mutating operation check", () => {
		expect(invalidBodyRefused).toMatchObject({
			id: "request.invalid-body-refused",
			mutates: true,
			subject: "operation",
		})
	})

	it("never sends to an operation a credential recipe names", async () => {
		const { ctx, sent } = operationContextFor(model, "auth.register", {
			recipeOperations: ["auth.register"],
			respond: answering(201),
		})
		expect(await runOperationCheck(invalidBodyRefused, ctx)).toEqual({
			kind: "stood-down",
			reason: "an operation no credential recipe names; auth.register is a step of one",
		})
		expect(sent).toEqual([])
	})

	it("leaves a create to the validation checks that grade creates", () => {
		const createModel = modelOf(
			securedDoc({
				"/projects/{project_id}/notes": {
					post: { operationId: "notes.create", parameters: [project], requestBody: json(account), responses: ok },
				},
			}),
		)
		expect(invalidBodyRefused.plan(operationContextFor(createModel, "notes.create").ctx)).toEqual({
			needs: "a write other than its entity's create; notes.create is note's create",
			ok: false,
		})
	})

	it("plans only a write that takes a JSON body, with something in its schema to break", () => {
		expect(needs("notes.get")).toBe("a write that takes a JSON request body")
		expect(needs("auth.refresh")).toBe("a write that takes a JSON request body")
		expect(needs("notes.import")).toBe("a write that takes a JSON request body")
		expect(needs("notes.update")).toBe("planned")
	})

	it("needs a request schema with a required or typed property", () => {
		const bare = modelOf(
			securedDoc({
				"/ping": { post: { operationId: "ping.send", requestBody: json({}), responses: ok, security: [] } },
			}),
		)
		expect(invalidBodyRefused.plan(operationContextFor(bare, "ping.send").ctx)).toEqual({
			needs: "a request schema with a required or typed property",
			ok: false,
		})
	})
})
