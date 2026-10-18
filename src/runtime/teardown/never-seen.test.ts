import { describe, expect, it } from "vitest"
import { disposable, notesModel, store, unwindOf } from "./__fixtures__/notes.ts"
import { markNeverSeen, NEVER_SEEN } from "./never-seen.ts"
import { leftover } from "./remove.ts"

describe("markNeverSeen", () => {
	it("moves a removed record its creator never saw to the leftovers", async () => {
		const unseen = disposable("note", "n1")
		const seen = disposable("note", "n2")
		const unreadable = disposable("tag", "t1")
		const earlier = disposable("note", "n3")
		const kept = disposable("note", "n4")
		const items = [unseen, seen, unreadable, earlier, kept]
		const state = unwindOf(store(), items, {
			model: notesModel(),
			deletedEarlier: (path) => path === "/notes/n3",
			ledger: { movedAway: () => undefined, seenByCreator: (item) => item === seen, sighted: () => undefined },
		})
		for (const item of [unseen, seen, unreadable, earlier]) {
			const record = state.records.get(item)
			if (record !== undefined) record.removed = true
			state.paths.set(item, `/notes/${item.id}`)
		}
		state.report.removed = 4
		const neverSeen = markNeverSeen(state, items)
		expect([...neverSeen]).toEqual([unseen])
		expect(state.report.removed).toBe(3)
		expect(state.report.failed).toEqual([leftover(unseen, NEVER_SEEN)])
		expect(state.records.get(unseen)?.removed).toBe(false)
	})
})
