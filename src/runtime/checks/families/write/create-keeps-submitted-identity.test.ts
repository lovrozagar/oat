import { describe, expect, it } from "vitest"
import { contextFor, modelOf, op, type Responder } from "../../__fixtures__/harness.ts"
import { runCheck } from "../../core/run.ts"
import { createKeepsSubmittedIdentity } from "./create-keeps-submitted-identity.ts"
import { overriding, WIDGET, widgetApi, widgetDoc, type WidgetDocOptions } from "./__fixtures__/widget-api.ts"

/* A widget whose id the client chooses. */
const CLIENT_ID = {
	...WIDGET,
	properties: { ...(WIDGET.properties as object), id: { type: "string" } },
}

function stage(respond: Responder, options: WidgetDocOptions = {}) {
	const model = modelOf(widgetDoc({ item: CLIENT_ID, ...options }))
	return contextFor(model, "listWidgets", {
		respond,
		fields: {
			createOp: op(model, "createWidget"),
			readOp: model.byOperationId.get("getWidget"),
		},
	})
}

type Staged = ReturnType<typeof stage>

/** The run's creates, as the transcript holds them: each body as sent, on the create's own path. */
async function creates(ctx: Staged["ctx"], bodies: unknown[], path = "/widgets"): Promise<void> {
	for (const body of bodies)
		await ctx.client.request("POST", path, { as: { principal: "alpha" }, body, operationId: "createWidget" })
}

const reads = (sent: Staged["sent"]) => sent.filter((s) => s.method === "GET").map((s) => s.path)

describe("create.keeps-submitted-identity verdicts", () => {
	it("passes creates that store each record under the id they were sent", async () => {
		const { ctx, findings, sent } = stage(widgetApi())
		await creates(ctx, [
			{ id: "k1", name: "a" },
			{ id: 7, name: "b" },
		])
		expect(await runCheck(createKeepsSubmittedIdentity, ctx)).toEqual({ kind: "asserted" })
		expect(findings.findings).toEqual([])
		expect(reads(sent)).toEqual([])
	})

	it("judges at most three creates, each a distinct id, and only those that chose one", async () => {
		/* The fourth distinct id would fail: sampling stops before it. */
		const { ctx, findings } = stage(
			overriding(widgetApi(), (_, __, options) =>
				(options.body as { id?: unknown }).id === "k4" ? { body: { id: "other" }, status: 201 } : undefined,
			),
		)
		await creates(ctx, [
			"not a record",
			[{ id: "x" }],
			{ name: "no id" },
			{ id: "k1", name: "a" },
			{ id: "k1", name: "again" },
			{ id: "k2", name: "b" },
			{ id: "k3", name: "c" },
			{ id: "k4", name: "d" },
		])
		expect(await runCheck(createKeepsSubmittedIdentity, ctx)).toEqual({ kind: "asserted" })
		expect(findings.findings).toEqual([])
	})

	it("reports a create that answers with an id other than the one it was sent", async () => {
		const { ctx, findings } = stage(() => ({ body: { id: "w99", name: "a" }, status: 201 }))
		await creates(ctx, [{ id: "k1", name: "a" }])
		expect(await runCheck(createKeepsSubmittedIdentity, ctx)).toEqual({ kind: "finding", verdict: "BACKEND_BUG" })
		expect(findings.findings[0]?.summary).toBe("create answers with an identity other than the one it was sent")
		expect(findings.findings[0]?.detail).toContain('"id" was sent "k1" and the create answered "w99"')
	})

	it("reads an acknowledgement-only create back under the id it was sent", async () => {
		const rows = new Map<string, Record<string, unknown>>()
		const api = widgetApi(rows)
		const { ctx, findings, sent } = stage(
			overriding(api, (method, path, options) =>
				method === "POST" ? { body: { id: null }, status: (api(method, path, options), 202) } : undefined,
			),
		)
		await creates(ctx, [{ id: "k1", name: "a" }])
		expect(await runCheck(createKeepsSubmittedIdentity, ctx)).toEqual({ kind: "asserted" })
		expect(findings.findings).toEqual([])
		expect(reads(sent)).toEqual(["/widgets/k1"])
	})
})

