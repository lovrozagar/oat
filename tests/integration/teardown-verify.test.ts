import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { afterEach, describe, expect, it } from "vitest"
import type { Hooks, Scenario } from "../../src/config/define-config.ts"
import { configProblems } from "../../src/config/validate.ts"
import { leftBehind } from "../../src/conformance/leaks.ts"
import { PRINCIPALS } from "../../src/conformance/matrix/principals.ts"
import { createMemoryServer } from "../../src/reference/http/engines.ts"
import { run } from "../../src/runtime/run/index.ts"
import { Client } from "../../src/client/client.ts"
import { listedIds } from "../../src/runtime/proven-id.ts"
import { Ledger, NEVER_SEEN, type Owner, VERIFY_HOOK_PRESENT } from "../../src/runtime/teardown.ts"
import { buildModel } from "../../src/spec/graph/build.ts"
import { dereference } from "../../src/spec/load/dereference.ts"
import type { OpenApiDocument } from "../../src/spec/types.ts"
import { Redactor } from "../../src/security/redact.ts"

/*
 * A delete that answers 2xx proves only that the backend said so. After the unwind oat reads each
 * list once more: a record still listed is a leftover, named with why, so nobody believes a shared
 * backend is clean when it is not. It is a fact about teardown, not a finding — the checks already
 * judge whether delete removes a record.
 */

const STILL_LISTED = "delete answered 2xx but the record is still listed"

async function runAgainst(defects: string[], extra: Record<string, unknown> = {}) {
	const server = await createMemoryServer({ defects })
	try {
		return await run({
			baseUrl: server.url,
			principals: PRINCIPALS,
			seed: 42,
			spec: `${server.url}/v1/openapi/spec`,
			...extra,
		})
	} finally {
		await server.close()
	}
}

describe("teardown verification", () => {
	it("names each record a 2xx delete left in place", async () => {
		const result = await runAgainst(["DELETE_KEEPS_ROW"])
		const kept = result.teardown?.failed.filter((leftover) => leftover.reason === STILL_LISTED) ?? []
		expect(kept.length).toBeGreaterThan(0)
		for (const leftover of kept) {
			expect(result.teardown?.records).toContainEqual({
				entity: leftover.entity,
				id: leftover.id,
				principal: leftover.principal,
				removed: false,
			})
		}
	}, 240_000)

	it("reports nothing when every delete removed its record", async () => {
		const result = await runAgainst([])
		expect(result.teardown?.failed.filter((leftover) => leftover.reason === STILL_LISTED)).toEqual([])
	}, 240_000)

	it("names a row the backend hides from its own creator, which nothing else can", async () => {
		const server = await createMemoryServer({ defects: ["HIDDEN_FROM_CREATOR"] })
		try {
			const before = await server.snapshot()
			const result = await run({
				baseUrl: server.url,
				principals: PRINCIPALS,
				seed: 42,
				spec: `${server.url}/v1/openapi/spec`,
			})
			const leaked = leftBehind(before, await server.snapshot())
			expect(leaked.length).toBeGreaterThan(0)
			const named = (result.teardown?.failed ?? []).filter((failure) => failure.reason === NEVER_SEEN)
			expect(leaked.toSorted()).toEqual(named.map((failure) => `${failure.entity} ${failure.id}`).toSorted())
		} finally {
			await server.close()
		}
	}, 240_000)

	it("does not read the lists again when told not to", async () => {
		const result = await runAgainst(["DELETE_KEEPS_ROW"], { teardown: { verify: false } })
		expect(result.teardown?.failed.filter((leftover) => leftover.reason === STILL_LISTED)).toEqual([])
	}, 240_000)
})

/*
 * A delete that answers 2xx and a list that no longer shows the record prove nothing when the
 * creator could never see the record in the first place. Teardown reads back once any record its
 * creator never saw; one still unseen is named as a leftover, unless an ancestor was removed
 * earlier in the run. `hooks.verifyRemoved` can settle what HTTP cannot.
 */

