import { afterEach, describe, expect, it, vi } from "vitest"
import { notes, notesApi, scenario, stage } from "./__fixtures__/stage.ts"
import { runScenarios } from "./run.ts"

afterEach(() => {
	vi.useRealTimers()
})

const rename = scenario(
	[
		{ body: { text: "first" }, operationId: "notes.create", saveAs: { id: "$.id" } },
		{ assert: { contains: "first", from: "$.items[*].text", observes: ["notes.create"] }, operationId: "notes.list" },
		{ body: { text: "second" }, operationId: "notes.rename" },
		{ assert: { contains: "second", from: "$.items[*].text", observes: ["notes.rename"] }, operationId: "notes.list" },
	],
	{ covers: ["notes.create", "notes.rename"], id: "rename" },
)

describe("runScenarios", () => {
	it("runs each scenario's steps and grades what they observed", async () => {
		const { input, sent } = stage(notesApi(notes()), { scenarios: [rename] })
		await runScenarios(input)
		expect(sent.map((request) => `${request.method} ${request.path}`)).toEqual([
			"POST /notes",
			"GET /notes",
			"PATCH /notes/n1",
			"GET /notes",
		])
		expect(input.checksRun.has("scenario.rename")).toBe(true)
		expect(input.grades.evidence.get("notes.rename")?.observation).toMatchObject({ value: "second" })
	})

	it("stops a scenario at the step that fails", async () => {
		const held = notes({ answers: { "PATCH /notes/n1": { status: 500 } } })
		const { input, sent } = stage(notesApi(held), { scenarios: [rename] })
		await runScenarios(input)
		expect(sent).toHaveLength(3)
		expect(input.findings.findings[0]?.summary).toBe(
			'scenario "rename" stopped at step 3: PATCH /notes/n1 returned 500',
		)
	})

	it("skips a scenario that touches nothing in scope, and runs one whose step does", async () => {
		const support = scenario([{ operationId: "notes.list" }], { covers: [], id: "support" })
		const { input, sent } = stage(notesApi(notes()), {
			inScope: (id) => id === "notes.list",
			mode: "targeted",
			scenarios: [rename, support, scenario([{ operationId: "auth.token" }], { id: "unrelated" })],
		})
		await runScenarios(input)
		expect([...input.checksRun]).toEqual(["scenario.rename", "scenario.support"])
		expect(sent.filter((request) => request.path === "/token")).toEqual([])
	})

	it("refuses a scenario that names a principal not configured", async () => {
		const { input } = stage(notesApi(notes()), { scenarios: [{ ...rename, principal: "gamma" }] })
		await expect(runScenarios(input)).rejects.toThrow('names principal "gamma", which is not configured')
	})
})

describe("runScenarios when the run stops", () => {
	it("starts no scenario once the run is told to stop", async () => {
		const { input, sent } = stage(notesApi(notes()), { scenarios: [rename], stopped: () => true })
		await runScenarios(input)
		expect(sent).toEqual([])
		expect(input.checksRun.size).toBe(0)
	})

	it("grades what completed, and nothing after, when stopped mid-scenario", async () => {
		let checks = 0
		const { input, sent } = stage(notesApi(notes()), {
			scenarios: [rename, scenario([{ operationId: "notes.list" }], { id: "later" })],
			stopped: () => {
				checks += 1
				return checks > 3
			},
		})
		await runScenarios(input)
		expect(sent).toHaveLength(2)
		expect(input.grades.evidence.get("notes.create")?.observation).toMatchObject({ value: "first" })
		expect(input.findings.findings).toEqual([])
		expect(input.checksRun.has("scenario.later")).toBe(false)
	})

	it("waits between polls on the clock when no sleep is given", async () => {
		vi.useFakeTimers({ now: 0 })
		const held = notes()
		let reads = 0
		held.answers["GET /notes"] = () => {
			reads += 1
			return { body: { total: reads }, status: 200 }
		}
		const poll = scenario(
			[{ assert: { atLeast: 2, from: "$.total" }, operationId: "notes.list", poll: { within: "5s" } }],
			{ covers: ["notes.list"] },
		)
		const { input } = stage(notesApi(held), { scenarios: [poll], sleep: undefined })
		const running = runScenarios(input)
		await vi.advanceTimersByTimeAsync(500)
		await running
		expect(reads).toBe(2)
	})
})
