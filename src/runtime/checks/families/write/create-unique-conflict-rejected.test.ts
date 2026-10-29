import { describe, expect, it } from "vitest"
import { UnsatisfiedSecurity } from "../../../../client/credential-source.ts"
import { FencedError } from "../../../fence.ts"
import { op, type Responder } from "../../__fixtures__/harness.ts"
import { runCheck } from "../../core/run.ts"
import { GATED, type Note, notesContext, notesModel, notesServer, type NotesServer } from "./__fixtures__/notes.ts"
import { uniqueConflictCreate } from "./create-unique-conflict-rejected.ts"

/*
 * A create that repeats a documented unique column set must be refused with 409, and the refusal
 * must not have stored the row anyway. Defect: unique-not-enforced — the duplicate is accepted.
 */

const MODEL = notesModel({ unique: [["name"], ["code"]] })
const SEED: Note = { code: "c0", id: "n0", name: "taken", title: "t" }

type Override = (server: NotesServer) => Responder

/* The unique column a body repeats, if any. */
function repeats(server: NotesServer, body: Note): boolean {
	return [...server.records.values()].some((row) => row["name"] === body["name"] || row["code"] === body["code"])
}

/* A backend that refuses a duplicate with 409, as it should. */
const enforces: Override = (server) => (method, _path, options) =>
	method === "POST" && repeats(server, options.body as Note) ? { status: 409 } : undefined

function backend(override: Override = enforces, fields = {}) {
	const server = notesServer([{ ...SEED }])
	const first = override(server)
	const respond: Responder = (method, path, options) =>
		first(method, path, options) ?? server.respond(method, path, options)
	const stage = notesContext(MODEL, respond, {
		records: [SEED],
		uniqueCreateOp: op(MODEL, "note.create"),
		uniqueSets: [["name"], ["code"]],
		...fields,
	})
	return { server, ...stage }
}

const posts = (sent: { method: string; options: { body?: unknown } }[]) =>
	sent.filter((s) => s.method === "POST").map((s) => s.options.body as Note)

const answerPosts =
	(answer: { status: number; body?: unknown }): Override =>
	() =>
	(method) =>
		method === "POST" ? answer : undefined

/* A 409 that stored the row all the same. */
const storesAnyway: Override = (server) => (method, path, options) => {
	if (method !== "POST") return undefined
	server.respond(method, path, options)
	return { status: 409 }
}

/* A 409, while another lane's entity adds a row of its own to the same collection: it grows, nothing collides. */
const elsewhere: Override = (server) => (method, path, options) => {
	if (method !== "POST" || !repeats(server, options.body as Note)) return undefined
	server.respond("POST", path, { body: { code: "other", name: "other", title: "t" } })
	return { status: 409 }
}

/* A backend whose deletes throw `error`. */
const failing =
	(error: Error): Override =>
	(server) =>
	(method, path, options) => {
		if (method === "DELETE") throw error
		return server.respond(method, path, options)
	}

describe("create.unique-conflict-rejected verdicts", () => {
	it("passes a backend that refuses each duplicate set with 409", async () => {
		const { ctx, findings, sent, server } = backend()
		expect(await runCheck(uniqueConflictCreate, ctx)).toEqual({ kind: "asserted" })
		expect(findings.findings).toEqual([])
		expect(findings.inconclusive).toEqual([])
		const [byName, byCode] = posts(sent)
		/* Each probe collides on its own set and no other. */
		expect(byName?.["name"]).toBe("taken")
		expect(byName?.["code"]).not.toBe("c0")
		expect(byCode?.["code"]).toBe("c0")
		expect(byCode?.["name"]).not.toBe("taken")
		expect(server.records.size).toBe(1)
	})

	it("fails a backend that accepts a duplicate, and removes what it made", async () => {
		const { ctx, findings, sent } = backend(() => () => undefined)
		expect(await runCheck(uniqueConflictCreate, ctx)).toEqual({ kind: "asserted" })
		expect(findings.findings.map((f) => f.summary)).toEqual([
			"a duplicate unique-set create was accepted",
			"a duplicate unique-set create was accepted",
		])
		expect(findings.findings[0]?.verdict).toBe("BACKEND_BUG")
		expect(sent.filter((s) => s.method === "DELETE").map((s) => s.path)).toEqual(["/notes/n1", "/notes/n2"])
	})

	it("fails a 409 that still stored the row", async () => {
		const { ctx, findings } = backend(storesAnyway)
		await runCheck(uniqueConflictCreate, ctx)
		expect(findings.findings[0]?.summary).toBe("a unique-conflict 409 still grew the collection")
		expect(findings.findings[0]?.detail).toContain("grew from 1 to 2")
	})
})

