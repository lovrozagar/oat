import { describe, expect, it } from "vitest"
import { fixedSource } from "../../../../client/__fixtures__/source.ts"
import { json as answer, transport } from "../../../../client/__fixtures__/transport.ts"
import { wireOf } from "../../../../client/__fixtures__/wire.ts"
import { prepare, sendAttempt } from "../../../../client/request.ts"
import type { Exchange } from "../../../exchange.ts"
import { contextFor } from "../../__fixtures__/harness.ts"
import { describeUndeclared, documentedStatusHonoured } from "./response-status-is-documented.ts"
import {
	GATE_BODY,
	ITEM,
	json,
	modelOfItems,
	overTranscript,
	seen,
	type Transcript,
	unnamed,
} from "./__fixtures__/items.ts"

/* The update documents only its 200 here, so a gated 403 is declared by the gate alone. */
const model = modelOfItems({ update: { "200": json(ITEM) } })

async function judge(exchanges: Exchange[], transcript: Transcript = {}) {
	const judged: string[][] = []
	const fields = { judged: (ids: readonly string[]) => judged.push([...ids]), ...transcript.fields }
	const staged = overTranscript(model, exchanges, { ...transcript, fields })
	const outcome = await documentedStatusHonoured.run(staged.ctx, undefined)
	return { ...staged, judged, outcome }
}

describe("response.status-is-documented plan", () => {
	it("applies to an entity with any operation besides its create", () => {
		const { ctx } = contextFor(model, "item.list", { respond: () => undefined })
		expect(documentedStatusHonoured.plan(ctx).ok).toBe(true)
		expect(documentedStatusHonoured.plan({ ...ctx, entityName: "ghost" }).ok).toBe(false)
	})
})

describe("response.status-is-documented run", () => {
	it("asserts when every status was declared, and names the operations it observed", async () => {
		const { findings, judged, outcome } = await judge([
			seen("item.read", { status: 200 }),
			seen("item.read", { status: 404 }),
			seen("item.update", { status: 200 }),
		])
		expect(outcome).toEqual({ kind: "asserted" })
		expect(findings.findings).toEqual([])
		expect(judged).toEqual([["item.read", "item.update"]])
	})

	it("reports an undeclared status as a spec bug on its operation, citing its first exchange", async () => {
		const first = seen("item.read", { status: 500 })
		const { findings, outcome } = await judge([
			first,
			seen("item.read", { status: 418 }),
			seen("item.read", { status: 500 }),
		])
		expect(outcome).toEqual({ kind: "finding", verdict: "SPEC_BUG" })
		expect(findings.findings).toHaveLength(1)
		const [finding] = findings.findings
		expect(finding?.summary).toBe("an operation returned a status the document does not declare")
		expect(finding?.detail).toBe(
			"item.read returned 418, 500; the document declares 200, 404. Clients generated from this document will not recognise the response.",
		)
		expect(finding?.operations).toEqual(["item.read"])
		expect(finding?.evidence).toEqual([first])
	})

	it("leaves a security probe's 401 to the security checks, and still grades the same 401 on a normal request", async () => {
		const probed = await judge([
			seen("item.read", { status: 401 }, { probe: true }),
			seen("item.read", { status: 401 }, { forged: true }),
		])
		expect([probed.outcome, probed.findings.findings]).toEqual([{ kind: "asserted" }, []])
		const normal = await judge([seen("item.read", { status: 401 })])
		expect(normal.outcome).toEqual({ kind: "finding", verdict: "SPEC_BUG" })
	})

	it("reports what deliberately invalid probes drew apart from ordinary traffic", async () => {
		const probe = seen("item.read", { status: 400 }, { purpose: "probe" })
		const alone = await judge([probe])
		expect(alone.outcome).toEqual({ kind: "asserted" })
		expect(alone.findings.findings.map((f) => [f.verdict, f.summary, f.operations])).toEqual([
			["SPEC_BUG", "requests oat sent to be refused drew statuses the document does not declare", ["item.read"]],
		])
		expect(alone.findings.findings[0]?.detail).toContain(
			"item.read returned 400; the document declares 200, 404. These were deliberately invalid probes",
		)

		const both = await judge([probe, seen("item.update", { status: 502 })])
		expect(both.outcome).toEqual({ kind: "finding", verdict: "SPEC_BUG" })
		expect(both.findings.findings.map((f) => f.operations)).toEqual([["item.read"], ["item.update"]])
	})
})

