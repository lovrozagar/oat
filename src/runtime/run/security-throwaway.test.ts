import { describe, expect, it } from "vitest"
import type { OpenApiDocument } from "../../spec/types.ts"
import type { CheckId } from "../check-ids.ts"
import type { OperationCheck } from "../checks/core/check.ts"
import { defineCheck } from "../checks/core/define.ts"
import { targetPlan } from "../checks/core/operation.ts"
import type { Responder } from "../checks/__fixtures__/harness.ts"
import { ASSERTED } from "../finding.ts"
import type { Record_ } from "../world/records.ts"
import { contextOf, ledgerNotes, notesApi, notesDoc, optionsFor, overriding, type Seen } from "./__fixtures__/api.ts"
import type { RunContext } from "./context.ts"
import { runWriteSecurity } from "./security.ts"
import { trackCreates } from "./teardown.ts"

/*
 * A DELETE probe never targets a record another step uses: each DELETE operation gets a throwaway
 * record of its own, made by the entity's create as the shared target's creator and ledgered like
 * any create. It is reused while refusals hold; a probe whose DELETE went through consumes it, and
 * the next probe on that operation makes another. The backend here applies every write.
 */

/** A run over `respond` with one shared note the lanes made, every create ledgered as it goes. */
async function running(
	rows: Record_[],
	{ respond = notesApi(notesDoc(), rows), shared = true }: { respond?: Responder; shared?: boolean } = {},
): Promise<RunContext & { seen: Seen[] }> {
	const options = optionsFor(respond, { ops: ["notes.delete", "notes.update"] })
	const ctx = await contextOf(options)
	if (shared) {
		rows.push({ id: "shared", title: "every step reads it" })
		ledgerNotes(ctx, ["shared"])
	}
	trackCreates(ctx)
	return { ...ctx, seen: options.seen }
}

/** A check that sends its operation to its target as alpha, and notes each probe's id and status. */
function probing(id: CheckId, sent: string[]): OperationCheck {
	return defineCheck({
		id,
		mutates: true,
		plan: targetPlan,
		run: async (c, target) => {
			const body = c.operation.hasRequestBody ? { body: target.current } : {}
			const exchange = await c.client.request(c.operation.method.toUpperCase(), target.path, {
				as: { principal: "alpha" },
				...body,
			})
			sent.push(`${c.operation.operationId} ${target.id} ${exchange.status}`)
			return ASSERTED
		},
		subject: "operation",
	})
}

const creates = (seen: readonly Seen[]): number => seen.filter((s) => s.method === "POST" && s.path === "/notes").length
const ids = (rows: readonly Record_[]): unknown[] => rows.map((row) => row["id"])

describe("a DELETE probe's throwaway target", () => {
	it("sends a DELETE probe to a throwaway of its own, so the shared record survives; other writes keep it", async () => {
		const rows: Record_[] = []
		const ctx = await running(rows)
		const sent: string[] = []
		await runWriteSecurity(ctx, [probing("auth.role-enforced", sent)])
		expect(sent).toEqual(["notes.delete n1 204", "notes.update shared 200"])
		expect(ids(rows)).toEqual(["shared"])
		expect(ctx.ledger.entries().map((record) => `${record.entity} ${record.id} ${record.owner.id}`)).toEqual([
			"note shared alpha",
			"note n1 alpha",
		])
	})

	it("reuses one throwaway across an operation's probes while refusals hold", async () => {
		const rows: Record_[] = []
		const refusing = overriding(notesApi(notesDoc(), rows), (method) =>
			method === "DELETE" ? { status: 403 } : undefined,
		)
		const ctx = await running(rows, { respond: refusing })
		const sent: string[] = []
		await runWriteSecurity(ctx, [probing("auth.role-enforced", sent), probing("auth.scope-enforced", sent)])
		expect(sent.filter((line) => line.startsWith("notes.delete"))).toEqual([
			"notes.delete n1 403",
			"notes.delete n1 403",
		])
		expect(creates(ctx.seen)).toBe(1)
	})

	it("replaces a throwaway a probe's DELETE consumed, once, for the next probe on that operation", async () => {
		const rows: Record_[] = []
		const ctx = await running(rows)
		const sent: string[] = []
		await runWriteSecurity(ctx, [probing("auth.role-enforced", sent), probing("auth.scope-enforced", sent)])
		expect(sent.filter((line) => line.startsWith("notes.delete"))).toEqual([
			"notes.delete n1 204",
			"notes.delete n2 204",
		])
		expect(creates(ctx.seen)).toBe(2)
		expect(ids(rows)).toEqual(["shared"])
	})
})

/** The notes document, with `edit` applied to its create. */
function withCreate(edit: (create: Record<string, unknown>) => void): OpenApiDocument {
	const doc = notesDoc() as unknown as { paths: Record<string, Record<string, Record<string, unknown>>> }
	edit(doc.paths["/notes"]?.["post"] as Record<string, unknown>)
	return doc as unknown as OpenApiDocument
}

