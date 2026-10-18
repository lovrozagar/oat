import { describe, expect, it } from "vitest"
import type { ScenarioRequestStep } from "../../config/types/steps.ts"
import { exchange, type Answer } from "../checks/__fixtures__/harness.ts"
import { jwt, notes, runOf } from "./__fixtures__/stage.ts"
import { StepFailure } from "./failure.ts"
import { record } from "./record.ts"
import { wantsOf } from "./want.ts"

/** Records `step` as passed on `answer` to `method`, and returns the run. */
function passed(step: ScenarioRequestStep, answer: Answer, method = "GET", run = runOf(notes())) {
	const answered = exchange(method, "/notes", answer)
	const stepOp = "operationId" in step ? step.operationId : undefined
	record(run, { exchange: answered, step, stepOp, wants: wantsOf(step, run.scope) })
	return { answered, run }
}

describe("record: saveAs", () => {
	it("saves text into scope, and an object, number or boolean also whole", () => {
		const { run } = passed(
			{
				operationId: "notes.list",
				saveAs: { count: "$.total", first: "$.items[0]", name: "$.name", on: "$.on", tag: "header:x-tag" },
			},
			{ body: { items: [{ id: "n1" }], name: "Ada", on: true, total: 2 }, headers: { "x-tag": "t" }, status: 200 },
		)
		expect(run.scope).toMatchObject({ count: "2", first: '{"id":"n1"}', name: "Ada", on: "true", tag: "t" })
		expect([...run.objects.entries()]).toEqual([
			["count", 2],
			["first", { id: "n1" }],
			["on", true],
		])
	})

	it("forgets an object once the name holds text", () => {
		const run = runOf(notes())
		run.objects.set("name", { old: true })
		passed(
			{ operationId: "notes.list", saveAs: { name: "$.name" } },
			{ body: { name: "Ada" }, status: 200 },
			"GET",
			run,
		)
		expect(run.objects.has("name")).toBe(false)
	})

	it("fails a value the response does not carry", () => {
		expect(() => passed({ operationId: "notes.list", saveAs: { id: "$.{org}" } }, { body: {}, status: 200 })).toThrow(
			'saveAs.id = "$.o1" is not in the response',
		)
		expect(() =>
			passed({ method: "GET", path: "/n", saveAs: { id: "$.id" } }, { body: { id: null }, status: 200 }),
		).toThrow(StepFailure)
	})
})

describe("record: saveClaimsFrom", () => {
	it("reads claims from a token in the response or already in scope", () => {
		const token = jwt({ org: "o9", sub: "u1" })
		const { run } = passed(
			{ operationId: "auth.token", saveClaimsFrom: { bind: { user: "$.sub" }, token: "$.token" } },
			{ body: { token }, status: 200 },
		)
		expect(run.scope.user).toBe("u1")
		run.scope.saved = token
		passed(
			{ operationId: "notes.list", saveClaimsFrom: { bind: { org: "$.org" }, token: "saved" } },
			{ body: {}, status: 200 },
			"GET",
			run,
		)
		expect(run.scope.org).toBe("o9")
		passed(
			{ operationId: "notes.list", saveClaimsFrom: { bind: { sub: "$.sub" }, token: "token" } },
			{ body: { token }, status: 200 },
			"GET",
			run,
		)
		expect(run.scope.sub).toBe("u1")
	})

	it("fails without a JWT, or without the claim", () => {
		expect(() =>
			passed(
				{ operationId: "auth.token", saveClaimsFrom: { bind: {}, token: "$.token" } },
				{ body: { token: "x" }, status: 200 },
			),
		).toThrow("saveClaimsFrom: no JWT at $.token")
		expect(() =>
			passed(
				{ operationId: "auth.token", saveClaimsFrom: { bind: {}, token: "$.token" } },
				{ body: { token: 3 }, status: 200 },
			),
		).toThrow("saveClaimsFrom: no JWT at $.token")
		expect(() =>
			passed(
				{ operationId: "auth.token", saveClaimsFrom: { bind: { role: "$.role" }, token: "$.token" } },
				{ body: { token: jwt({}) }, status: 200 },
			),
		).toThrow('saveClaimsFrom: the token carries no "$.role"')
	})
})

describe("record: observations", () => {
	it("proves earlier calls by a later read, the absent ones as absences", () => {
		const run = runOf(notes())
		const created = exchange("POST", "/notes", { status: 201 })
		run.calls.set("notes.create", created)
		run.calls.set("notes.rename", created)
		const { answered } = passed(
			{
				assert: [
					{ contains: "Ad", from: "$.items[*].text", observes: ["notes.create", "notes.missing"] },
					{ excludes: "Bob", from: "$.items[*].text", observes: ["notes.rename"] },
				],
				operationId: "notes.list",
			},
			{ body: { items: [{ text: "Ada" }] }, status: 200 },
			"GET",
			run,
		)
		expect(run.observations.get("notes.create")).toEqual({ path: "$.items[*].text", seq: answered.seq, value: "Ad" })
		expect(run.observations.get("notes.rename")).toEqual({
			absent: true,
			path: "$.items[*].text",
			seq: answered.seq,
			value: "Bob",
		})
		expect(run.observations.get("notes.list")).toEqual({ path: "$.items[*].text", seq: answered.seq, value: "Ad" })
		expect(run.observations.has("notes.missing")).toBe(false)
	})

	it("does not let a write prove itself, nor a repeat replace an observed call", () => {
		const run = runOf(notes())
		passed(
			{ assert: { from: "$.text", omits: "secret" }, operationId: "notes.create" },
			{ body: { text: "x" }, status: 201 },
			"POST",
			run,
		)
		expect(run.observations.has("notes.create")).toBe(false)
		run.observations.set("notes.list", { seq: 1, status: 200 })
		const first = run.calls.get("notes.list")
		passed({ operationId: "notes.list" }, { body: {}, status: 200 }, "GET", run)
		expect(run.calls.get("notes.list")).toBe(first)
		passed(
			{ assert: { equals: "x", from: "$.a" }, method: "GET", path: "/a" },
			{ body: { a: "x" }, status: 200 },
			"GET",
			run,
		)
	})
})
