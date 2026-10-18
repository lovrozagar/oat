import { describe, expect, it } from "vitest"
import { op, type Responder } from "../../__fixtures__/harness.ts"
import { runCheck } from "../../core/run.ts"
import { GATED, type Note, notesContext, notesModel, notesServer, type NotesServer } from "./__fixtures__/notes.ts"
import { uniqueConflictUpdate } from "./update-unique-conflict-rejected.ts"

/*
 * An update that moves a record onto unique values another row holds must be refused with 409,
 * and the refusal must not grow the collection. Each probe writes a record made for it, never a
 * cohort row. Defect: unique-not-enforced-on-update — the colliding PATCH is accepted.
 */

const MODEL = notesModel({ unique: [["name"], ["code"]] })
const SEED: Note = { code: "c0", id: "n0", name: "taken", title: "t" }

type Override = (server: NotesServer) => Responder

/* Whether a PATCH to `path` would give its record another row's name or code. */
function collides(server: NotesServer, path: string, body: Note): boolean {
	const id = path.slice("/notes/".length)
	return [...server.records.values()].some((row) => row.id !== id && (row.name === body.name || row.code === body.code))
}

const enforces: Override = (server) => (method, path, options) =>
	method === "PATCH" && collides(server, path, options.body as Note) ? { status: 409 } : undefined

const answerPatches =
	(answer: { status: number; body?: unknown }): Override =>
	() =>
	(method) =>
		method === "PATCH" ? answer : undefined

/* A 409 that made a row all the same. */
const growsAnyway: Override = (server) => (method) => {
	if (method !== "PATCH") return undefined
	server.respond("POST", "/notes", { body: { name: "stray" } })
	return { status: 409 }
}

function backend(override: Override = enforces, fields = {}) {
	const server = notesServer([{ ...SEED }])
	const first = override(server)
	const respond: Responder = (method, path, options) =>
		first(method, path, options) ?? server.respond(method, path, options)
	const stage = notesContext(MODEL, respond, {
		records: [SEED],
		uniqueSets: [["name"], ["code"]],
		uniqueUpdateOp: op(MODEL, "note.update"),
		...fields,
	})
	return { server, ...stage }
}

const patches = (sent: { method: string; path: string; options: { body?: unknown } }[]) =>
	sent.filter((s) => s.method === "PATCH").map((s) => ({ body: s.options.body, path: s.path }))

/* A create that gives the scratch record the cohort row's name. */
const twin: Override = (server) => (method, path, options) =>
	method === "POST" ? server.respond(method, path, { body: { ...(options.body as Note), name: "taken" } }) : undefined

describe("update.unique-conflict-rejected verdicts", () => {
	it("passes a backend that refuses each colliding update with 409", async () => {
		const { ctx, findings, sent } = backend()
		expect(await runCheck(uniqueConflictUpdate, ctx)).toEqual({ kind: "asserted" })
		expect(findings.findings).toEqual([])
		expect(findings.inconclusive).toEqual([])
		/* Each probe writes its own scratch record, onto one set's values. */
		expect(patches(sent)).toEqual([
			{ body: { name: "taken" }, path: "/notes/n1" },
			{ body: { code: "c0" }, path: "/notes/n2" },
		])
	})

	it("fails a backend that accepts the collision", async () => {
		const { ctx, findings } = backend(() => () => undefined)
		await runCheck(uniqueConflictUpdate, ctx)
		expect(findings.findings.map((f) => f.summary)).toEqual([
			"a duplicate unique-set update was accepted",
			"a duplicate unique-set update was accepted",
		])
		expect(findings.findings[0]?.detail).toContain("PATCH moved a different row onto name values")
	})

	it("fails a 409 that still grew the collection", async () => {
		const { ctx, findings } = backend(growsAnyway)
		await runCheck(uniqueConflictUpdate, ctx)
		expect(findings.findings[0]?.summary).toBe("a unique-conflict 409 still grew the collection")
	})

	it("fails a collision that crashes the handler, and is unresolved for another refusal", async () => {
		const crashed = backend(answerPatches({ status: 500 }))
		await runCheck(uniqueConflictUpdate, crashed.ctx)
		expect(crashed.findings.findings[0]?.summary).toBe("a duplicate unique-set update drew a server error")
		const refused = backend(answerPatches({ status: 403 }))
		expect(await runCheck(uniqueConflictUpdate, refused.ctx)).toEqual({ kind: "asserted" })
		expect(refused.findings.inconclusive[0]?.reason).toBe(
			"unique PATCH for name returned 403, which is not a 409 unique conflict",
		)
	})

	it("records a gap for a feature gate or a plan limit, and reads no list after it", async () => {
		for (const answer of [GATED, { status: 402 }]) {
			const { ctx, findings, sent } = backend(answerPatches(answer))
			await runCheck(uniqueConflictUpdate, ctx)
			expect(findings.findings.map((f) => f.verdict)).toEqual(["COVERAGE_GAP", "COVERAGE_GAP"])
			expect(sent.filter((s) => s.method === "GET" && s.path === "/notes")).toHaveLength(2)
		}
	})
})

