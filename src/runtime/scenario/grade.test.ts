import { describe, expect, it } from "vitest"
import { exchange } from "../checks/__fixtures__/harness.ts"
import { notes, runOf, scenario } from "./__fixtures__/stage.ts"
import { StepFailure } from "./failure.ts"
import { gradeScenario, proveCalled } from "./grade.ts"

const CHECK = "scenario.flow"

describe("proveCalled", () => {
	it("grades and proves each operation the scenario called, by its observation when it has one", () => {
		const run = runOf(notes())
		const created = exchange("POST", "/notes", { status: 201 })
		const listed = exchange("GET", "/notes", { status: 200 })
		run.calls.set("notes.create", created)
		run.calls.set("notes.list", listed)
		run.observations.set("notes.create", { path: "$.text", seq: listed.seq, value: "x" })
		proveCalled(run, ["notes.create", "notes.list", "notes.rename"], CHECK)
		expect(run.input.grades.evidence.get("notes.create")).toEqual({
			call: created.seq,
			observation: { path: "$.text", seq: listed.seq, value: "x" },
		})
		expect(run.input.grades.evidence.get("notes.list")).toEqual({ call: listed.seq })
		expect(run.input.grades.ran.has("notes.rename")).toBe(false)
	})
})

describe("gradeScenario", () => {
	it("proves what a finished scenario called", () => {
		const run = runOf(notes())
		run.calls.set("notes.create", exchange("POST", "/notes", { status: 201 }))
		gradeScenario(run, ["notes.create"], null)
		expect(run.input.grades.ran.get("notes.create")?.has(CHECK)).toBe(true)
		expect(run.input.findings.findings).toEqual([])
	})

	it("fails what the failing step blames and blocks what it never reached", () => {
		const run = runOf(notes(), {}, scenario([], { covers: ["notes.create", "notes.rename", "notes.list"] }))
		const created = exchange("POST", "/notes", { status: 201 })
		run.calls.set("notes.create", created)
		const evidence = [exchange("PATCH", "/notes/n1", { status: 500 })]
		const stop = {
			failure: new StepFailure("PATCH /notes/n1 returned 500", evidence, ["notes.rename", "auth.token"]),
			index: 1,
		}
		gradeScenario(run, ["notes.create", "notes.rename", "notes.list"], stop)
		expect(run.input.grades.ran.get("auth.token")?.has(CHECK)).toBe(true)
		expect(run.input.findings.findings.map((finding) => `${finding.verdict} ${finding.summary}`)).toEqual([
			'BACKEND_BUG scenario "flow" stopped at step 2: PATCH /notes/n1 returned 500',
			'BLOCKED scenario "flow" stopped at step 2 before calling it',
		])
		expect(run.input.findings.findings[1]?.operations).toEqual(["notes.list"])
	})

	it("blames only operations in scope, and blocks nothing when every one was reached", () => {
		const run = runOf(notes(), { inScope: (id) => id === "notes.list", mode: "targeted" })
		run.calls.set("notes.list", exchange("GET", "/notes", { status: 200 }))
		const stop = { failure: new StepFailure("refused", [], ["auth.token"]), index: 0 }
		gradeScenario(run, ["notes.list"], stop)
		expect(run.input.findings.findings).toEqual([])
		expect(run.input.grades.ran.has("auth.token")).toBe(false)
	})
})