const json = (schema: unknown) => ({ content: { "application/json": { schema } } })
const ITEM = { properties: { id: { readOnly: true, type: "string" }, text: { type: "string" } }, type: "object" }
const WRITE = {
	...json({ properties: { text: { type: "string" } }, required: ["text"], type: "object" }),
	required: true,
}
const LIST = json({ properties: { items: { items: ITEM, type: "array" } }, type: "object" })
const param = (name: string) => ({ in: "path", name, required: true, schema: { type: "string" } })
const tagged = (name: string, action: string, extra: Record<string, unknown>) => ({
	operationId: `${name}.${action}`,
	"x-entity": { action, name },
	...extra,
})
const resource = (name: string, parents: unknown[], id: string) => ({
	collection: {
		get: tagged(name, "list", { parameters: parents, responses: { "200": { ...LIST, description: "ok" } } }),
		post: tagged(name, "create", {
			parameters: parents,
			requestBody: WRITE,
			responses: { "201": { ...json(ITEM), description: "created" } },
		}),
	},
	item: {
		delete: tagged(name, "delete", {
			parameters: [...parents, param(id)],
			responses: { "204": { description: "gone" } },
		}),
		get: tagged(name, "read", {
			parameters: [...parents, param(id)],
			responses: { "200": { ...json(ITEM), description: "ok" }, "404": { description: "missing" } },
		}),
	},
})
const FOLDERS = resource("folder", [], "folder_id")
const NOTES = resource("note", [param("folder_id")], "note_id")
const HIDDEN_SPEC = {
	info: { title: "hidden-records", version: "1" },
	openapi: "3.1.0",
	paths: {
		"/folders": FOLDERS.collection,
		"/folders/{folder_id}": FOLDERS.item,
		"/folders/{folder_id}/notes": NOTES.collection,
		"/folders/{folder_id}/notes/{note_id}": NOTES.item,
	},
} as unknown as OpenApiDocument

function reply(res: ServerResponse, status: number, body?: unknown): void {
	res.writeHead(status, body === undefined ? {} : { "content-type": "application/json" })
	res.end(body === undefined ? "" : JSON.stringify(body))
}

function bodyOf(req: IncomingMessage): Promise<Record<string, unknown>> {
	return new Promise((resolve) => {
		let text = ""
		req.on("data", (chunk: Buffer) => {
			text += chunk.toString()
		})
		req.on("end", () => {
			try {
				resolve((JSON.parse(text || "{}") as Record<string, unknown>) ?? {})
			} catch {
				resolve({})
			}
		})
	})
}

interface Note {
	id: string
	folder: string
	text: string
}

const closers: Array<() => Promise<void>> = []
afterEach(async () => {
	await Promise.all(closers.splice(0).map((close) => close()))
})

/* A note whose text holds HIDE is never served and outlives its delete; UNLISTED is never listed. */
async function serveHidden() {
	const folders = new Map<string, { id: string; text: string }>()
	const notes = new Map<string, Note>()
	let seq = 0
	const hidden = (note: Note) => note.text.includes("HIDE")
	const server = createServer((req, res) => {
		void (async () => {
			const parts = new URL(req.url ?? "/", "http://x").pathname.split("/").filter(Boolean)
			const method = req.method ?? "GET"
			if (parts[0] === "openapi.json") return reply(res, 200, HIDDEN_SPEC)
			if (parts[0] !== "folders") return reply(res, 404, {})
			if (parts.length === 1) {
				if (method === "GET") return reply(res, 200, { items: [...folders.values()] })
				const folder = { id: `f${++seq}`, text: String((await bodyOf(req)).text ?? "") }
				folders.set(folder.id, folder)
				return reply(res, 201, folder)
			}
			const folder = folders.get(parts[1] ?? "")
			if (folder === undefined) return reply(res, 404, {})
			if (parts.length === 2) {
				if (method === "GET") return reply(res, 200, folder)
				folders.delete(folder.id)
				/* A hidden note outlives its folder too: nothing a client does reaches it. */
				for (const note of notes.values()) if (note.folder === folder.id && !hidden(note)) notes.delete(note.id)
				return reply(res, 204)
			}
			const inFolder = [...notes.values()].filter((note) => note.folder === folder.id)
			if (parts.length === 3) {
				if (method === "GET") {
					const shown = inFolder.filter((note) => !hidden(note) && !note.text.includes("UNLISTED"))
					return reply(res, 200, { items: shown.map(({ id, text }) => ({ id, text })) })
				}
				const note = { folder: folder.id, id: `n${++seq}`, text: String((await bodyOf(req)).text ?? "") }
				notes.set(note.id, note)
				return reply(res, 201, { id: note.id, text: note.text })
			}
			const note = inFolder.find((candidate) => candidate.id === parts[3])
			if (note === undefined || (method === "GET" && hidden(note))) return reply(res, 404, {})
			if (method === "GET") return reply(res, 200, { id: note.id, text: note.text })
			/* Answers success, and keeps a hidden note. */
			if (!hidden(note)) notes.delete(note.id)
			return reply(res, 200, { id: note.id })
		})()
	})
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
	closers.push(() => new Promise((resolve) => server.close(() => resolve())))
	return { folders, notes, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }
}

