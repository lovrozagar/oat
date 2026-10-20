import { describe, expect, it } from "vitest"
import type { Exchange } from "../runtime/exchange.ts"
import { type ControlRead, createControls, type Sent } from "./control.ts"

/*
 * A freshly renewed credential that is refused is sent once more on the last read that accepted its
 * principal × scheme. Refused there too, the pair is BLOCKED; accepted, the refusal is the route's own;
 * with no such read, nothing is decided. One verdict per renewed value.
 */

const accepted = (over: Partial<Exchange> = {}, without?: "principal" | "schemes"): Exchange => {
	const exchange = { method: "GET", principal: "alpha", schemes: ["jwt"], seq: 1, status: 200, ...over } as Exchange
	if (without !== undefined) delete exchange[without]
	return exchange
}

const READ: ControlRead = {
	method: "GET",
	operationId: "profile.get",
	options: { as: { principal: "alpha" } },
	path: "/me",
}

function sent(value = "v2"): Sent & { blocked: string[] } {
	const blocked: string[] = []
	return { block: (reason) => blocked.push(reason), blocked, principal: "alpha", sentValues: { jwt: value } }
}

const answering = (status: number) => {
	const reads: ControlRead[] = []
	return { reads, send: async (read: ControlRead) => (reads.push(read), { status } as Exchange) }
}

describe("createControls", () => {
	it("blocks the pair when the last read that accepted it refuses the renewed credential too", async () => {
		const controls = createControls()
		controls.note(accepted(), READ)
		const refused = sent()
		const control = answering(401)
		await controls.confirm(refused, control.send)
		expect(control.reads).toEqual([READ])
		expect(refused.blocked).toEqual([
			"signed in again, and the new credential is refused where the old one was accepted (profile.get)",
		])
	})

	it("blocks nothing when the control accepts it: the refusal is the route's own", async () => {
		const controls = createControls()
		controls.note(accepted(), READ)
		const refused = sent()
		await controls.confirm(refused, answering(200).send)
		expect(refused.blocked).toEqual([])
	})

	it("decides nothing without a read that accepted the pair", async () => {
		const controls = createControls()
		const refused = sent()
		const control = answering(401)
		await controls.confirm(refused, control.send)
		expect([control.reads, refused.blocked]).toEqual([[], []])
	})
})

describe("createControls: what it keeps", () => {
	it("judges each renewed value once, however many requests it refused", async () => {
		const controls = createControls()
		controls.note(accepted(), READ)
		const control = answering(401)
		await Promise.all([controls.confirm(sent(), control.send), controls.confirm(sent(), control.send)])
		expect(control.reads).toHaveLength(1)
	})

	it("knows a value a renewal issued, so a refusal of it goes to the control and never renews it", () => {
		const controls = createControls()
		expect(controls.renewal(sent())).toBe(false)
		controls.renewed(sent())
		expect([controls.renewal(sent()), controls.renewal(sent("v3"))]).toEqual([true, false])
	})

	it("keeps only a read that accepted a principal's credential, the latest, named by method and path without an id", async () => {
		const controls = createControls()
		for (const rejected of [
			accepted({ method: "POST" }),
			accepted({ status: 401 }),
			accepted({ status: 302 }),
			accepted({}, "principal"),
			accepted({ forged: true }),
			accepted({}, "schemes"),
		]) {
			controls.note(rejected, { ...READ, path: "/never" })
		}
		const unnamed = { ...READ, operationId: undefined, path: "/later" }
		controls.note(accepted({ method: "QUERY" }), READ)
		controls.note(accepted({ method: "HEAD" }), unnamed)
		const refused = sent()
		const control = answering(401)
		await controls.confirm(refused, control.send)
		expect(control.reads).toEqual([unnamed])
		expect(refused.blocked[0]).toMatch(/\(GET \/later\)$/)
	})
})
