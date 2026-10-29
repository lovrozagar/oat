import { describe, expect, it } from "vitest"
import { UnsatisfiedSecurity } from "../../../../client/credential-source.ts"
import { modelOf, type Sent } from "../../__fixtures__/harness.ts"
import type { Actor } from "../../core/context.ts"
import type { DedicatedCredential, ProbeRequest, WriteTarget } from "../../core/operation-context.ts"
import { applyingBackend, FOREIGN_PATH, untouched } from "./__fixtures__/applying.ts"
import { actorOf, operationContextFor, type SentResponder, sender } from "./__fixtures__/operation-context.ts"
import { runOperationCheck } from "./__fixtures__/run.ts"
import { NOTE_TARGET, securedDoc, undeclaredDoc } from "./__fixtures__/secured-api.ts"
import { privilegedFieldIgnored } from "./auth-privileged-field-ignored.ts"

/* A write by anyone below the highest rank that sets an x-privileged property must not apply it. */

const model = modelOf(securedDoc())
const alpha = actorOf("alpha", { rank: 2, scope: { project_id: "proj_a" }, tenant: "proj_a" })
const member = actorOf("alpha_member", { rank: 1, scope: { project_id: "proj_a" }, tenant: "proj_a" })
const viewer = actorOf("alpha_viewer", { rank: 0, scope: { project_id: "proj_a" }, tenant: "proj_a" })
const TEAM: [Actor, ...Actor[]] = [alpha, viewer, member]

const dedicatedFor = (request: ProbeRequest): DedicatedCredential => ({
	actor: { principal: `${request.principal}#probe-1` },
	owner: request.principal,
	scheme: request.scheme,
	value: "probe",
})

interface Staging {
	respond?: SentResponder
	principals?: [Actor, ...Actor[]]
	target?: WriteTarget | null
	dedicated?: (request: ProbeRequest) => DedicatedCredential | { untested: string }
	doc?: ReturnType<typeof securedDoc>
}

function staged(operationId: string, staging: Staging = {}) {
	const { dedicated = dedicatedFor, doc, principals = TEAM, respond, target = NOTE_TARGET } = staging
	return operationContextFor(doc === undefined ? model : modelOf(doc), operationId, {
		principals,
		probe: { dedicated },
		...(respond === undefined ? {} : { respond }),
		...(target === null ? {} : { target }),
	})
}

/* The member's probe draws `write` and its control write (no marked property) 200; a re-read shows `verified` as `shown`. */
const scripted =
	(write: number, shown: unknown): SentResponder =>
	(sent: Sent) => {
		const probe = typeof sent.options.body === "object" && sent.options.body !== null && "verified" in sent.options.body
		if (sender(sent) === "alpha_member#probe-1")
			return { body: { ...NOTE_TARGET.current, verified: shown }, status: probe ? write : 200 }
		if (sent.method === "GET") return { body: { ...NOTE_TARGET.current, verified: shown }, status: 200 }
		return undefined
	}

/*
 * A role lattice turned over for updates: every write of the ranks in `refused` draws 403, and any other
 * rank's write applies what it sends.
 */
function inverted(refused: readonly string[]): SentResponder {
	let record: Record<string, unknown> = { ...NOTE_TARGET.current }
	return (sent: Sent) => {
		if (sent.method === "GET") return { body: record, status: 200 }
		if (refused.includes(sender(sent) ?? "")) return { status: 403 }
		record = { ...record, ...(sent.options.body as Record<string, unknown>) }
		return { body: record, status: 200 }
	}
}