describe("create.unique-conflict-rejected other answers", () => {
	it("passes a 409 while another writer adds a row of its own between the two listings", async () => {
		const { ctx, findings } = backend(elsewhere)
		expect(await runCheck(uniqueConflictCreate, ctx)).toEqual({ kind: "asserted" })
		expect(findings.findings).toEqual([])
	})

	it("fails a duplicate that crashes the handler", async () => {
		const { ctx, findings } = backend(answerPosts({ status: 500 }))
		await runCheck(uniqueConflictCreate, ctx)
		expect(findings.findings[0]?.summary).toBe("a duplicate unique-set create drew a server error")
	})

	it("is unresolved for a refusal that is not a unique conflict", async () => {
		const { ctx, findings } = backend(answerPosts({ status: 403 }))
		expect(await runCheck(uniqueConflictCreate, ctx)).toEqual({ kind: "asserted" })
		expect(findings.inconclusive[0]?.reason).toBe(
			"unique probe for name returned 403, which is not a 409 unique conflict",
		)
	})

	it("records a gap for a feature gate or a plan limit, and reads no list after it", async () => {
		for (const answer of [GATED, { status: 402 }]) {
			const { ctx, findings, sent } = backend(answerPosts(answer))
			await runCheck(uniqueConflictCreate, ctx)
			expect(findings.findings.map((f) => f.verdict)).toEqual(["COVERAGE_GAP", "COVERAGE_GAP"])
			expect(sent.filter((s) => s.method === "GET" && s.path === "/notes")).toHaveLength(1)
		}
	})
})

describe("create.unique-conflict-rejected growth evidence", () => {
	it("does not judge growth when either listing is incomplete", async () => {
		const crowd = Array.from({ length: 500 }, (_, index) => ({ id: `x${index}` }))
		let reads = 0
		const first: Override = (server) => (method, path, options) =>
			method === "GET" && path === "/notes" && ++reads === 1
				? { body: crowd, status: 200 }
				: storesAnyway(server)(method, path, options)
		const later: Override = (server) => (method, path, options) =>
			method === "GET" && path === "/notes" && reads++ > 0
				? { status: 500 }
				: storesAnyway(server)(method, path, options)
		for (const override of [first, later]) {
			reads = 0
			const { ctx, findings } = backend(override)
			await runCheck(uniqueConflictCreate, ctx)
			expect(findings.findings).toEqual([])
		}
	})
})

describe("create.unique-conflict-rejected collisions", () => {
	it("collides on the cohort row when its live read fails, and skips a set it holds no value for", async () => {
		const { ctx, sent } = backend(enforces, { readOp: undefined, records: [{ id: "n0", name: "taken" }] })
		await runCheck(uniqueConflictCreate, ctx)
		expect(posts(sent).map((body) => body["name"])).toEqual(["taken"])
		expect(sent.some((s) => s.path === "/notes/n0")).toBe(false)
	})

	it("tears an accepted duplicate down through the model's delete, or leaves it when there is none", async () => {
		const viaModel = backend(() => () => undefined, { deleteOp: undefined })
		await runCheck(uniqueConflictCreate, viaModel.ctx)
		expect(viaModel.sent.filter((s) => s.method === "DELETE")).toHaveLength(2)
		const unknown = backend(() => () => undefined, { deleteOp: undefined, entityName: "ghost" })
		await runCheck(uniqueConflictCreate, unknown.ctx)
		expect(unknown.sent.filter((s) => s.method === "DELETE")).toEqual([])
	})

	it("cannot tear down a duplicate whose id it cannot read", async () => {
		for (const fields of [{ createOp: undefined }, {}]) {
			const blank = Object.keys(fields).length === 0
			const { ctx, sent, findings } = backend(blank ? answerPosts({ status: 201 }) : () => () => undefined, fields)
			await runCheck(uniqueConflictCreate, ctx)
			expect(sent.filter((s) => s.method === "DELETE")).toEqual([])
			expect(findings.findings[0]?.summary).toBe("a duplicate unique-set create was accepted")
		}
	})

	it("passes a teardown whose security cannot be met on, so the check is untested with the reason", async () => {
		const unsatisfied = new UnsatisfiedSecurity("unsatisfied", "no credential for jwt")
		const { ctx } = backend(failing(unsatisfied))
		await expect(runCheck(uniqueConflictCreate, ctx)).rejects.toBe(unsatisfied)
	})

	it("swallows a failed teardown but not a fenced one", async () => {
		const { ctx, findings } = backend(failing(new Error("reset")))
		await runCheck(uniqueConflictCreate, ctx)
		expect(findings.findings).toHaveLength(2)
		const fenced = new FencedError({ method: "DELETE", phase: "check", reason: "fenced", url: "/notes/n1" })
		const stage = backend(failing(fenced))
		await expect(runCheck(uniqueConflictCreate, stage.ctx)).rejects.toBe(fenced)
	})
})

describe("create.unique-conflict-rejected plan", () => {
	it("plans the probeable sets with the first cohort row", () => {
		const planned = uniqueConflictCreate.plan(backend().ctx)
		expect(planned.ok && planned.value.sets).toEqual([["name"], ["code"]])
		expect(planned.ok && planned.value.first).toEqual(SEED)
	})

	it("does not plan without a create, a set, a cohort row, or a set the body can carry", () => {
		const { ctx } = backend()
		expect(uniqueConflictCreate.plan({ ...ctx, uniqueCreateOp: undefined }).ok).toBe(false)
		expect(uniqueConflictCreate.plan({ ...ctx, uniqueSets: [] }).ok).toBe(false)
		expect(uniqueConflictCreate.plan({ ...ctx, records: [] }).ok).toBe(false)
		expect(uniqueConflictCreate.plan({ ...ctx, uniqueSets: [["id"]] }).ok).toBe(false)
		const bodiless = notesModel({ createWithoutBody: true, unique: [["name"]] })
		expect(uniqueConflictCreate.plan({ ...ctx, model: bodiless, uniqueCreateOp: op(bodiless, "note.create") }).ok).toBe(
			false,
		)
	})
})
