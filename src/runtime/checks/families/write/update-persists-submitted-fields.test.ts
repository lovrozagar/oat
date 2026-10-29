import { describe, expect, it } from "vitest"
import type { Responder } from "../../__fixtures__/harness.ts"
import { modelOf } from "../../__fixtures__/harness.ts"
import { runCheck } from "../../core/run.ts"
import { updateDrops } from "../../payloads/update-drops.ts"
import { type Note, notesContext, notesDocument, notesModel, notesServer } from "./__fixtures__/notes.ts"
import { updatePersistsFields } from "./update-persists-submitted-fields.ts"

/*
 * An update must store what it was sent. One update on a record the check made itself carries a
 * new value for every field the update offers and a read returns; a field neither the update's
 * answer nor a read past the cache holds as sent was dropped, and later checks never pick it.
 */

const SEEDED: Note = { code: "c", id: "c1", name: "seeded", title: "t" }

function backend(override: Responder = () => undefined, model = notesModel()) {
	const server = notesServer([{ ...SEEDED }])
	const respond: Responder = (method, path, options) =>
		override(method, path, options) ?? server.respond(method, path, options)
	return { server, ...notesContext(model, respond, { records: [SEEDED] }) }
}

/* An update that answers 200 and stores everything but `code`. */
function dropping(field: string): (server: ReturnType<typeof notesServer>) => Responder {
	return (server) => (method, path, options) => {
		if (method !== "PATCH") return undefined
		const id = path.slice("/notes/".length)
		const current = server.records.get(id) as Note
		const { [field]: _ignored, ...kept } = options.body as Note
		const next = { ...current, ...kept }
		server.records.set(id, next)
		return { body: { ...next }, status: 200 }
	}
}

/* An update that refuses any body carrying `title`. */
const refuseTitle: Responder = (method, _path, options) =>
	method === "PATCH" && Object.hasOwn(options.body as object, "title") ? { status: 422 } : undefined

const patches = (sent: { method: string; path: string; options: { body?: unknown } }[]) =>
	sent.filter((s) => s.method === "PATCH")

describe("update.persists-submitted-fields", () => {
	it("passes an update that stores every field it was sent, in one request to its own record", async () => {
		const { ctx, findings, sent } = backend()
		expect(await runCheck(updatePersistsFields, ctx)).toEqual({ kind: "asserted" })
		expect(findings.findings).toEqual([])
		expect(patches(sent).map((s) => s.path)).toEqual(["/notes/n1"])
		expect(Object.keys(patches(sent)[0]?.options.body as object).sort()).toEqual(["code", "name", "size", "title"])
		expect([...updateDrops(ctx)]).toEqual([])
	})

	it("reports a field the update answers 200 to and does not store, and remembers it for later checks", async () => {
		const server = notesServer([{ ...SEEDED }])
		const drop = dropping("code")(server)
		const { ctx, findings } = notesContext(
			notesModel(),
			(method, path, options) => drop(method, path, options) ?? server.respond(method, path, options),
			{ records: [SEEDED] },
		)
		expect(await runCheck(updatePersistsFields, ctx)).toEqual({ kind: "finding", verdict: "BACKEND_BUG" })
		expect(findings.findings[0]?.summary).toBe("update silently discards submitted fields")
		expect(findings.findings[0]?.detail).toContain('"code"')
		expect([...updateDrops(ctx)]).toEqual(["code"])
	})

	it("sends each field alone when the whole update is refused, and calls a field refused alone refused, not dropped", async () => {
		const { ctx, findings, sent } = backend(refuseTitle)
		expect(await runCheck(updatePersistsFields, ctx)).toEqual({
			kind: "asserted",
			note: "the update refused title on its own (422); every other field it was sent was stored",
		})
		expect(findings.findings).toEqual([])
		expect(patches(sent)).toHaveLength(5)
	})
})

describe("update.persists-submitted-fields and what it never sends", () => {
	it("never sends a lifecycle field: a status, state, plan or tier enum", async () => {
		const doc = notesDocument() as unknown as {
			components?: unknown
			paths: Record<
				string,
				Record<
					string,
					{ requestBody?: { content: Record<string, { schema: { properties: Record<string, unknown> } }> } }
				>
			>
		}
		const lifecycle = {
			plan: { enum: ["free", "pro"], type: "string" },
			status: { enum: ["active", "suspended"], type: "string" },
		}
		const body = doc.paths["/notes/{id}"]?.["patch"]?.requestBody?.content["application/json"]?.schema
		if (body === undefined) throw new Error("the notes update body moved")
		body.properties = { ...body.properties, ...lifecycle }
		const { ctx, sent } = backend(() => undefined, modelOf(doc as never))
		await runCheck(updatePersistsFields, ctx)
		const keys = Object.keys(patches(sent)[0]?.options.body as object)
		expect(keys).not.toContain("status")
		expect(keys).not.toContain("plan")
	})

	it("cannot run without an update", () => {
		const { ctx } = backend()
		expect(updatePersistsFields.plan({ ...ctx, updateOp: undefined })).toMatchObject({ ok: false })
	})
})