/* A folder, and in it one note with `text`, made by a scenario; `drop` removes the folder too. */
function scenario(text: string, drop = false): Scenario {
	return {
		covers: ["note.create"],
		id: "a-note",
		steps: [
			{ body: { text: "box" }, operationId: "folder.create", saveAs: { folder_id: "$.id" } },
			{ body: { text }, operationId: "note.create", saveAs: { note_id: "$.id" } },
			...(drop ? [{ operationId: "folder.delete" }] : []),
		],
	}
}

async function runHidden(text: string, options: { drop?: boolean; hooks?: Hooks } = {}) {
	const backend = await serveHidden()
	const result = await run({
		baseUrl: backend.url,
		...(options.hooks === undefined ? {} : { hooks: options.hooks }),
		principals: [{ id: "alpha" }],
		scenarios: [scenario(text, options.drop)],
		seed: 1,
		spec: `${backend.url}/openapi.json`,
	})
	const made = result.client.transcript.find(
		(exchange) => exchange.check === undefined && exchange.operationId === "note.create" && exchange.status === 201,
	)
	const id = (made?.responseBody as { id?: string } | undefined)?.id ?? ""
	return { ...backend, id, result }
}

describe("a record its creator never saw", () => {
	it("is named as left behind when it stays unseen, whatever its delete answered", async () => {
		const { id, notes, result } = await runHidden("HIDE me")
		expect(notes.has(id)).toBe(true)
		expect(result.teardown?.failed).toContainEqual(expect.objectContaining({ entity: "note", id, reason: NEVER_SEEN }))
		expect(result.teardown?.records).toContainEqual(expect.objectContaining({ entity: "note", id, removed: false }))
	}, 120_000)

	it("makes no claim once teardown's own read finds it", async () => {
		const { id, notes, result } = await runHidden("UNLISTED me")
		const readBack = result.client.transcript.filter(
			(exchange) => exchange.purpose === "teardown" && exchange.method === "GET" && exchange.url.endsWith(`/${id}`),
		)
		expect(readBack.map((exchange) => exchange.status)).toEqual([200])
		expect(notes.has(id)).toBe(false)
		expect(result.teardown?.failed.filter((failure) => failure.id === id)).toEqual([])
	}, 120_000)

	it("is not read again when its creator saw it during the run", async () => {
		const { result } = await runHidden("plain")
		const before = result.client.transcript.filter(
			(exchange) => exchange.purpose !== "teardown" && exchange.status === 200,
		)
		const sighted = new Set([
			...before
				.filter((exchange) => exchange.operationId === "folder.list")
				.flatMap((exchange) =>
					((exchange.responseBody as { items?: Array<{ id: string }> }).items ?? []).map((row) => row.id),
				),
			...before
				.filter((exchange) => exchange.operationId === "folder.read")
				.map((exchange) => exchange.url.split("/").at(-1)),
		])
		expect(sighted.size).toBeGreaterThan(1)
		const readBack = result.client.transcript
			.filter((exchange) => exchange.purpose === "teardown" && exchange.operationId === "folder.read")
			.map((exchange) => exchange.url.split("/").at(-1))
		expect(readBack.filter((id) => sighted.has(id))).toEqual([])
	}, 120_000)

	it("makes no claim when an ancestor was removed earlier in the run", async () => {
		const { id, result } = await runHidden("plain", { drop: true })
		expect(id).not.toBe("")
		expect(result.teardown?.failed.filter((failure) => failure.id === id)).toEqual([])
	}, 120_000)
})

const foldersPresent: Hooks["verifyRemoved"] = (record) => (record.entity === "folder" ? "present" : "unknown")
const unreachable: Hooks["verifyRemoved"] = () => {
	throw new Error("store unreachable")
}