describe("response.status-is-documented and a dedicated credential", () => {
	it("judges the contract floor's call sent with a dedicated credential: a dedicated actor alone is no probe", async () => {
		const wire = wireOf(
			transport(() => answer({}, 418)),
			{
				credentials: fixedSource({
					block: () => undefined,
					kind: "sends",
					principal: "alpha",
					schemes: [],
					secrets: { cookies: [], headers: [], query: [], values: [] },
					sends: {},
					sentValues: {},
					refresh: async () => ({ kind: "anonymous" }),
				}),
				operationResolver: () => ({ entity: "item", operationId: "item.read", template: "/items/{item_id}" }),
			},
		)
		const floor = { as: { principal: "alpha#probe-1" }, operationId: "item.read" }
		const sent = await sendAttempt(prepare(wire, "GET", "/items/1", floor), 0, wire)
		const { findings, outcome } = await judge([sent])
		expect(outcome).toEqual({ kind: "finding", verdict: "SPEC_BUG" })
		expect(findings.findings[0]?.detail).toContain("item.read returned 418")
	})
})

describe("response.status-is-documented stand-asides", () => {
	it("passes over what is not the backend's verdict on this entity's graded operations", async () => {
		const { findings, judged, outcome } = await judge(
			[
				seen("item.read", { status: 0 }),
				seen("item.read", { status: 500 }, { superseded: true }),
				unnamed({ status: 500 }),
				seen("nothing.here", { status: 500 }),
				seen("other.list", { status: 500 }),
				seen("item.create", { status: 500 }),
				seen("item.read", { status: 429 }),
				seen("item.delete", { status: 500 }),
				seen("item.update", { status: 500 }),
				seen("item.read", { status: 200 }),
			],
			{ fields: { inScope: (op) => op.operationId !== "item.update" } },
		)
		expect(outcome).toEqual({ kind: "asserted" })
		expect(findings.findings).toEqual([])
		expect(judged).toEqual([["item.read"]])
	})

	it("treats an operation as the create by its action when the context names no create", async () => {
		const { findings } = await judge([seen("item.create", { status: 500 })], { fields: { createOp: undefined } })
		expect(findings.findings).toEqual([])
	})

	it("reads a 403's body back to tell a documented feature gate from an undeclared refusal", async () => {
		const gate = seen("item.update", { status: 403 })
		const gated = await judge([gate], { stored: new Map([[gate, GATE_BODY]]) })
		expect(gated.hydrated).toEqual([gate])
		expect(gated.outcome).toEqual({ kind: "asserted" })
		expect(gated.judged).toEqual([["item.update"]])

		const refused = await judge([seen("item.update", { status: 403, body: { error: "no" } })])
		expect(refused.outcome).toEqual({ kind: "finding", verdict: "SPEC_BUG" })
		expect(refused.findings.findings[0]?.detail).toContain("item.update returned 403; the document declares 200.")
	})

	it("still judges without a run that asks what was judged", async () => {
		const { ctx, findings } = overTranscript(model, [seen("item.read", { status: 500 })])
		expect(await documentedStatusHonoured.run(ctx, undefined)).toEqual({
			kind: "finding",
			verdict: "SPEC_BUG",
		})
		expect(findings.findings).toHaveLength(1)
	})
})

describe("describeUndeclared", () => {
	const { ctx } = contextFor(model, "item.list", { respond: () => undefined })

	it("says when an operation declares no concrete status, or is not in the document", () => {
		const { lines, evidence } = describeUndeclared(
			ctx,
			new Map([
				["item.delete", [seen("item.delete", { status: 500 })]],
				["gone", []],
			]),
		)
		expect(lines).toEqual([
			"item.delete returned 500; the document declares no concrete status",
			"gone returned ; the document declares no concrete status",
		])
		expect(evidence).toHaveLength(1)
	})

	it("cites at most six exchanges, one per operation", () => {
		const byOp = new Map(Array.from({ length: 7 }, (_, i) => [`op${i}`, [seen(`op${i}`, { status: 500 })]]))
		expect(describeUndeclared(ctx, byOp).evidence).toHaveLength(6)
	})
})
