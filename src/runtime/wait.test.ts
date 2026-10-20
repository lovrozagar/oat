import { describe, expect, it } from "vitest"
import type { SideEffectRequest } from "../config/types/hooks.ts"
import { type Answer, json, transport } from "../client/__fixtures__/transport.ts"
import { Client } from "../client/client.ts"
import { fixedSource, sendingHeaders } from "../client/__fixtures__/source.ts"
import { Redactor } from "../security/redact.ts"
import type { WaitSpec } from "../spec/extensions/async.ts"
import type { OperationModel } from "../spec/graph/types.ts"
import { driveWait, pointerIsOccupied, type WaitDrive } from "./wait.ts"

describe("pointerIsOccupied", () => {
	it("is anything but undefined, null, an empty string, or an empty list", () => {
		for (const empty of [undefined, null, "", []]) expect(pointerIsOccupied(empty)).toBe(false)
		for (const present of [0, false, "x", [1], {}]) expect(pointerIsOccupied(present)).toBe(true)
	})
})

const POLL = { method: "GET", operationId: "inbox.list", path: "/inbox/{user}" } as OperationModel

const answers =
	(...replies: Array<[number, unknown]>): Answer =>
	(_sent, index) => {
		const [status, body] = replies[Math.min(index, replies.length - 1)] as [number, unknown]
		return json(body, status)
	}

function wait(answer: Answer, more: Partial<Omit<WaitDrive, "spec">> & { spec?: Partial<WaitSpec> } = {}) {
	const wire = transport(answer)
	const source = fixedSource(sendingHeaders({ authorization: "Bearer t" }))
	const client = new Client({
		baseUrl: "http://api.test",
		credentials: source,
		network: { fetchImpl: wire.fetch },
		redactor: new Redactor(),
	})
	const { spec, ...rest } = more
	const outcome = driveWait({
		client,
		principal: "alpha",
		pollOp: POLL,
		record: { id: "r1" },
		scope: { user: "u1" },
		spec: { operationId: "inbox.list", pollIntervalMs: 1, timeoutMs: 1_000, ...spec },
		writeOpId: "row.create",
		...rest,
	})
	return { outcome, sent: wire.sent, source }
}

/* An answer that arrives after a 5ms wait has run out. */
const slow: Answer = () => new Promise((done) => setTimeout(() => done(json([], 200)), 30))
const always = (): Promise<true | null> => Promise.resolve(true)
const never = (): Promise<true | null> => Promise.resolve(null)

describe("driveWait, with nothing declared", () => {
	it("stops at the first occupied success answer", async () => {
		const { outcome, sent } = wait(answers([409, { error: "x" }], [200, []], [200, [{ id: "m1" }]]))
		expect(await outcome).toMatchObject({ matched: [{ id: "m1" }], polls: 3, timedOut: false })
		expect(sent[0]?.url).toBe("http://api.test/inbox/u1")
	})

	it("times out when the poll path cannot be filled, or no time is given", async () => {
		const unfillable = wait(answers([200, [1]]), { scope: {} })
		expect(await unfillable.outcome).toMatchObject({ matched: undefined, polls: 0, timedOut: true })
		expect(unfillable.sent).toEqual([])
		const instant = wait(answers([200, [1]]), { spec: { timeoutMs: 0 } })
		expect(await instant.outcome).toMatchObject({ polls: 0, timedOut: true })
	})

	it("stops polling once a slow answer has spent the time left", async () => {
		const { outcome } = wait(slow, { spec: { timeoutMs: 5 } })
		expect(await outcome).toMatchObject({ polls: 1, timedOut: true })
	})
})

describe("driveWait, with until or a hook", () => {
	it("matches until's pointer when it is occupied", async () => {
		const { outcome } = wait(answers([200, { items: [] }], [200, { items: ["e1"] }]), { spec: { until: "/items" } })
		expect(await outcome).toMatchObject({ matched: ["e1"], polls: 2, timedOut: false })
	})

	it("asks the hook every poll, with the answer or else the written record", async () => {
		const asked: SideEffectRequest[] = []
		const awaitSideEffect = (request: SideEffectRequest): Promise<true | null> => {
			asked.push(request)
			return Promise.resolve(request.attempt === 2 ? true : null)
		}
		const { outcome } = wait(answers([500, {}], [200, { seen: 1 }]), { awaitSideEffect })
		expect(await outcome).toMatchObject({ matched: { seen: 1 }, polls: 2, timedOut: false })
		expect(asked).toEqual([
			{ attempt: 1, operationId: "row.create", record: { id: "r1" } },
			{ attempt: 2, operationId: "row.create", record: { seen: 1 } },
		])
	})

	it("lets the hook end the wait even while until is empty", async () => {
		const { outcome } = wait(answers([200, { items: [] }]), { awaitSideEffect: always, spec: { until: "/items" } })
		expect(await outcome).toMatchObject({ matched: [], polls: 1, timedOut: false })
		const missed = wait(answers([200, { items: [] }]), { awaitSideEffect: never, spec: { timeoutMs: 15 } })
		expect(await missed.outcome).toMatchObject({ matched: undefined, timedOut: true })
	})

	it("polls the operation as the principal, its credential resolved for every poll", async () => {
		const { outcome, sent, source } = wait(answers([200, [1]]))
		await outcome
		expect(source.asked).toEqual([
			{ actor: { principal: "alpha" }, operationId: "inbox.list", probe: false, route: "GET /inbox/u1" },
		])
		expect(sent[0]?.headers.authorization).toBe("Bearer t")
	})
})