describe("auth.privileged-field-ignored", () => {
	it("passes when the member's write is refused and its control write is not, sent by a dedicated credential with the field flipped", async () => {
		const stage = staged("notes.update", { respond: scripted(403, false) })
		expect(await runOperationCheck(privilegedFieldIgnored, stage.ctx)).toEqual({ kind: "asserted" })
		expect(stage.calls.dedicated).toEqual([{ principal: "alpha_member", reusable: true, scheme: "jwt", scopes: [] }])
		expect(stage.sent.map((s) => [s.method, s.path, s.options.as, s.options.body, s.options.probe])).toEqual([
			[
				"PATCH",
				NOTE_TARGET.path,
				{ principal: "alpha_member#probe-1", scheme: "jwt" },
				{ title: "first", verified: true },
				true,
			],
			["GET", NOTE_TARGET.path, { principal: "alpha" }, undefined, undefined],
			["PATCH", NOTE_TARGET.path, { principal: "alpha_member#probe-1", scheme: "jwt" }, { title: "first" }, true],
		])
		expect(privilegedFieldIgnored.mutates).toBe(true)
	})

	it("passes on a 400 or a 422 that leaves the field untouched: the verdict is the re-read, not the status", async () => {
		for (const status of [400, 422]) {
			const stage = staged("notes.update", { respond: scripted(status, false) })
			expect(await runOperationCheck(privilegedFieldIgnored, stage.ctx)).toEqual({ kind: "asserted" })
		}
	})

	it("fails on a 200 whose re-read shows the field applied", async () => {
		const stage = staged("notes.update", { respond: scripted(200, true) })
		expect(await runOperationCheck(privilegedFieldIgnored, stage.ctx)).toEqual({ kind: "finding", verdict: "SECURITY" })
		expect(stage.findings.findings[0]?.evidence).toHaveLength(2)
	})

	it("passes when the write succeeds but the owner's read shows the field unchanged", async () => {
		const stage = staged("notes.update", { respond: scripted(200, false) })
		expect(await runOperationCheck(privilegedFieldIgnored, stage.ctx)).toEqual({ kind: "asserted" })
		expect(stage.sent.map((s) => [s.method, s.options.as])).toEqual([
			["PATCH", { principal: "alpha_member#probe-1", scheme: "jwt" }],
			["GET", { principal: "alpha" }],
		])
	})

	it("reports a security finding when the field was applied, touching only the run-created record", async () => {
		const backend = applyingBackend()
		const stage = staged("notes.update", { respond: backend.respond })
		expect(await runOperationCheck(privilegedFieldIgnored, stage.ctx)).toEqual({ kind: "finding", verdict: "SECURITY" })
		expect(stage.findings.findings).toMatchObject([
			{
				check: "auth.privileged-field-ignored",
				detail: expect.stringMatching(/alpha_member \(rank 1\).*verified.*alpha \(rank 2\)/),
				summary: "a write below the highest rank sets an x-privileged property",
			},
		])
		const expected = untouched()
		expected.set(NOTE_TARGET.path, { id: "n1", title: "first", verified: true })
		expect(backend.records).toEqual(expected)
		expect(backend.records.get(FOREIGN_PATH)).toEqual(untouched().get(FOREIGN_PATH))
	})
})