describe("hooks.verifyRemoved", () => {
	it("puts a record it says is present among the leftovers", async () => {
		const { folders, result } = await runHidden("plain", { hooks: { verifyRemoved: foldersPresent } })
		const folder = result.teardown?.records.find((record) => record.entity === "folder")
		expect(folder).toBeDefined()
		expect(folders.has(folder?.id ?? "")).toBe(false)
		expect(result.teardown?.failed).toContainEqual(
			expect.objectContaining({ entity: "folder", id: folder?.id, reason: VERIFY_HOOK_PRESENT }),
		)
	}, 120_000)

	it("clears a record it says is absent", async () => {
		const seen: Array<{ entity: string; id: string; principal: string }> = []
		const verifyRemoved: Hooks["verifyRemoved"] = async (record) => {
			seen.push(record)
			return "absent" as const
		}
		const { id, result } = await runHidden("HIDE me", { hooks: { verifyRemoved } })
		expect(seen).toContainEqual(expect.objectContaining({ entity: "note", id, principal: "alpha" }))
		expect(result.teardown?.failed.filter((failure) => failure.id === id)).toEqual([])
	}, 120_000)

	it("leaves the read's verdict when it does not know", async () => {
		const { id, result } = await runHidden("HIDE me", { hooks: { verifyRemoved: () => "unknown" } })
		expect(result.teardown?.failed).toContainEqual(expect.objectContaining({ id, reason: NEVER_SEEN }))
	}, 120_000)

	it("that throws counts as not knowing, and is reported once", async () => {
		const { id, result } = await runHidden("HIDE me", { hooks: { verifyRemoved: unreachable } })
		expect(result.teardown?.failed).toContainEqual(expect.objectContaining({ id, reason: NEVER_SEEN }))
		const gaps = result.findings.filter((finding) => finding.check === "teardown.verify-hook")
		expect(gaps).toHaveLength(1)
		expect(gaps[0]?.detail).toContain("store unreachable")
	}, 120_000)

	it("must be a function", () => {
		expect(configProblems({ hooks: { verifyRemoved: "present" } })).toContain(
			"config.hooks.verifyRemoved must be a function",
		)
	})
})

/* A per-tenant id sequence: each project's first row is `1`. Reads find nothing; deletes answer 204. */
const TENANT_ROWS = {
	info: { title: "tenant-rows", version: "1" },
	openapi: "3.1.0",
	paths: {
		"/projects/{project_id}/rows/{row_id}": {
			delete: tagged("row", "delete", {
				parameters: [param("project_id"), param("row_id")],
				responses: { "204": { description: "gone" } },
			}),
			get: tagged("row", "read", {
				parameters: [param("project_id"), param("row_id")],
				responses: { "200": { ...json(ITEM), description: "ok" }, "404": { description: "missing" } },
			}),
		},
	},
} as unknown as OpenApiDocument

const owner = (id: string): Owner => ({ headers: () => ({ authorization: `Bearer ${id}` }), id })

/* Both tenants hold `row 1`; only `seer`'s read of it answers. */
async function twoRowOnes(seer: string | null, verdicts: Record<string, "present" | "absent">) {
	const server = createServer((req, res) => {
		if (req.method === "DELETE") return reply(res, 204)
		return req.headers.authorization === `Bearer ${seer}`
			? reply(res, 200, { id: "1", text: "x" })
			: reply(res, 404, {})
	})
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
	closers.push(() => new Promise((resolve) => server.close(() => resolve())))
	const client = new Client({
		baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
		redactor: new Redactor(),
	})
	const ledger = new Ledger()
	const [one] = listedIds(["1"])
	if (one === undefined) throw new Error("listedIds gave nothing back")
	ledger.record("row", one, { project_id: "a", row_id: "1" }, owner("alpha"))
	ledger.record("row", one, { project_id: "b", row_id: "1" }, owner("beta"))
	return ledger.unwind(buildModel(dereference(TENANT_ROWS).doc), client, () => [], {
		verify: false,
		verifyRemoved: (record) => verdicts[record.principal] ?? "unknown",
	})
}

const removedBy = (report: Awaited<ReturnType<typeof twoRowOnes>>) =>
	report.records.map((record) => `${record.principal} ${record.removed}`).toSorted()

describe("hooks.verifyRemoved, when two tenants hold the same id", () => {
	it("keeps each principal's record, and settles each one by its own answer", async () => {
		const report = await twoRowOnes(null, { alpha: "present", beta: "absent" })
		expect(removedBy(report)).toEqual(["alpha false", "beta true"])
		expect(report.failed).toEqual([{ entity: "row", id: "1", principal: "alpha", reason: VERIFY_HOOK_PRESENT }])
	})

	it("clears only the never-seen record its own answer clears", async () => {
		/* Beta saw its row; alpha never did. The hook finds beta's still there and alpha's gone. */
		const report = await twoRowOnes("beta", { alpha: "absent", beta: "present" })
		expect(removedBy(report)).toEqual(["alpha true", "beta false"])
		expect(report.failed).toEqual([{ entity: "row", id: "1", principal: "beta", reason: VERIFY_HOOK_PRESENT }])
	})
})
