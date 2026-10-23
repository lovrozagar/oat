import { describe, expect, it } from "vitest"
import type { Responder } from "../../__fixtures__/harness.ts"
import { runCheck } from "../../core/run.ts"
import { GATED, type Note, notesContext, notesModel, notesServer, type NotesServer } from "./__fixtures__/notes.ts"
import { patchMinimality } from "./patch-minimality.ts"

/*
 * PATCH changes the fields it names and nothing else. Defect: patch-acts-as-put — the update
 * replaces the record with the body, dropping every field it did not carry. Fields that move on
 * their own (timestamps, generated fields, a counter that moves between two reads, whatever also
 * moved on an untouched control record) are not the PATCH's doing.
 */

const CONTROL: Note = { code: "c", id: "c1", name: "control", rev: 0, title: "t" }

type Override = (server: NotesServer) => Responder

/** A backend over a notes store holding the control record, `override` answering first. */
function backend(override: Override = () => () => undefined, fields: { records?: Note[] } = {}, model = notesModel()) {
	const server = notesServer([{ ...CONTROL }])
	const first = override(server)
	const respond: Responder = (method, path, options) =>
		first(method, path, options) ?? server.respond(method, path, options)
	return { server, ...notesContext(model, respond, { records: fields.records ?? [CONTROL] }) }
}

/* A PATCH that replaces the record with its body, as PUT would. */
const actsAsPut: Override = (server) => (method, path, options) => {
	if (method !== "PATCH") return undefined
	const id = path.slice("/notes/".length)
	const replaced = { ...(options.body as Note), id }
	server.records.set(id, replaced)
	return { body: replaced, status: 200 }
}

/* Every write bumps `rev` on every record: drift the whole collection shares. */
const revisesAll: Override = (server) => (method, path, options) => {
	if (method === "GET") return undefined
	const answer = server.respond(method, path, options)
	for (const record of server.records.values()) record["rev"] = Number(record["rev"] ?? 0) + 1
	return answer
}

const paths = (sent: { method: string; path: string }[]) => sent.map((s) => `${s.method} ${s.path}`)

/* A record whose view count moves on every read. */
const counting: Override = (server) => (method, path) => {
	const record = server.records.get(path.slice("/notes/".length))
	if (method === "GET" && record !== undefined) record["views"] = Number(record["views"] ?? 0) + 1
	return undefined
}

/* `revisesAll`, and a `tick` the update moves. */
const ticking: Override = (server) => (method, path, options) => {
	const answer = revisesAll(server)(method, path, options)
	const record = server.records.get(path.slice("/notes/".length))
	if (record !== undefined && method === "PATCH") record["tick"] = "moved"
	return answer
}

/* Every write stamps `key` on every record; with no control record nothing else excuses it. */
const stamping =
	(key: string): Override =>
	(server) =>
	(method, path, options) => {
		if (method === "GET") return undefined
		const answer = server.respond(method, path, options)
		for (const record of server.records.values()) record[key] = Number(record[key] ?? 0) + 1
		return answer
	}
const stamped = async (key: string) =>
	(await runCheck(patchMinimality, backend(stamping(key), { records: [] }).ctx)).kind

/* `answer` for the `nth` request of `method` on the scratch record. */
const onTarget =
	(method: string, answer: { status: number; body?: unknown }, nth = 1): Override =>
	() => {
		let seen = 0
		return (m, path) => (m === method && path === "/notes/n1" && ++seen === nth ? answer : undefined)
	}

describe("patch.minimality verdicts", () => {
	it("passes a PATCH that changes only the field it names", async () => {
		const { ctx, findings, sent } = backend()
		expect(await runCheck(patchMinimality, ctx)).toEqual({ kind: "asserted" })
		expect(findings.findings).toEqual([])
		expect(paths(sent)).toEqual([
			"POST /notes",
			"GET /notes/n1",
			"GET /notes/c1",
			"GET /notes/n1",
			"PATCH /notes/n1",
			"GET /notes/n1",
		])
		expect(Object.keys(sent[4]?.options.body as object)).toHaveLength(1)
	})

	it("fails a PATCH that behaves as PUT", async () => {
		const { ctx, findings, sent } = backend(actsAsPut)
		expect(await runCheck(patchMinimality, ctx)).toEqual({ kind: "finding", verdict: "BACKEND_BUG" })
		expect(findings.findings[0]?.summary).toBe("PATCH changed fields the request did not mention")
		expect(findings.findings[0]?.evidence.map((e) => e.method)).toEqual(["GET", "PATCH", "GET"])
		/* The control is read again only once something moved. */
		expect(paths(sent).at(-1)).toBe("GET /notes/c1")
	})

	it("passes when what moved also moved on the untouched control record", async () => {
		const { ctx } = backend(revisesAll, { records: [CONTROL] })
		expect(await runCheck(patchMinimality, ctx)).toEqual({ kind: "asserted" })
	})

	it("keeps what moved when the control cannot be compared", async () => {
		const refuse =
			(at: string, nth: number): Override =>
			(server) => {
				let seen = 0
				const revise = revisesAll(server)
				return (method, path, options) => {
					if (method === "GET" && path === at && ++seen === nth) return { status: 500 }
					return revise(method, path, options)
				}
			}
		const garble: Override = (server) => (method, path, options) =>
			method === "GET" && path === "/notes/c1"
				? { body: "text", status: 200 }
				: revisesAll(server)(method, path, options)
		for (const override of [refuse("/notes/c1", 1), refuse("/notes/c1", 2), garble]) {
			const { ctx } = backend(override)
			expect(await runCheck(patchMinimality, ctx)).toEqual({ kind: "finding", verdict: "BACKEND_BUG" })
		}
		const alone = backend(revisesAll, { records: [] })
		expect(await runCheck(patchMinimality, alone.ctx)).toEqual({ kind: "finding", verdict: "BACKEND_BUG" })
	})
})