/** The notes document with its create form-encoded, and the title kept unique. */
function formCreate(): OpenApiDocument {
	return withCreate((create) => {
		const { content } = create["requestBody"] as { content: Record<string, unknown> }
		create["requestBody"] = { content: { "application/x-www-form-urlencoded": content["application/json"] } }
		create["x-unique"] = [["title"]]
	})
}

describe("a throwaway's body", () => {
	it("is drawn as the create documents it, form-encoded, with a unique title of the throwaway's own", async () => {
		const rows: Record_[] = []
		const form = overriding(notesApi(formCreate(), rows), (method, path, request) => {
			if (method !== "POST" || path !== "/notes") return undefined
			const made = { id: "n1", title: new URLSearchParams(String(request.body)).get("title") }
			rows.push(made)
			return { body: made, status: 201 }
		})
		const ctx = await running(rows, { respond: form })
		const sent: string[] = []
		await runWriteSecurity(ctx, [probing("auth.role-enforced", sent)])
		const create = ctx.seen.find((seen) => seen.method === "POST")
		expect(create?.headers["content-type"]).toBe("application/x-www-form-urlencoded")
		expect(String(create?.body)).toMatch(/^title=.*t1/)
		expect(sent).toEqual(["notes.delete n1 204", "notes.update shared 200"])
	})
})

/** The notes document whose create takes no body. */
function bodilessCreate(): OpenApiDocument {
	return withCreate((create) => {
		delete create["requestBody"]
	})
}

describe("a throwaway's body, when the create takes none", () => {
	it("sends the create without one", async () => {
		const rows: Record_[] = []
		const bare = overriding(notesApi(bodilessCreate(), rows), (method, path) => {
			if (method !== "POST" || path !== "/notes") return undefined
			rows.push({ id: "n1", title: "untitled" })
			return { body: { id: "n1", title: "untitled" }, status: 201 }
		})
		const ctx = await running(rows, { respond: bare })
		const sent: string[] = []
		await runWriteSecurity(ctx, [probing("auth.role-enforced", sent)])
		expect(ctx.seen.find((seen) => seen.method === "POST")?.body).toEqual({})
		expect(sent).toEqual(["notes.delete n1 204", "notes.update shared 200"])
	})
})

/** The notes document without its create. */
function uncreatable(): OpenApiDocument {
	const doc = notesDoc() as unknown as { paths: Record<string, Record<string, unknown>> }
	const { post: _create, ...list } = doc.paths["/notes"] as Record<string, unknown>
	return { ...doc, paths: { ...doc.paths, "/notes": list } } as unknown as OpenApiDocument
}

describe("a DELETE probe with no throwaway", () => {
	it("stands it down when the entity has no create, and still probes the other writes", async () => {
		const rows: Record_[] = []
		const ctx = await running(rows, { respond: notesApi(uncreatable(), rows) })
		const sent: string[] = []
		await runWriteSecurity(ctx, [probing("auth.role-enforced", sent)])
		expect(sent).toEqual(["notes.update shared 200"])
		expect(ctx.state.checksSkipped).toEqual([
			{
				check: "auth.role-enforced",
				entity: "notes.delete",
				needs: "a create for note, to make a throwaway record that notes.delete can remove",
			},
		])
	})

	it("stands it down with why the throwaway could not be made: a refused create, or one that never answered", async () => {
		const rows: Record_[] = []
		let failure: "refused" | "unreachable" = "refused"
		const failing = overriding(notesApi(notesDoc(), rows), (method) => {
			if (method !== "POST") return undefined
			if (failure === "unreachable") throw new Error("connection reset")
			return { body: { error: "full" }, status: 500 }
		})
		const ctx = await running(rows, { respond: failing })
		await runWriteSecurity(ctx, [probing("auth.role-enforced", [])])
		failure = "unreachable"
		await runWriteSecurity(ctx, [probing("auth.role-enforced", [])])
		expect(ctx.state.checksSkipped.map((skipped) => skipped.needs)).toEqual([
			"a throwaway note for notes.delete: notes.create answered 500",
			expect.stringMatching(/^a throwaway note for notes\.delete: .*connection reset/),
		])
		expect(ids(rows)).toEqual(["shared"])
	})
})