describe("auth.privileged-field-ignored when a writer cannot update at all", () => {
	it("steps down to a rank that can write, and fails when that rank's write applies the field", async () => {
		const stage = staged("notes.update", { respond: inverted(["alpha_member#probe-1"]) })
		expect(await runOperationCheck(privilegedFieldIgnored, stage.ctx)).toEqual({ kind: "finding", verdict: "SECURITY" })
		expect(stage.findings.findings[0]?.detail).toMatch(/alpha_viewer \(rank 0\) wrote verified/)
	})

	it("is unresolved when no rank below the highest can update the record", async () => {
		const stage = staged("notes.update", { respond: inverted(["alpha_member#probe-1", "alpha_viewer#probe-1"]) })
		expect(await runOperationCheck(privilegedFieldIgnored, stage.ctx)).toMatchObject({ kind: "unresolved" })
		expect(stage.findings.inconclusive[0]?.reason).toContain("alpha_viewer")
	})

	it("is unresolved at once when the control write draws a server error, as a probe's would", async () => {
		const stage = staged("notes.update", {
			respond: (sent) => {
				if (sent.method === "GET") return { body: NOTE_TARGET.current, status: 200 }
				return { status: "verified" in (sent.options.body as object) ? 403 : 503 }
			},
		})
		expect(await runOperationCheck(privilegedFieldIgnored, stage.ctx)).toEqual({
			kind: "unresolved",
			reason: "alpha_member's harmless write drew 503, a server error",
		})
		expect(stage.sent.filter((s) => s.method === "PATCH")).toHaveLength(2)
	})

	it("passes on a refusal of the field alone: the same writer's control write is accepted", async () => {
		const stage = staged("notes.update", { respond: scripted(403, false) })
		expect(await runOperationCheck(privilegedFieldIgnored, stage.ctx)).toEqual({ kind: "asserted" })
		expect(stage.sent.map((s) => [s.method, s.options.as, s.options.body])).toEqual([
			["PATCH", { principal: "alpha_member#probe-1", scheme: "jwt" }, { title: "first", verified: true }],
			["GET", { principal: "alpha" }, undefined],
			["PATCH", { principal: "alpha_member#probe-1", scheme: "jwt" }, { title: "first" }],
		])
	})
})

describe("auth.privileged-field-ignored (2)", () => {
	it("stands down with no read on the write's path, and is unresolved on a server error or a failed re-read", async () => {
		const doc = securedDoc()
		const paths = (doc as unknown as { paths: Record<string, Record<string, unknown>> }).paths
		const item = paths["/projects/{project_id}/notes/{note_id}"] as Record<string, unknown>
		delete item["get"]
		expect(await runOperationCheck(privilegedFieldIgnored, staged("notes.update", { doc }).ctx)).toEqual({
			kind: "stood-down",
			reason: "a GET on the write's path, to re-read the record",
		})
		const broken = staged("notes.update", { respond: scripted(503, false) })
		expect(await runOperationCheck(privilegedFieldIgnored, broken.ctx)).toEqual({
			kind: "unresolved",
			reason: "alpha_member's write of verified drew 503, a server error",
		})
		expect(broken.sent).toHaveLength(1)
		const unread = staged("notes.update", {
			respond: (sent) => (sent.method === "GET" ? { status: 500 } : { status: 200 }),
		})
		expect(await runOperationCheck(privilegedFieldIgnored, unread.ctx)).toEqual({
			kind: "unresolved",
			reason: "the record could not be re-read after the write (500), so whether verified changed is unknown",
		})
		const empty = staged("notes.update", {
			respond: (sent) => ({ body: sent.method === "GET" ? "gone" : {}, status: 200 }),
		})
		expect(await runOperationCheck(privilegedFieldIgnored, empty.ctx)).toEqual({
			kind: "unresolved",
			reason: "the record could not be re-read after the write (200), so whether verified changed is unknown",
		})
	})

	it("is untested when no dedicated credential can be had", async () => {
		const stage = staged("notes.update", {
			dedicated: () => ({ untested: "static recipes cannot issue a dedicated credential" }),
		})
		expect(await runOperationCheck(privilegedFieldIgnored, stage.ctx)).toEqual({
			kind: "stood-down",
			reason:
				"jwt: static recipes cannot issue a dedicated credential; apiKey: static recipes cannot issue a dedicated credential",
		})
	})
})