describe("patch.minimality fields that move on their own", () => {
	it("ignores a field that moved between two reads with no write between them", async () => {
		const { ctx } = backend(counting, { records: [] })
		expect(await runCheck(patchMinimality, ctx)).toEqual({ kind: "asserted" })
	})

	it("ignores fields either the create or the update declares generated", async () => {
		const model = notesModel({ generated: { create: ["rev"], update: ["tick"] } })
		const { ctx } = backend(ticking, { records: [] }, model)
		expect(await runCheck(patchMinimality, ctx)).toEqual({ kind: "asserted" })
	})

	it.each([
		"updated_at",
		"updatedAt",
		"UpdatedAt",
		"updated-at",
		"modified_at",
		"modifiedAt",
		"lastModified",
		"last_modified",
		"LastModifiedAt",
		"lastUpdated",
		"modified",
		"updated",
	])("ignores the server timestamp %s moving on a write", async (key) => {
		expect(await stamped(key)).toBe("asserted")
	})

	it.each(["createdAt", "updater", "modifiedBy", "rev"])("still reports %s moving on a write", async (key) => {
		expect(await stamped(key)).toBe("finding")
	})

	it("compares against the first read when the second is refused", async () => {
		let reads = 0
		const second: Override = () => (method, path) =>
			method === "GET" && path === "/notes/n1" && ++reads === 2 ? { status: 503 } : undefined
		const { ctx } = backend(second, { records: [] })
		expect(await runCheck(patchMinimality, ctx)).toEqual({ kind: "asserted" })
	})
})

describe("patch.minimality without a verdict", () => {
	it("is unresolved when the record cannot be read back", async () => {
		const refused = backend(onTarget("GET", { status: 404 }))
		expect((await runCheck(patchMinimality, refused.ctx)).kind).toBe("unresolved")
		const empty = backend(onTarget("GET", { body: "text", status: 200 }))
		expect((await runCheck(patchMinimality, empty.ctx)).kind).toBe("unresolved")
		const after = backend(onTarget("GET", { body: "text", status: 200 }, 3))
		expect((await runCheck(patchMinimality, after.ctx)).kind).toBe("unresolved")
	})

	it("is unresolved when no record can be made, or the patch is refused", async () => {
		const unmade = backend(() => (method) => (method === "POST" ? { status: 500 } : undefined))
		expect((await runCheck(patchMinimality, unmade.ctx)).kind).toBe("unresolved")
		const refused = backend(onTarget("PATCH", { status: 409 }))
		expect(await runCheck(patchMinimality, refused.ctx)).toEqual({
			kind: "unresolved",
			reason: "the patch was refused",
		})
	})

	it("stands down on a feature-gated patch", async () => {
		const { ctx } = backend(onTarget("PATCH", GATED))
		expect((await runCheck(patchMinimality, ctx)).kind).toBe("stood-down")
	})

	it("stands down when no field can be patched on its own, and is unresolved with no other value", async () => {
		const bare = backend(onTarget("GET", { body: { id: "n1", size: 1 }, status: 200 }))
		expect(await runCheck(patchMinimality, bare.ctx)).toEqual({
			kind: "stood-down",
			reason: "no field can be patched on its own",
		})
		const unknown = backend(onTarget("GET", { body: { extra: "x", id: "n1" }, status: 200 }))
		const outcome = await runCheck(patchMinimality, unknown.ctx)
		expect(outcome).toEqual({ kind: "unresolved", reason: 'no other valid value for "extra" can be made' })
	})
})

describe("patch.minimality plan", () => {
	it("plans only for a PATCH update with a read and a create", () => {
		const { ctx } = backend()
		expect(patchMinimality.plan(ctx).ok).toBe(true)
		expect(patchMinimality.plan({ ...ctx, updateOp: undefined }).ok).toBe(false)
		expect(patchMinimality.plan({ ...ctx, readOp: undefined }).ok).toBe(false)
		expect(patchMinimality.plan({ ...ctx, createOp: undefined }).ok).toBe(false)
		const put = backend(undefined, {}, notesModel({ updateMethod: "put" })).ctx
		const planned = patchMinimality.plan(put)
		expect(planned.ok ? undefined : planned.needs).toBe("an update by PATCH, which promises a partial write")
	})
})