describe("update.unique-conflict-rejected growth evidence", () => {
	it("does not judge growth unless both listings cover the collection", async () => {
		for (const refused of [1, 2]) {
			let reads = 0
			const partial: Override = (server) => (method, path, options) =>
				method === "GET" && path === "/notes" && ++reads === refused
					? { status: 500 }
					: growsAnyway(server)(method, path, options)
			const { ctx, findings } = backend(partial, { uniqueSets: [["name"]] })
			await runCheck(uniqueConflictUpdate, ctx)
			expect(findings.findings).toEqual([])
		}
	})
})

describe("update.unique-conflict-rejected without a probe", () => {
	it("ends the check when no record can be made for a probe", async () => {
		const { ctx, sent } = backend(() => (method) => (method === "POST" ? { status: 500 } : undefined))
		expect((await runCheck(uniqueConflictUpdate, ctx)).kind).toBe("unresolved")
		expect(sent.filter((s) => s.method === "POST")).toHaveLength(1)
		expect(patches(sent)).toEqual([])
	})

	it("skips a set the scratch record already shares with the row", async () => {
		const { ctx, sent } = backend(twin, { uniqueSets: [["name"]] })
		expect(await runCheck(uniqueConflictUpdate, ctx)).toEqual({ kind: "asserted" })
		expect(sent.some((s) => s.method === "GET" && s.path === "/notes")).toBe(false)
		expect(patches(sent)).toEqual([])
	})

	it("collides with the cohort row as known when it cannot be read, and skips a value it lacks", async () => {
		const { ctx, sent } = backend(enforces, { readOp: undefined, records: [{ id: "n0", name: "taken" }] })
		await runCheck(uniqueConflictUpdate, ctx)
		expect(patches(sent)).toEqual([{ body: { name: "taken" }, path: "/notes/n1" }])
	})
})

describe("update.unique-conflict-rejected plan", () => {
	it("plans the probeable sets with the first cohort row", () => {
		const planned = uniqueConflictUpdate.plan(backend().ctx)
		expect(planned.ok && planned.value).toMatchObject({ first: SEED, sets: [["name"], ["code"]] })
	})

	it("does not plan without an update, a set, a cohort row, a create, or a set the body can carry", () => {
		const { ctx } = backend()
		expect(uniqueConflictUpdate.plan({ ...ctx, uniqueUpdateOp: undefined }).ok).toBe(false)
		expect(uniqueConflictUpdate.plan({ ...ctx, uniqueSets: [] }).ok).toBe(false)
		expect(uniqueConflictUpdate.plan({ ...ctx, records: [] }).ok).toBe(false)
		expect(uniqueConflictUpdate.plan({ ...ctx, createOp: undefined }).ok).toBe(false)
		expect(uniqueConflictUpdate.plan({ ...ctx, uniqueSets: [["id"]] }).ok).toBe(false)
	})
})
