import { describe, expect, it } from "vitest"
import { GradeLedger } from "./grades.ts"

describe("GradeLedger", () => {
	it("records which check graded, suppressed and skipped which operations", () => {
		const ledger = new GradeLedger()
		ledger.graded(["table.get", "table.list"], "list.read-after-write")
		ledger.graded(["table.get"], "read.matches-caller-root")
		ledger.suppress(["table.list"], "list.page-boundary")
		ledger.skipped(["table.update"], "an update operation")
		expect([...(ledger.ran.get("table.get") ?? [])]).toEqual(["list.read-after-write", "read.matches-caller-root"])
		expect([...(ledger.suppressed.get("table.list") ?? [])]).toEqual(["list.page-boundary"])
		expect([...(ledger.needs.get("table.update") ?? [])]).toEqual(["an update operation"])
	})

	it("keeps the evidence that has an observation, never downgrading it", () => {
		const ledger = new GradeLedger()
		ledger.prove("table.create", { call: 1 })
		ledger.prove("table.create", { call: 2, observation: { path: "$.id", seq: 3, value: "t1" } })
		ledger.prove("table.create", { call: 4 })
		expect(ledger.evidence.get("table.create")?.call).toBe(2)
	})

	it("tells an operation only probes graded from one a check judged", () => {
		const ledger = new GradeLedger()
		ledger.probedBy(["auth.token", "notes.list"], "auth.anonymous-operation-open")
		ledger.graded(["notes.list"], "list.read-after-write")
		expect([...(ledger.ran.get("auth.token") ?? [])]).toEqual(["auth.anonymous-operation-open"])
		expect(ledger.judged("auth.token")).toBe(false)
		expect(ledger.judged("notes.list")).toBe(true)
		expect(ledger.judged("notes.get")).toBe(false)
	})
})