describe("a DELETE probe whose throwaway cannot be read back", () => {
	it("stands it down citing the block when its creator is BLOCKED before the throwaway is read back", async () => {
		const rows: Record_[] = []
		const holder: { ctx?: RunContext } = {}
		const blocking = overriding(notesApi(notesDoc(), rows), (method) => {
			if (method === "POST") holder.ctx?.store.block({ principal: "alpha", scheme: "bearer" }, "refused anywhere")
			return undefined
		})
		const ctx = await running(rows, { respond: blocking })
		holder.ctx = ctx
		await runWriteSecurity(ctx, [probing("auth.role-enforced", [])])
		expect(ctx.state.checksSkipped).toEqual([])
		expect(
			ctx.findings.findings.map((finding) => [finding.summary, finding.operations, finding.detail]),
		).toContainEqual([
			"auth.role-enforced needed a credential that is BLOCKED",
			["notes.delete"],
			expect.stringContaining("refused anywhere"),
		])
	})

	it("reports the probe stopped by the block when its creator is BLOCKED before the throwaway is made", async () => {
		const rows: Record_[] = [{ id: "run-1", title: "t1" }]
		const ctx = await running(rows)
		ctx.store.block({ principal: "alpha", scheme: "bearer" }, "refused before the create")
		await runWriteSecurity(ctx, [probing("auth.role-enforced", [])])
		expect(ctx.state.checksSkipped.filter((skipped) => skipped.entity === "notes.delete")).toEqual([])
		expect(ctx.findings.findings.map((finding) => [finding.summary, finding.operations])).toContainEqual([
			"auth.role-enforced needed a credential that is BLOCKED",
			["notes.delete"],
		])
	})

	it("stands it down as any write when the run created no record of its entity to model the throwaway on", async () => {
		const rows: Record_[] = []
		const ctx = await running(rows, { shared: false })
		await runWriteSecurity(ctx, [probing("auth.role-enforced", [])])
		expect(ctx.state.checksSkipped.map((skipped) => skipped.needs)).toEqual([
			"a record this run created that notes.delete can be sent to",
			"a record this run created that notes.update can be sent to",
		])
		expect(creates(ctx.seen)).toBe(0)
	})
})

/** The notes document whose create is keyed by a client-chosen integer id from 1 to `maximum`. */
function keyedDoc(maximum = 60): OpenApiDocument {
	const keyed = {
		properties: { id: { maximum, minimum: 1, type: "integer" }, title: { maxLength: 40, type: "string" } },
		required: ["id", "title"],
		type: "object",
	}
	return notesDoc({
		"/notes": {
			post: {
				operationId: "notes.create",
				requestBody: { content: { "application/json": { schema: keyed } }, required: true },
				responses: { "201": { content: { "application/json": { schema: keyed } }, description: "made" } },
			},
		},
	})
}

/* The client-chosen ids the run's creates sent. */
const createdIds = (seen: readonly Seen[]): string[] =>
	seen
		.filter((s) => s.method === "POST" && s.path === "/notes")
		.map((s) => String((s.body as { id?: unknown } | undefined)?.id))

describe("a throwaway's identity", () => {
	it("never creates its throwaway under an id an existing record holds: the create would overwrite it", async () => {
		const rows: Record_[] = []
		const ctx = await running(rows, { respond: notesApi(keyedDoc(), rows) })
		/* The collection already holds ids 1 to 50 of 60. */
		const held = Array.from({ length: 50 }, (_, index) => String(index + 1))
		ctx.state.takenByEntity.set("note", new Set(held))
		await runWriteSecurity(ctx, [probing("auth.role-enforced", [])])
		const sent = createdIds(ctx.seen)
		expect(sent).toHaveLength(1)
		expect(held).not.toContain(sent[0])
	})

	it("makes its throwaway under a fresh id when another tenant's record holds the first", async () => {
		const rows: Record_[] = []
		let refused = 0
		const once = overriding(notesApi(keyedDoc(), rows), (method, path) =>
			method === "POST" && path === "/notes" && refused++ === 0 ? { status: 409 } : undefined,
		)
		const ctx = await running(rows, { respond: once })
		const sent: string[] = []
		await runWriteSecurity(ctx, [probing("auth.role-enforced", sent)])
		const sentIds = createdIds(ctx.seen)
		expect(sentIds).toHaveLength(2)
		expect(sentIds[1]).not.toBe(sentIds[0])
		expect(ctx.state.takenByEntity.get("note")?.has(sentIds[0] as string)).toBe(true)
		expect(sent[0]).toMatch(/^notes\.delete \S+ 204$/)
	})

	it("is untested, saying why, after three ids are refused, and sends no fourth create", async () => {
		const rows: Record_[] = []
		const refusing = overriding(notesApi(keyedDoc(999), rows), (method, path) =>
			method === "POST" && path === "/notes" ? { status: 409 } : undefined,
		)
		const ctx = await running(rows, { respond: refusing })
		await runWriteSecurity(ctx, [probing("auth.role-enforced", [])])
		const sentIds = createdIds(ctx.seen)
		expect(sentIds).toHaveLength(3)
		expect(ctx.state.checksSkipped.map((skipped) => skipped.needs)).toContain(
			`a throwaway note for notes.delete: every client-chosen "id" sent was refused with 409 (${sentIds.join(", ")}); no fourth create was sent`,
		)
	})
})
