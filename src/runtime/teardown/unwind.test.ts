import { describe, expect, it } from "vitest"
import type { RemovedRecord } from "../../config/types/hooks.ts"
import { UnsatisfiedSecurity } from "../../client/credential-source.ts"
import { FencedError } from "../fence.ts"
import { disposable, notesClient, notesModel, store, type Store } from "./__fixtures__/notes.ts"
import type { Disposable, LedgerView, UnwindOptions } from "./types.ts"
import { unwindQueue } from "./unwind.ts"

const model = notesModel()

/** How a test unwinds: the unwind's options, and the records their creators read back. */
interface Unwinding {
	options?: UnwindOptions
	seen?: Disposable[]
}

/** Unwinds `queue` (newest first) against `held`; `seen` (default: all of `queue`) were read back by their creators. */
async function unwind(held: Store, queue: Disposable[], { options = {}, seen = queue }: Unwinding = {}) {
	const sighted: string[] = []
	const ledger: LedgerView = {
		movedAway: () => undefined,
		seenByCreator: (item) => seen.includes(item) || sighted.includes(item.id),
		sighted: (_entity, id) => sighted.push(id),
	}
	const { client, sent } = notesClient(held)
	const report = await unwindQueue({ client, fallbacks: () => [], ledger, model, options, queue })
	return { report, sent: sent.map((request) => `${request.method} ${request.path}`), sighted }
}

describe("unwindQueue", () => {
	it("removes children before their parents, and verifies each level before the next", async () => {
		const note = disposable("note", "n1")
		const comment = disposable("comment", "c1", { scope: { note_id: "n1" } })
		const tag = disposable("tag", "t1")
		const held = store(
			{ alpha: ["n1"] },
			{
				answers: {
					"DELETE /notes/n1/comments/c1": { status: 204 },
					"GET /notes/n1/comments": { body: [], status: 200 },
				},
			},
		)
		const { report, sent } = await unwind(held, [tag, note, comment])
		expect(sent).toEqual(["DELETE /notes/n1/comments/c1", "GET /notes/n1/comments", "DELETE /notes/n1", "GET /notes"])
		expect(report.removed).toBe(2)
		expect(report.unsupported).toEqual(["tag"])
		expect(report.records.map((record) => `${record.id} ${record.removed}`)).toEqual(["c1 true", "n1 true", "t1 false"])
	})

	it("marks an inferred record's line, and no other", async () => {
		const inferred = { ...disposable("tag", "t1"), inferred: true as const }
		const { report } = await unwind(store(), [inferred, disposable("tag", "t2")], { options: { verify: false } })
		expect(report.records).toEqual([
			{ entity: "tag", id: "t2", principal: "alpha", removed: false },
			{ entity: "tag", id: "t1", inferred: true, principal: "alpha", removed: false },
		])
	})

	it("reads back a record its creator never saw, once, before removing it", async () => {
		const read = disposable("note", "n1")
		const missing = disposable("note", "n2")
		const tag = disposable("tag", "t1")
		const { report, sent, sighted } = await unwind(store({ alpha: ["n1"] }), [read, missing, tag], {
			options: { verify: false },
			seen: [],
		})
		expect(sent).toEqual(["GET /notes/n1", "GET /notes/n2", "DELETE /notes/n1", "DELETE /notes/n2"])
		expect(sighted).toEqual(["n1"])
		expect(report.failed.map((entry) => `${entry.id}: ${entry.reason}`)).toEqual([
			"n2: its creator could never read it back, so teardown cannot tell whether it is gone",
		])
	})
})

describe("unwindQueue: read backs and hooks", () => {
	it("gives up a read back that is fenced, and throws one that fails otherwise", async () => {
		const fenced = new FencedError({ method: "GET", phase: "teardown", reason: "no reads", url: "u" })
		const note = disposable("note", "n1")
		const refused = store(
			{ alpha: ["n1"] },
			{
				answers: {
					"GET /notes/n1": () => {
						throw fenced
					},
				},
			},
		)
		expect((await unwind(refused, [note], { options: { verify: false }, seen: [] })).sent).toEqual([
			"GET /notes/n1",
			"DELETE /notes/n1",
		])
		const broken = store(
			{ alpha: ["n1"] },
			{
				answers: {
					"GET /notes/n1": () => {
						throw new TypeError("bug")
					},
				},
			},
		)
		await expect(unwind(broken, [note], { seen: [] })).rejects.toThrow("bug")
	})

	it("asks hooks.verifyRemoved about what it removed", async () => {
		const asked: RemovedRecord[] = []
		const note = disposable("note", "n1", { scope: { org: "o1" } })
		const verifyRemoved = (record: RemovedRecord) => {
			asked.push(record)
			return "present" as const
		}
		const { report } = await unwind(store({ alpha: ["n1"] }), [note], { options: { verifyRemoved } })
		expect(asked).toEqual([{ entity: "note", id: "n1", principal: "alpha", scope: { org: "o1" } }])
		expect(report.removed).toBe(0)
	})

	it("returns an empty report for an empty queue", async () => {
		expect((await unwind(store(), [])).report).toEqual({
			failed: [],
			records: [],
			removed: 0,
			unidentified: [],
			unsupported: [],
		})
	})
})

describe("unwindQueue: a creator whose credential is BLOCKED", () => {
	it("gives up a read back its creator holds no credential for, and reports the record it could not see", async () => {
		const note = disposable("note", "n1")
		const blocked = store(
			{ alpha: ["n1"] },
			{
				answers: {
					"GET /notes/n1": () => {
						throw new UnsatisfiedSecurity("blocked", "refresh for alpha/jwt: token revoked")
					},
				},
			},
		)
		const { report, sent } = await unwind(blocked, [note], { options: { verify: false }, seen: [] })
		expect(sent).toEqual(["GET /notes/n1", "DELETE /notes/n1"])
		expect(report.failed.map((entry) => entry.reason)).toEqual([
			"its creator could never read it back, so teardown cannot tell whether it is gone",
		])
	})
})
