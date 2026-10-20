import { describe, expect, it } from "vitest"
import type { Answer } from "../checks/__fixtures__/harness.ts"
import { exchangeOf } from "../checks/__fixtures__/harness.ts"
import { confirmDeletes } from "./deletes.ts"
import { doc, ok, pathParam, stage } from "./__fixtures__/stage.ts"

const item = { properties: { deleted_at: { type: "string" }, id: { type: "string" } }, type: "object" }
const CHECK = "delete.absent-record-returns-404"

/* Notes with an item read and delete, a soft-deleting archive, a bin emptied as a whole, and a delete with no read. */
const notes = doc({
	"/notes/{note_id}": {
		delete: {
			operationId: "notes.delete",
			parameters: [pathParam("note_id")],
			responses: { "204": { description: "gone" } },
		},
		get: { operationId: "notes.get", parameters: [pathParam("note_id")], responses: ok(item) },
	},
	"/archive/{note_id}": {
		delete: {
			operationId: "archive.delete",
			parameters: [pathParam("note_id")],
			responses: { "204": { description: "gone" } },
			"x-soft-delete": "deleted_at",
		},
		get: { operationId: "archive.get", parameters: [pathParam("note_id")], responses: ok(item) },
	},
	"/bin": {
		delete: { operationId: "bin.empty", responses: { "204": { description: "gone" } } },
		get: {
			operationId: "bin.list",
			responses: ok({ properties: { items: { items: item, type: "array" } }, type: "object" }),
		},
	},
	"/flat": {
		delete: { operationId: "flat.empty", responses: { "204": { description: "gone" } } },
		get: { operationId: "flat.list", responses: ok({ items: item, type: "array" }) },
	},
	"/orphans/{id}": {
		delete: {
			operationId: "orphans.delete",
			parameters: [pathParam("id")],
			responses: { "204": { description: "gone" } },
		},
	},
})

/** A stage where every delete already answered 204, and reads answer `reads` by path. */
function deleted(reads: Record<string, Answer>, fields: Parameters<typeof stage>[2] = {}) {
	const staged = stage(notes, (method, path) => (method === "GET" ? reads[path] : undefined), fields)
	const done = (operationId: string, path: string) =>
		staged.input.client.transcript.push(
			exchangeOf({ method: "DELETE", options: { as: { principal: "alpha" }, operationId }, path }, { status: 204 }),
		)
	done("notes.delete", "/notes/n1")
	done("archive.delete", "/archive/n2")
	done("bin.empty", "/bin")
	done("flat.empty", "/flat")
	done("orphans.delete", "/orphans/o1")
	return staged
}

describe("confirmDeletes", () => {
	it("proves a delete by a 404, a soft-delete marker or an emptied collection", async () => {
		const { input, sent } = deleted({
			"/archive/n2": { body: { deleted_at: "2026-01-01", id: "n2" }, status: 200 },
			"/bin": { body: { items: [] }, status: 200 },
			"/flat": { body: [], status: 200 },
			"/notes/n1": { status: 404 },
		})
		await confirmDeletes(input)
		expect(sent.map((request) => `${request.method} ${request.path} ${String(request.options.operationId)}`)).toEqual([
			"GET /notes/n1 notes.get",
			"GET /archive/n2 archive.get",
			"GET /bin bin.list",
			"GET /flat flat.list",
		])
		expect(sent.every((request) => JSON.stringify(request.options.as) === '{"principal":"alpha"}')).toBe(true)
		expect(input.grades.evidence.get("notes.delete")?.observation).toMatchObject({ status: 404 })
		expect(input.grades.evidence.get("archive.delete")?.observation).toMatchObject({
			path: "$.deleted_at",
			value: "2026-01-01",
		})
		expect(input.grades.evidence.get("bin.empty")?.observation).toMatchObject({ path: "$.items", value: "[]" })
		expect(input.grades.evidence.get("flat.empty")?.observation).toMatchObject({ path: "$", value: "[]" })
		expect(input.findings.findings).toEqual([])
	})

	it("fails a record still readable, unmarked, and a collection still holding rows", async () => {
		const { input } = deleted({
			"/archive/n2": { body: { deleted_at: null, id: "n2" }, status: 200 },
			"/bin": { body: { items: [{ id: "x" }] }, status: 200 },
			"/flat": { body: "not a list", status: 200 },
			"/notes/n1": { body: { id: "n1" }, status: 200 },
		})
		await confirmDeletes(input)
		expect(input.findings.findings.map((finding) => `${finding.check} ${finding.entity} ${finding.verdict}`)).toEqual([
			`${CHECK} note BACKEND_BUG`,
			`${CHECK} archive BACKEND_BUG`,
			`${CHECK} bin.empty BACKEND_BUG`,
			`${CHECK} flat.empty BACKEND_BUG`,
		])
		expect(input.grades.ran.get("notes.delete")?.has(CHECK)).toBe(true)
	})
})

describe("confirmDeletes on refusals and skips", () => {
	it("says when a refused read shows nothing, and proves a 410", async () => {
		const { input } = deleted({
			"/archive/n2": { status: 410 },
			"/bin": { status: 302 },
			"/flat": { body: null, status: 200 },
			"/notes/n1": { status: 403 },
		})
		await confirmDeletes(input)
		expect(input.findings.inconclusive.map((entry) => entry.reason)).toEqual([
			"notes.get answered 403 when reading /notes/n1 back after notes.delete, so whether the record is gone was not seen",
			"bin.list answered 302 when reading /bin back after bin.empty, so whether the record is gone was not seen",
		])
		expect(input.grades.evidence.get("archive.delete")?.observation).toMatchObject({ status: 410 })
		expect(input.findings.findings.map((finding) => finding.entity)).toEqual(["flat.empty"])
	})

	it("reads back nothing out of scope, already observed, unsent, or off the base URL", async () => {
		const { input, sent } = deleted({}, { inScope: (id) => id !== "flat.empty", mode: "targeted" })
		input.grades.prove("notes.delete", { call: 1, observation: { seq: 2, status: 404 } })
		input.client.transcript.splice(1, 1)
		input.client.transcript.push({
			...exchangeOf(
				{ method: "DELETE", options: { as: { principal: "alpha" }, operationId: "bin.empty" }, path: "/bin" },
				{ status: 204 },
			),
			url: "http://[",
		})
		await confirmDeletes(input)
		expect(sent).toEqual([])
	})

	it("stops once the run stopped", async () => {
		const { input, sent } = deleted({}, { stopped: () => true })
		await confirmDeletes(input)
		expect(sent).toEqual([])
	})
})
