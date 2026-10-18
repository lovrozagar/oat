import { afterEach, describe, expect, it } from "vitest"
import type { Scenario } from "../../src/config/define/types.ts"
import type { Hooks } from "../../src/config/types/hooks.ts"
import { run } from "../../src/runtime/run/index.ts"
import { type Api, serveNotes } from "../support/scenario-api.ts"

let open: Array<{ close: () => Promise<void> }> = []
afterEach(async () => {
	for (const server of open) await server.close()
	open = []
})

async function serve(options: { brokenRename?: boolean; statsLagMs?: number } = {}): Promise<Api> {
	const api = await serveNotes(options)
	open.push(api)
	return api
}

const RENAME: Scenario = {
	covers: ["notes.write", "notes.rename"],
	id: "notes",
	steps: [
		{ body: { text: "first" }, operationId: "notes.write", saveAs: { id: "$.id" } },
		{
			assert: { contains: "first", from: "$.items[*].text", observes: ["notes.write"] },
			operationId: "notes.list",
		},
		{ bind: { id: "{id}" }, body: { text: "second" }, operationId: "notes.rename" },
		{
			assert: { contains: "second", from: "$.items[*].text", observes: ["notes.rename"] },
			operationId: "notes.list",
		},
	],
}

/* The scenarios a run plays, the operations it covers, and the hooks it calls out to. */
interface ScenarioRun {
	scenarios: Scenario[]
	ops: string[]
	hooks?: Hooks
}

async function runWith(api: Api, { hooks = {}, ops, scenarios }: ScenarioRun) {
	return run({
		baseUrl: api.url,
		hooks,
		ops,
		principals: [{ headers: { authorization: "Bearer alpha" }, id: "alpha" }],
		scenarios,
		seed: 1,
		spec: `${api.url}/openapi.json`,
	})
}

function row(result: Awaited<ReturnType<typeof runWith>>, operationId: string) {
	return result.scope.operations.find((op) => op.operationId === operationId)
}

async function gradesVerified(): Promise<void> {
	const api = await serve()
	const result = await runWith(api, { ops: ["notes.write", "notes.rename"], scenarios: [RENAME] })
	for (const id of ["notes.write", "notes.rename"]) {
		const graded = row(result, id)
		expect(graded?.status).toBe("passed")
		expect(graded?.tier).toBe("verified")
		const call = result.client.transcript.find((exchange) => exchange.seq === graded?.evidence?.call)
		const seen = result.client.transcript.find((exchange) => exchange.seq === graded?.evidence?.observation?.seq)
		expect(call?.operationId).toBe(id)
		expect(seen?.operationId).toBe("notes.list")
		expect(seen?.seq).toBeGreaterThan(call?.seq ?? Number.POSITIVE_INFINITY)
	}
	expect(row(result, "notes.rename")?.evidence?.observation).toMatchObject({
		path: "$.items[*].text",
		value: "second",
	})
}

async function failsUnshownAndBlocksUnreached(): Promise<void> {
	const api = await serve({ brokenRename: true })
	const extended: Scenario = {
		...RENAME,
		covers: [...RENAME.covers, "stats.get"],
		steps: [...RENAME.steps, { assert: { contains: "first", from: "$.texts[*]" }, operationId: "stats.get" }],
	}
	const result = await runWith(api, { ops: ["notes.write", "notes.rename", "stats.get"], scenarios: [extended] })
	expect(row(result, "notes.write")?.status).toBe("passed")
	expect(row(result, "notes.rename")?.status).toBe("failed")
	expect(row(result, "stats.get")?.status).toBe("blocked")
	expect(row(result, "stats.get")?.reason).toContain('scenario "notes" stopped at step 4')
	const finding = result.findings.find((f) => f.operations?.includes("notes.rename"))
	expect(finding?.check).toBe("scenario.notes")
	expect(finding?.evidence.map((exchange) => exchange.operationId)).toContain("notes.list")
}

async function pollsLaggingRead(): Promise<void> {
	const api = await serve({ statsLagMs: 400 })
	const scenario: Scenario = {
		covers: ["notes.write", "stats.get"],
		id: "lagging",
		steps: [
			{ body: { text: "lagging-write" }, operationId: "notes.write" },
			{
				assert: { equals: "lagging-write", from: "$.texts[*]", observes: ["notes.write"] },
				operationId: "stats.get",
				poll: { within: "3s" },
			},
		],
	}
	const result = await runWith(api, { ops: ["notes.write", "stats.get"], scenarios: [scenario] })
	expect(row(result, "stats.get")?.status).toBe("passed")
	expect(row(result, "notes.write")?.tier).toBe("verified")
}