describe("auth.privileged-field-ignored (3)", () => {
	it("stands down without a marker, a target, its state, a value to change, or a lower rank", async () => {
		const unmarked = securedDoc()
		const note = (unmarked as unknown as { paths: Record<string, Record<string, { requestBody: unknown }>> }).paths
		const update = note["/projects/{project_id}/notes/{note_id}"]?.["patch"] as { requestBody: unknown }
		update.requestBody = { content: { "application/json": { schema: { type: "object" } } }, required: true }
		const outcomes = await Promise.all(
			[
				staged("notes.update", { doc: unmarked }),
				staged("notes.delete"),
				staged("notes.update", { target: null }),
				staged("notes.update", { target: { ...NOTE_TARGET, current: "text" } }),
				staged("notes.update", { target: { ...NOTE_TARGET, current: { verified: [] } } }),
				staged("notes.update", { principals: [alpha, actorOf("beta", { rank: 1, tenant: "proj_b" })] }),
				operationContextFor(modelOf(undeclaredDoc()), "notes.update", { principals: TEAM, target: NOTE_TARGET }),
			].map((stage) => runOperationCheck(privilegedFieldIgnored, stage.ctx)),
		)
		expect(outcomes.map((outcome) => ("reason" in outcome ? outcome.reason : outcome.kind))).toEqual([
			"no property is marked x-privileged",
			"a request body property marked x-privileged; notes.delete marks none",
			"a record this run created that notes.update can be sent to",
			"the target record's current state, for a harmless body",
			"a value of verified oat can change",
			"a principal ranked below the highest of the target owner's tenant",
			"the document declares no security; add an overlay",
		])
	})

	it("sets a missing boolean as true, a number one up and a string suffixed", async () => {
		const bodies = []
		for (const current of [{ id: "n1" }, { verified: 3 }, { verified: "x" }]) {
			const stage = staged("notes.update", { respond: scripted(403, false), target: { ...NOTE_TARGET, current } })
			await runOperationCheck(privilegedFieldIgnored, stage.ctx)
			bodies.push(stage.sent[0]?.options.body)
		}
		expect(bodies).toEqual([{ verified: true }, { verified: 4 }, { verified: "x-oat" }])
	})
})

/* A notes API whose read wraps the record in `data`, as the stage's target holds it: already unwrapped. */
function wrappedDoc() {
	const doc = securedDoc()
	const paths = (doc as unknown as { paths: Record<string, Record<string, Record<string, unknown>>> }).paths
	const read = paths["/projects/{project_id}/notes/{note_id}"]?.["get"] as Record<string, unknown>
	read["x-entity"] = { action: "read", name: "note", recordPath: "$.data" }
	return doc
}

describe("auth.privileged-field-ignored behind a record envelope", () => {
	it("fails when a backend that wraps its records applies the field: the target is the record itself", async () => {
		const backend = applyingBackend()
		const wrapping: SentResponder = (sent) => {
			const answer = backend.respond(sent)
			return answer === undefined ? undefined : { ...answer, body: { data: answer.body } }
		}
		const stage = staged("notes.update", { doc: wrappedDoc(), respond: wrapping })
		expect(await runOperationCheck(privilegedFieldIgnored, stage.ctx)).toEqual({ kind: "finding", verdict: "SECURITY" })
		expect(stage.sent[0]?.options.body).toEqual({ title: "first", verified: true })
		expect(stage.findings.findings[0]?.detail).toContain("alpha_member (rank 1) wrote verified")
	})
})

