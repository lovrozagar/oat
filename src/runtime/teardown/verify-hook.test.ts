import { describe, expect, it } from "vitest"
import type { RemovalVerdict, RemovedRecord } from "../../config/types/hooks.ts"
import { disposable } from "./__fixtures__/notes.ts"
import { NEVER_SEEN } from "./never-seen.ts"
import { leftover } from "./remove.ts"
import type { Disposable, RecordState, TeardownReport } from "./types.ts"
import { askVerifyHook, VERIFY_HOOK_PRESENT } from "./verify-hook.ts"

/** The verdicts' input over `removed` records counted gone and `unseen` ones left as never seen. */
function verdictsOf(removed: Disposable[], unseen: Disposable[], untouched: Disposable[] = []) {
	const records = new Map<Disposable, RecordState>()
	for (const item of [...removed, ...unseen, ...untouched]) {
		records.set(item, { entity: item.entity, id: item.id, principal: item.owner.id, removed: removed.includes(item) })
	}
	const report: TeardownReport = {
		failed: unseen.map((item) => leftover(item, NEVER_SEEN)),
		records: [],
		removed: removed.length,
		unidentified: [],
		unsupported: [],
	}
	return { neverSeen: new Set(unseen), queue: [...removed, ...unseen, ...untouched], records, report }
}

const by = (answers: Record<string, RemovalVerdict | Error | string>) => async (record: RemovedRecord) => {
	const answer = answers[record.id]
	if (answer instanceof Error) throw answer
	if (answer === "throws") throw "hook down"
	return answer as RemovalVerdict
}

describe("askVerifyHook", () => {
	it("clears a never-seen record the hook says is absent, and leaves a removed one", async () => {
		const removed = disposable("note", "n1")
		const unseen = disposable("note", "n2")
		const verdicts = verdictsOf([removed], [unseen])
		await askVerifyHook(by({ n1: "absent", n2: "absent" }), verdicts)
		expect(verdicts.report.failed).toEqual([])
		expect(verdicts.report.removed).toBe(2)
		expect(verdicts.records.get(unseen)?.removed).toBe(true)
	})

	it("makes a leftover of a record the hook says is present", async () => {
		const removed = disposable("note", "n1")
		const unseen = disposable("note", "n2")
		const verdicts = verdictsOf([removed], [unseen])
		await askVerifyHook(by({ n1: "present", n2: "present" }), verdicts)
		expect(verdicts.report.failed).toEqual([
			leftover(removed, VERIFY_HOOK_PRESENT),
			leftover(unseen, VERIFY_HOOK_PRESENT),
		])
		expect(verdicts.report.removed).toBe(0)
	})

	it("keeps teardown's verdict on `unknown` or a throw, and records each throw", async () => {
		const items = ["n1", "n2", "n3", "n4", "n5"].map((id) => disposable("note", id))
		const untouched = disposable("note", "n9")
		const asked: string[] = []
		const verdicts = verdictsOf(items, [], [untouched])
		await askVerifyHook(async (record) => {
			asked.push(record.id)
			return by({ n1: "unknown", n2: new Error("timeout"), n3: "throws", n4: "unknown", n5: "unknown" })(record)
		}, verdicts)
		expect(asked).toEqual(["n1", "n2", "n3", "n4", "n5"])
		expect(verdicts.report.removed).toBe(5)
		expect(verdicts.report.verifyHookErrors).toEqual(["timeout", "hook down"])
	})

	it("adds no errors when the hook never throws", async () => {
		const verdicts = verdictsOf([disposable("note", "n1")], [])
		await askVerifyHook(() => "unknown", verdicts)
		expect(verdicts.report).not.toHaveProperty("verifyHookErrors")
	})
})