async function failsLaggingReadWithoutPoll(): Promise<void> {
	const api = await serve({ statsLagMs: 2_000 })
	const scenario: Scenario = {
		covers: ["notes.write", "stats.get"],
		id: "impatient",
		steps: [
			{ body: { text: "impatient-write" }, operationId: "notes.write" },
			{
				assert: { equals: "impatient-write", from: "$.texts[*]", observes: ["notes.write"] },
				operationId: "stats.get",
			},
		],
	}
	const result = await runWith(api, { ops: ["notes.write", "stats.get"], scenarios: [scenario] })
	expect(row(result, "stats.get")?.status).toBe("failed")
}

async function handsBrowserStepToHook(): Promise<void> {
	const api = await serve()
	const seen: Array<{ input: unknown; name: string }> = []
	const scenario: Scenario = {
		covers: ["checkout.open", "checkout.confirm"],
		id: "pay",
		steps: [
			{ operationId: "checkout.open", saveAs: { checkoutUrl: "$.url" } },
			{ as: "session", external: "pay-with-test-card", input: { url: "{checkoutUrl}" } },
			{
				assert: { equals: "true", from: "$.confirmed", observes: ["checkout.open"] },
				body: { session: "{session}" },
				operationId: "checkout.confirm",
			},
		],
	}
	const external = async (name: string, input: Record<string, unknown>) => {
		seen.push({ input, name })
		return "cs_1-paid"
	}
	const result = await runWith(api, {
		hooks: { external },
		ops: ["checkout.open", "checkout.confirm"],
		scenarios: [scenario],
	})
	expect(seen).toEqual([{ input: { url: "https://pay.example/session/cs_1" }, name: "pay-with-test-card" }])
	expect(row(result, "checkout.open")?.tier).toBe("verified")
	expect(row(result, "checkout.confirm")?.status).toBe("passed")
}

async function keepsObjectsWhole(): Promise<void> {
	const api = await serve()
	const seen: unknown[] = []
	const scenario: Scenario = {
		covers: ["ceremony.options", "ceremony.verify"],
		id: "ceremony",
		steps: [
			{ operationId: "ceremony.options", saveAs: { options: "$.options" } },
			{ as: "credential", external: "sign", input: { options: "{options}" } },
			{
				assert: { equals: "true", from: "$.verified", observes: ["ceremony.options"] },
				body: { credential: "{credential}" },
				operationId: "ceremony.verify",
			},
		],
	}
	const external = async (_name: string, input: Record<string, unknown>) => {
		seen.push(input)
		const options = input["options"] as { challenge: string }
		return JSON.stringify({ signed: options.challenge })
	}
	const result = await runWith(api, {
		hooks: { external },
		ops: ["ceremony.options", "ceremony.verify"],
		scenarios: [scenario],
	})
	expect(seen).toEqual([{ options: { challenge: "ch_1", rp: { id: "example.test" } } }])
	expect(row(result, "ceremony.verify")?.status).toBe("passed")
	const sent = result.client.transcript.find((exchange) => exchange.operationId === "ceremony.verify")
	expect(sent?.requestBody).toEqual({ credential: { signed: "ch_1" } })
}

async function provesRemoval(): Promise<void> {
	const api = await serve()
	const scenario: Scenario = {
		covers: ["notes.write", "stats.get"],
		id: "gone",
		steps: [
			{ body: { text: "keep-me" }, operationId: "notes.write" },
			{
				assert: { excludes: "never-written", from: "$.texts[*]", observes: ["notes.write"] },
				operationId: "stats.get",
			},
		],
	}
	const result = await runWith(api, { ops: ["notes.write", "stats.get"], scenarios: [scenario] })
	expect(row(result, "notes.write")?.tier).toBe("verified")
	expect(row(result, "notes.write")?.evidence?.observation).toMatchObject({ absent: true, value: "never-written" })
	const failing: Scenario = {
		...scenario,
		id: "still-there",
		steps: [
			scenario.steps[0] as Scenario["steps"][number],
			{ assert: { excludes: "keep-me", from: "$.texts[*]", observes: ["notes.write"] }, operationId: "stats.get" },
		],
	}
	const refused = await runWith(await serve(), { ops: ["notes.write", "stats.get"], scenarios: [failing] })
	expect(row(refused, "notes.write")?.status).toBe("failed")
}

async function bindsTokenClaims(): Promise<void> {
	const api = await serve()
	const scenario: Scenario = {
		covers: ["token.mint", "user.get"],
		id: "claims",
		steps: [
			{
				operationId: "token.mint",
				saveAs: { token: "$.token" },
				saveClaimsFrom: { bind: { userId: "sub" }, token: "token" },
			},
			{
				assert: { equals: "usr_42", from: "$.id", observes: ["token.mint"] },
				bind: { user_id: "{userId}" },
				operationId: "user.get",
			},
		],
	}
	const result = await runWith(api, { ops: ["token.mint", "user.get"], scenarios: [scenario] })
	expect(row(result, "user.get")?.status).toBe("passed")
	expect(row(result, "token.mint")?.tier).toBe("verified")
}