describe("auth.privileged-field-ignored (4)", () => {
	it("sets a nested marked property by its dotted path, and judges it there", async () => {
		const doc = securedDoc()
		const paths = (doc as unknown as { paths: Record<string, Record<string, Record<string, unknown>>> }).paths
		const patch = paths["/projects/{project_id}/notes/{note_id}"]?.["patch"] as Record<string, unknown>
		const meta = { properties: { locked: { type: "boolean", "x-privileged": true } }, type: "object" }
		patch["requestBody"] = {
			content: { "application/json": { schema: { properties: { meta }, type: "object" } } },
			required: true,
		}
		const backend = applyingBackend()
		const current = { id: "n1", meta: { locked: false } }
		backend.records.set(NOTE_TARGET.path, current)
		const stage = staged("notes.update", { doc, respond: backend.respond, target: { ...NOTE_TARGET, current } })
		expect(await runOperationCheck(privilegedFieldIgnored, stage.ctx)).toEqual({ kind: "finding", verdict: "SECURITY" })
		expect(stage.sent[0]?.options.body).toEqual({ meta: { locked: true } })
		const absent = staged("notes.update", {
			doc,
			respond: scripted(403, false),
			target: { ...NOTE_TARGET, current: {} },
		})
		expect(await runOperationCheck(privilegedFieldIgnored, absent.ctx)).toEqual({
			kind: "stood-down",
			reason: "a value of meta.locked oat can change",
		})
	})
	it("skips an alternative of several schemes, and judges the actor's tenant when the owner is no principal", async () => {
		const doc = securedDoc()
		const paths = (doc as unknown as { paths: Record<string, Record<string, Record<string, unknown>>> }).paths
		const patch = paths["/projects/{project_id}/notes/{note_id}"]?.["patch"] as Record<string, unknown>
		patch["security"] = [{ apiKey: ["notes:write"], jwt: [] }, { jwt: [] }]
		const stage = staged("notes.update", {
			doc,
			respond: scripted(403, false),
			target: { ...NOTE_TARGET, owner: "gone" },
		})
		expect(await runOperationCheck(privilegedFieldIgnored, stage.ctx)).toEqual({ kind: "asserted" })
		expect(stage.calls.dedicated).toEqual([{ principal: "alpha_member", reusable: true, scheme: "jwt", scopes: [] }])
	})
})

describe("auth.privileged-field-ignored: a re-read the run cannot send", () => {
	it("tries each alternative, and stands down untested with the reasons when the owner's credential is BLOCKED", async () => {
		const reason = "refresh for alpha/jwt: auth step 1 answered 401"
		const stage = staged("notes.update", {
			respond: (sent) => {
				if (sent.method === "GET") throw new UnsatisfiedSecurity("blocked", reason)
				return { status: 200 }
			},
		})
		const outcome = await runOperationCheck(privilegedFieldIgnored, stage.ctx)
		expect(outcome).toMatchObject({ kind: "stood-down", reason: expect.stringContaining(`: ${reason}`) })
		expect(stage.sent.filter((sent) => sent.method === "PATCH").length).toBeGreaterThan(0)
		expect(stage.findings.findings).toEqual([])
	})
})

describe("auth.privileged-field-ignored on a sign-up", () => {
	const admin = { admin: { type: "boolean" } }
	const register = {
		"/register": {
			post: {
				operationId: "auth.register",
				requestBody: {
					content: {
						"application/json": {
							schema: {
								properties: { ...admin, admin: { type: "boolean", "x-privileged": true }, email: { type: "string" } },
							},
						},
					},
					required: true,
				},
				responses: {
					"201": { content: { "application/json": { schema: { properties: admin } } }, description: "made" },
				},
				security: [],
				"x-fresh-principal": true,
			},
		},
	}

	it("signs an account up with the field set and judges the account, whatever security the document declares", async () => {
		const open = { info: { title: "open", version: "1" }, openapi: "3.1.0", paths: register }
		const stage = operationContextFor(modelOf(open as unknown as ReturnType<typeof securedDoc>), "auth.register", {
			respond: (sent) => (sent.method === "POST" ? { body: { admin: true }, status: 201 } : undefined),
		})
		expect(await runOperationCheck(privilegedFieldIgnored, stage.ctx)).toMatchObject({ kind: "finding" })
		expect(stage.sent.map((sent) => [sent.method, sent.path, sender(sent)])).toEqual([
			["POST", "/register", "anonymous"],
		])
		expect(stage.findings.findings[0]?.summary).toBe(
			"auth.register grants admin, marked x-privileged, to whoever signs up",
		)
	})

	it("passes when the sign-up's answer shows the field unset, and leaves the record writes to the record probe", async () => {
		const stage = staged("auth.register", {
			doc: securedDoc(register),
			respond: (sent) => (sent.method === "POST" ? { body: { admin: false }, status: 201 } : undefined),
		})
		expect(await runOperationCheck(privilegedFieldIgnored, stage.ctx)).toEqual({ kind: "asserted" })
		expect(stage.calls.dedicated).toEqual([])
	})
})