describe("create.keeps-submitted-identity on an acknowledgement-only create", () => {
	it("reports an acknowledged create that stored the record under another id", async () => {
		/* The backend keeps the row under an id of its own, so the client's id finds nothing. */
		const { ctx, findings } = stage((method, path) =>
			method === "POST" ? { body: {}, status: 202 } : path === "/widgets/k1" ? { status: 404 } : undefined,
		)
		await creates(ctx, [{ id: "k1", name: "a" }])
		expect(await runCheck(createKeepsSubmittedIdentity, ctx)).toEqual({ kind: "finding", verdict: "BACKEND_BUG" })
		expect(findings.findings[0]?.summary).toBe(
			"create acknowledged a record that is not under the identity it was sent",
		)
		expect(findings.findings[0]?.detail).toContain("the read under that id returned 404")
		expect(findings.findings[0]?.evidence.map((e) => e.status)).toEqual([202, 404])
	})

	it("reports an acknowledged create whose read answers a different record", async () => {
		const { ctx, findings } = stage((method) =>
			method === "POST" ? { body: {}, status: 202 } : { body: { id: "someone-else" }, status: 200 },
		)
		await creates(ctx, [{ id: "k1", name: "a" }])
		expect(await runCheck(createKeepsSubmittedIdentity, ctx)).toEqual({ kind: "finding", verdict: "BACKEND_BUG" })
		expect(findings.findings[0]?.detail).toContain("the read under that id returned 200")
	})
})

describe("create.keeps-submitted-identity preconditions", () => {
	it("is unresolved when no create with a client-chosen id was observed", async () => {
		const { ctx, findings } = stage(() => ({ status: 500 }))
		await creates(ctx, [{ id: "k1", name: "failed" }])
		await creates(ctx, [{ id: "k2", name: "elsewhere" }], "/gadgets")
		expect(await runCheck(createKeepsSubmittedIdentity, ctx)).toEqual({
			kind: "unresolved",
			reason: "no create carrying a client-chosen identity was observed",
		})
		expect(findings.inconclusive).toHaveLength(1)
	})

	it("finds no creates when the create is absent or its path cannot be resolved", async () => {
		const { ctx } = stage(widgetApi())
		const plan = createKeepsSubmittedIdentity.plan(ctx)
		if (!plan.ok) throw new Error("expected the check to apply")
		const createOp = ctx.createOp
		if (createOp === undefined) throw new Error("expected a create")
		await creates(ctx, [{ id: "k1", name: "a" }])
		const unresolved = { kind: "unresolved", reason: "no create carrying a client-chosen identity was observed" }
		expect(await createKeepsSubmittedIdentity.run({ ...ctx, createOp: undefined }, plan.value)).toEqual(unresolved)
		const scoped = { ...createOp, path: "/orgs/{org}/widgets" }
		expect(await createKeepsSubmittedIdentity.run({ ...ctx, createOp: scoped }, plan.value)).toEqual(unresolved)
	})

	it("applies only to a create that takes a writable identity, with an item read", () => {
		expect(createKeepsSubmittedIdentity.plan(stage(widgetApi()).ctx).ok).toBe(true)
		/* The server issues the id. */
		const issued = modelOf(widgetDoc())
		const { ctx: serverIds } = contextFor(issued, "listWidgets", {
			respond: widgetApi(),
			fields: {
				createOp: op(issued, "createWidget"),
				readOp: op(issued, "getWidget"),
			},
		})
		expect(createKeepsSubmittedIdentity.plan(serverIds).ok).toBe(false)
		/* The body has no identity at all. */
		expect(createKeepsSubmittedIdentity.plan({ ...serverIds, identity: "sku" }).ok).toBe(false)
		expect(createKeepsSubmittedIdentity.plan({ ...serverIds, readOp: undefined }).ok).toBe(false)
		expect(createKeepsSubmittedIdentity.plan({ ...serverIds, createOp: undefined }).ok).toBe(false)
	})
})