async function keepsObservationWithItsCall(): Promise<void> {
	const api = await serve()
	const scenario: Scenario = {
		covers: ["notes.write"],
		id: "twice",
		steps: [
			{ body: { text: "once" }, operationId: "notes.write" },
			{ assert: { contains: "once", from: "$.items[*].text", observes: ["notes.write"] }, operationId: "notes.list" },
			{ body: { text: "twice" }, operationId: "notes.write" },
		],
	}
	const result = await runWith(api, { ops: ["notes.write"], scenarios: [scenario] })
	const evidence = row(result, "notes.write")?.evidence
	const call = result.client.transcript.find((exchange) => exchange.seq === evidence?.call)
	expect(call?.requestBody).toEqual({ text: "once" })
	expect(evidence?.observation?.seq).toBeGreaterThan(evidence?.call ?? Number.POSITIVE_INFINITY)
}

async function refusesSelfProof(): Promise<void> {
	const api = await serve()
	const scenario: Scenario = {
		covers: ["checkout.open"],
		id: "self-proof",
		steps: [{ assert: { contains: "cs_1", from: "$.url" }, operationId: "checkout.open" }],
	}
	const result = await runWith(api, { ops: ["checkout.open"], scenarios: [scenario] })
	expect(row(result, "checkout.open")?.status).toBe("passed")
	expect(row(result, "checkout.open")?.tier).toBe("contract")
}

async function startsWithPrincipalRoots(): Promise<void> {
	const api = await serve()
	const scenario: Scenario = {
		covers: ["user.get"],
		id: "roots",
		steps: [
			{ expect: [401], operationId: "notes.list", principal: "nobody" },
			{ assert: { equals: "usr_42", from: "$.id" }, bind: { user_id: "{owner_id}" }, operationId: "user.get" },
		],
	}
	const result = await run({
		baseUrl: api.url,
		ops: ["user.get"],
		principals: [
			{ headers: { authorization: "Bearer alpha" }, id: "alpha", roots: { owner_id: "usr_42" } },
			{ headers: { authorization: "Bearer nobody" }, id: "nobody" },
		],
		scenarios: [scenario],
		seed: 1,
		spec: `${api.url}/openapi.json`,
	})
	expect(row(result, "user.get")?.status).toBe("passed")
	const refused = result.client.transcript.find(
		(exchange) => exchange.operationId === "notes.list" && exchange.status === 401,
	)
	expect(refused?.requestHeaders.authorization).toBe("Bearer nobody")
}

async function sendsNamedMediaType(): Promise<void> {
	const api = await serve()
	const scenario: Scenario = {
		covers: ["form.send"],
		id: "form",
		steps: [
			{
				assert: { contains: "application/x-www-form-urlencoded", from: "$.type" },
				body: { text: "plain words" },
				mediaType: "application/x-www-form-urlencoded",
				operationId: "form.send",
			},
		],
	}
	const result = await runWith(api, { ops: ["form.send"], scenarios: [scenario] })
	expect(row(result, "form.send")?.status).toBe("passed")
	const sent = result.client.transcript.find((exchange) => exchange.operationId === "form.send")
	expect(JSON.stringify(sent?.requestBody)).toContain("plain words")
}

async function refusesUncalledCover(): Promise<void> {
	const api = await serve()
	const scenario: Scenario = { ...RENAME, covers: [...RENAME.covers, "stats.get"] }
	await expect(runWith(api, { ops: ["notes.write"], scenarios: [scenario] })).rejects.toThrow(
		'scenario "notes" covers stats.get but no step calls it',
	)
}

describe("scenarios", () => {
	it("grades each covered operation verified when a later read shows its value", gradesVerified)
	it(
		"fails the operation whose read does not show it and blocks what the scenario never reached",
		failsUnshownAndBlocksUnreached,
	)
	it("polls an eventually consistent read until it shows the call's value", pollsLaggingRead)
	it("fails a lagging read without poll", failsLaggingReadWithoutPoll)
	it("hands a browser step to the external hook and feeds its answer forward", handsBrowserStepToHook)
	it("keeps an object a response or a hook returns, and sends it whole where a body names it", keepsObjectsWhole)
	it("proves a removal by a later read that no longer holds the value", provesRemoval)
	it("binds values out of a token's claims, as an auth flow does", bindsTokenClaims)
	it("keeps each observation with the call it saw, when an operation is called again", keepsObservationWithItsCall)
	it("does not let a write's own response prove that write", refusesSelfProof)
	it(
		"starts each scenario with its principal's roots, and lets a step speak as another principal",
		startsWithPrincipalRoots,
	)
	it("sends the request media type a step names, among those the operation documents", sendsNamedMediaType)
	it("refuses a scenario that covers an operation it never calls", refusesUncalledCover)
})
