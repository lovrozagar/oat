import { describe, expect, it } from "vitest"
import { exchange, op } from "../checks/__fixtures__/harness.ts"
import { ASSERTED } from "../finding.ts"
import { me, selfInput } from "./__fixtures__/me.ts"
import { locateProbe } from "./locate.ts"
import {
	answeredWithoutToken,
	echoMissed,
	notStuck,
	readRefused,
	restorable,
	type SelfRun,
	type UpdateProbe,
	updatedAlone,
	updateProbe,
	writeRefused,
} from "./verdicts.ts"

const updateFrom = (current: unknown): UpdateProbe => {
	const { run } = selfRun()
	return {
		before: locateProbe({ display_name: current }, "display_name"),
		field: { kind: "string", maxLength: 40, name: "display_name" },
		op: run.updateOp as NonNullable<SelfRun["updateOp"]>,
		path: "/me",
		value: "Oat",
	}
}

function selfRun(document = me()) {
	const { findings, model, input } = selfInput(() => undefined, document)
	const readOp = model.byOperationId.get("me.get")
	const updateOp = model.byOperationId.get("me.update")
	const probe = readOp ?? op(model, "me.update")
	const run: SelfRun = {
		entity: input.entity,
		findings,
		probe,
		probePath: "/me",
		readOp,
		readOps: readOp === undefined ? [] : [readOp],
		updateOp,
	}
	return { findings, model, run }
}

const answer = (status: number, body?: unknown) => exchange("GET", "/me", { body, status })

describe("the answers on the caller's routes", () => {
	it("flags a route that answers without a token", () => {
		const { run, findings } = selfRun()
		expect(answeredWithoutToken(run, answer(200))).toEqual({ kind: "finding", verdict: "SECURITY" })
		expect(findings.findings[0]?.detail).toContain("me.get returned 200 with no credential")
	})

	it("judges the update alone when there is no read", () => {
		const { run, findings } = selfRun(me({ read: false }))
		expect(updatedAlone(run, answer(401), answer(204))).toBe(ASSERTED)
		expect(updatedAlone(run, answer(401), answer(429))).toMatchObject({ kind: "unresolved" })
		expect(updatedAlone(run, answer(401), answer(500))).toEqual({ kind: "finding", verdict: "BACKEND_BUG" })
		expect(updatedAlone(run, answer(401), answer(101))).toEqual({ kind: "finding", verdict: "BACKEND_BUG" })
		expect(findings.findings[0]?.detail).toBe("me.update returned 500 for the signed-up caller.")
	})

	it("passes a read of 200 and reports anything else", () => {
		const { run } = selfRun()
		const readOp = run.readOp as NonNullable<SelfRun["readOp"]>
		expect(readRefused(run, readOp, answer(401), answer(200))).toBeNull()
		expect(readRefused(run, readOp, answer(401), answer(429))).toMatchObject({ kind: "unresolved" })
		expect(readRefused(run, readOp, answer(401), answer(204))).toEqual({ kind: "finding", verdict: "BACKEND_BUG" })
	})

	it("reports a create the next read does not show", () => {
		const { run } = selfRun()
		const readOp = run.readOp as NonNullable<SelfRun["readOp"]>
		const created = { body: { handle: "h" }, exchange: exchange("POST", "/me", { status: 201 }) }
		expect(echoMissed(run, null, readOp, answer(200, {}))).toBeNull()
		expect(echoMissed(run, created, readOp, answer(200, { handle: "h" }))).toBeNull()
		expect(echoMissed(run, created, readOp, answer(200, { handle: "x" }))).toEqual({
			kind: "finding",
			verdict: "BACKEND_BUG",
		})
	})
})

describe("the update the check sends", () => {
	it("picks the field and the value to set it to", () => {
		const { run, model } = selfRun()
		expect(updateProbe(run, model, answer(200, { display_name: "Oat" }))).toMatchObject({
			field: { name: "display_name" },
			path: "/me",
			value: "Xot",
		})
	})

	it("ends without one when there is no update, it needs an id, or it has no field to change", () => {
		expect(updateProbe(selfRun(me({ update: false })).run, selfRun().model, answer(200))).toBe(ASSERTED)
		const pathed = selfRun(me({ updatePath: "/me/{slot}" }))
		expect(updateProbe(pathed.run, pathed.model, answer(200))).toBe(ASSERTED)
		const fieldless = selfRun(me({ update: { properties: { size: { type: "integer" } }, type: "object" } }))
		expect(updateProbe(fieldless.run, fieldless.model, answer(200))).toEqual({
			kind: "unresolved",
			reason: "the update has no plain string or boolean field to change",
		})
	})
})

describe("how the update went", () => {
	it("passes a write that succeeded, and reports one that did not", () => {
		const { run } = selfRun()
		expect(writeRefused(run, updateFrom("a"), answer(200), answer(200))).toBeNull()
		expect(writeRefused(run, updateFrom("a"), answer(200), answer(429))).toMatchObject({ kind: "unresolved" })
		expect(writeRefused(run, updateFrom("a"), answer(200), answer(422))).toEqual({
			kind: "finding",
			verdict: "BACKEND_BUG",
		})
		expect(writeRefused(run, updateFrom("a"), answer(200), answer(102))).toEqual({
			kind: "finding",
			verdict: "BACKEND_BUG",
		})
	})

	it("passes an update the next read shows, and reports one it does not", () => {
		const { run, findings } = selfRun()
		const wrote = answer(200)
		expect(notStuck(run, updateFrom("a"), wrote, answer(200, { display_name: "Oat" }))).toBeNull()
		expect(notStuck(run, updateFrom("a"), wrote, answer(429))).toMatchObject({ kind: "unresolved" })
		expect(notStuck(run, updateFrom("a"), wrote, answer(500, { display_name: "Oat" }))).toEqual({
			kind: "finding",
			verdict: "BACKEND_BUG",
		})
		expect(notStuck(run, updateFrom("a"), wrote, answer(200, { x: { display_name: "a" } }))).toMatchObject({
			kind: "finding",
		})
		expect(findings.findings.map((finding) => finding.detail)).toEqual([
			'me.update set display_name to "Oat", and the next me.get returned 500 with "Oat".',
			'me.update set display_name to "Oat", and the next me.get returned 200 with ["a"].',
		])
	})

	it("puts back a plain value, and leaves anything else", () => {
		expect([restorable(updateFrom("a")), restorable(updateFrom(null)), restorable(updateFrom(true))]).toEqual([
			true,
			true,
			true,
		])
		expect([restorable(updateFrom(undefined)), restorable(updateFrom(3))]).toEqual([false, false])
	})
})
