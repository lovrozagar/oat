import { afterEach, describe, expect, it, vi } from "vitest"
import { UnsatisfiedSecurity } from "../../client/credential-source.ts"
import type { ScenarioRequestStep, ScenarioStep } from "../../config/types/steps.ts"
import {
	accountsApi,
	accountsModel,
	accountsPort,
	deleteThroughSession,
	refresh,
	signUp,
} from "./__fixtures__/accounts.ts"
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

	it("blocks what a step's unmet security leaves unreached, with the reason, before sending it", async () => {
		const { input } = stage(
			() => {
				throw new UnsatisfiedSecurity("unsatisfied", "no credential for apiKey")
			},
			{ scenarios: [rename] },
		)
		await runScenarios(input)
		expect(input.findings.findings.map(({ detail, summary, verdict }) => ({ detail, summary, verdict }))).toEqual([
			{
				detail: 'blocked by scenario "rename" stopped at step 1: no credential for apiKey',
				summary: 'scenario "rename" stopped at step 1 before calling it',
				verdict: "BLOCKED",
			},
		])
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

describe("runScenarios: a principal BLOCKED at sign-in", () => {
	it("sends nothing for a scenario, or a step, that needs a principal BLOCKED at sign-in, and reports it BLOCKED", async () => {
		const peer = scenario([{ operationId: "notes.list" }], { covers: ["notes.list"], id: "peer", principal: "beta" })
		const step = scenario([{ operationId: "notes.list", principal: "beta" }], { covers: ["notes.list"], id: "step" })
		const blocked = new Map([["beta", "auth.token answered 401"]])
		const { input, sent } = stage(notesApi(notes()), { blocked, scenarios: [peer, step] })
		await runScenarios(input)
		expect(sent).toEqual([])
		expect(input.grades.evidence.size).toBe(0)
		expect(input.findings.findings.map((finding) => [finding.check, finding.verdict, finding.detail])).toEqual([
			["scenario.peer", "BLOCKED", 'blocked by principal "beta" is BLOCKED: auth.token answered 401'],
			["scenario.step", "BLOCKED", 'blocked by principal "beta" is BLOCKED: auth.token answered 401'],
		])
	})
})

/* A profile that leaves out the scenario named "consent" and runs every other. */
const skipsConsent = (of: { id: string }) => (of.id === "consent" ? 'external "consent" is kind "device"' : null)

describe("runScenarios: a scenario the profile leaves out", () => {
	it("sends nothing for it and reports the reason as a profile.skip gap on what it covers", async () => {
		const consent = scenario([{ operationId: "notes.list" }, { as: "code", external: "consent" }], {
			covers: ["notes.list"],
			id: "consent",
		})
		const { input, sent } = stage(notesApi(notes()), { scenarios: [consent, rename], skipped: skipsConsent })
		await runScenarios(input)
		expect(sent.map((request) => `${request.method} ${request.path}`)).toEqual([
			"POST /notes",
			"GET /notes",
			"PATCH /notes/n1",
			"GET /notes",
		])
		expect(input.findings.findings).toEqual([
			expect.objectContaining({
				check: "profile.skip",
				detail: 'external "consent" is kind "device". What it covers stays ungraded under this profile.',
				entity: "consent",
				operations: ["notes.list"],
				summary: 'scenario "consent" skipped by the profile',
				verdict: "COVERAGE_GAP",
			}),
		])
		expect(input.grades.evidence.has("notes.list")).toBe(false)
	})
})

/* The reauth flow over the accounts API, its port, and the scenario's steps in place of the default ones. */
function selfDelete(steps: ScenarioStep[], answers: Parameters<typeof accountsApi>[0] = {}) {
	const accounts = accountsPort()
	const { input } = stage(accountsApi(answers), {
		accounts: accounts.port,
		model: accountsModel,
		scenarios: [scenario(steps, { covers: ["auth.deleteAccount"] })],
	})
	return { ...accounts, input }
}

describe("runScenarios: a self delete sent through the scenario's session", () => {
	it("settles the account whose sign-up the session descends from", async () => {
		const { deleted, input } = selfDelete([signUp, refresh, deleteThroughSession])
		await runScenarios(input)
		expect(deleted.map(({ entry, exchange }) => [entry.n, exchange.operationId, exchange.status])).toEqual([
			[1, "auth.deleteAccount", 204],
		])
	})

	it("settles it when the delete was accepted but an assert on it was unmet", async () => {
		const { deleted, input } = selfDelete(
			[signUp, refresh, { ...deleteThroughSession, assert: { equals: "yes", from: "$.gone" } }],
			{ "DELETE /account": { body: { gone: "no" }, status: 200 } },
		)
		await runScenarios(input)
		expect(input.findings.findings.map(({ verdict }) => verdict)).toEqual(["BACKEND_BUG"])
		expect(deleted.map(({ entry }) => entry.n)).toEqual([1])
	})

	it("settles nothing when the delete is refused", async () => {
		const { deleted, input } = selfDelete([signUp, refresh, { ...deleteThroughSession, expect: [403] }], {
			"DELETE /account": { status: 403 },
		})
		await runScenarios(input)
		expect(deleted).toEqual([])
	})

	it("settles nothing for a delete that sends only a value no sign-up answered", async () => {
		const { deleted, input } = selfDelete([
			signUp,
			{ ...deleteThroughSession, headers: { authorization: "Bearer {org}" } },
		])
		await runScenarios(input)
		expect(deleted).toEqual([])
	})

	it("settles nothing for a delete sent as the scenario's principal, whose account the watch settles", async () => {
		const { anonymous: _anonymous, ...asPrincipal } = deleteThroughSession as ScenarioRequestStep
		const { deleted, input } = selfDelete([signUp, refresh, asPrincipal])
		await runScenarios(input)
		expect(deleted).toEqual([])
	})
})

describe("runScenarios: which sign-up a session descends from", () => {
	const second: ScenarioStep = { ...signUp, saveAs: { other: "$.refresh" } }

	it("settles nothing for a session made from two accounts' values", async () => {
		const both = { ...refresh, body: { refresh: "{refreshToken}", token: "{other}" } }
		const { deleted, input } = selfDelete([signUp, second, both, deleteThroughSession])
		await runScenarios(input)
		expect(input.findings.findings).toEqual([])
		expect(deleted).toEqual([])
	})

	it("settles nothing once the session's name is rebound by a step that sent no account's value", async () => {
		const rebound = { ...refresh, body: { refresh: "{org}" } }
		const { deleted, input } = selfDelete([signUp, refresh, rebound, deleteThroughSession])
		await runScenarios(input)
		expect(deleted).toEqual([])
	})

	it("settles the account of the sign-up answer that passed, when the sign-up was polled", async () => {
		let answers = 0
		const polled = { ...signUp, assert: { equals: "t2", from: "$.token" }, poll: { everyMs: 1, within: "5s" } }
		const register = () => {
			answers += 1
			return { body: { refresh: `r${answers}`, token: `t${answers}` }, status: 201 }
		}
		const { deleted, input } = selfDelete([polled, refresh, deleteThroughSession], { "POST /register": register })
		await runScenarios(input)
		expect(answers).toBe(2)
		expect(deleted.map(({ entry }) => entry.n)).toEqual([2])
	})
})
