import { describe, expect, it } from "vitest"
import type { OpenApiDocument } from "../../../spec/types.ts"
import type { Actor } from "../../checks/core/context.ts"
import {
	contextOf,
	entityRunOf,
	flow,
	notesApi,
	notesDoc,
	operationAt,
	optionsFor,
	withLogin,
} from "../__fixtures__/api.ts"
import type { RunOptions } from "../types.ts"
import { unwind } from "../teardown.ts"
import { createdId } from "../../proven-id.ts"
import { checkContext } from "./check-context.ts"
import type { World } from "./state.ts"

/*
 * What every check on an entity is given: write routes withdrawn where oat has no oracle or the
 * profile excludes them, the operations that declare async, effects or waits, and the tenant to
 * cross into.
 */

type Json = Record<string, unknown>

const fresh: World = {
	createAcknowledged: false,
	degraded: false,
	records: [{ id: "n1" }],
	scope: { created: [], values: { a: "1" } },
	uniqueAdopted: false,
}
const actor = (id: string, org: string): Actor => ({
	adoptCredential: () => undefined,
	headers: () => ({ authorization: `Bearer ${id}` }),
	id,
	inviteAs: undefined,
	rank: 0,
	role: undefined,
	roots: { org_id: org },
	scope: { org_id: org },
})

/** The notes document with its operations' tags edited. */
function tagged(edit: (paths: Record<string, Record<string, Json>>) => void): OpenApiDocument {
	const doc = structuredClone(notesDoc()) as unknown as { paths: Record<string, Record<string, Json>> }
	edit(doc.paths)
	return doc as unknown as OpenApiDocument
}

async function contextFor(doc: OpenApiDocument, world: World, extra: Partial<RunOptions> = {}) {
	const ctx = await contextOf(optionsFor(notesApi(doc), extra))
	return { checks: await checkContext(entityRunOf(ctx), world, [actor("alpha", "o1")]), ctx }
}

describe("checkContext", () => {
	it("gives the checks every route of an entity oat seeded itself", async () => {
		const { checks, ctx } = await contextFor(notesDoc(), fresh)
		expect([checks.createOp, checks.readOp, checks.updateOp, checks.deleteOp].map((op) => op?.operationId)).toEqual([
			"notes.create",
			"notes.get",
			"notes.update",
			"notes.delete",
		])
		expect(checks).toMatchObject({
			altAuth: undefined,
			entityName: "note",
			identity: "id",
			records: [{ id: "n1" }],
			scope: { a: "1" },
		})
		expect(checks.uniqueCreateOp).toBeUndefined()
		expect(checks.inScope?.(ctx.model.byOperationId.get("notes.list") as never)).toBe(true)
		expect(checks).not.toHaveProperty("refreshIfStale")
	})

	it("withdraws the write routes from records oat did not create", async () => {
		const { checks } = await contextFor(notesDoc(), { ...fresh, degraded: true })
		expect([checks.createOp, checks.updateOp, checks.deleteOp]).toEqual([undefined, undefined, undefined])
		expect(checks.readOp?.operationId).toBe("notes.get")
	})

	it("keeps the unique routes on an adopted row, and drops them for a profile-excluded update", async () => {
		const unique = tagged((paths) => {
			operationAt({ paths }, "/notes", "post")["x-unique"] = ["title"]
		})
		const adopted = await contextFor(unique, { ...fresh, degraded: true, uniqueAdopted: true })
		expect([adopted.checks.uniqueCreateOp?.operationId, adopted.checks.uniqueUpdateOp?.operationId]).toEqual([
			"notes.create",
			"notes.update",
		])
		const excluded = await contextFor(unique, fresh, {
			profile: "p",
			profiles: { p: { exclude: ["notes.update", "notes.get", "notes.delete"] } },
		})
		expect([
			excluded.checks.uniqueUpdateOp,
			excluded.checks.updateOp,
			excluded.checks.readOp,
			excluded.checks.deleteOp,
		]).toEqual([undefined, undefined, undefined, undefined])
		expect(excluded.ctx.findings.findings.map((finding) => finding.operations)).toEqual([
			["notes.get"],
			["notes.update"],
			["notes.delete"],
		])
	})
})

describe("checkContext declared operations", () => {
	it("gives the operations that declare async work, effects or waits, and the soft-delete field", async () => {
		const doc = tagged((paths) => {
			const del = paths["/notes/{note_id}"]?.delete as Json
			del["x-soft-delete"] = "deleted_at"
			del["x-effects"] = [{ entity: "note", op: "delete" }]
			const patch = paths["/notes/{note_id}"]?.patch as Json
			patch["x-wait"] = { operationId: "notes.get", until: "title.eq.x" }
			const post = paths["/notes"]?.post as Json
			post["x-async"] = { idFrom: "$.id", poll: "notes.get", successWhen: "title.eq.x", until: "title.eq.x" }
		})
		const { checks } = await contextFor(doc, fresh)
		expect(checks.asyncOps.map((op) => op.operationId)).toEqual(["notes.create"])
		expect(checks.effectOps.map((op) => op.operationId)).toEqual(["notes.delete"])
		expect(checks.waitOps.map((op) => op.operationId)).toEqual(["notes.update"])
		expect(checks.softDelete).toBe("deleted_at")
	})

	it("crosses into the first principal of another tenant, and renews the first principal's flow", async () => {
		const ctx = await contextOf(optionsFor(withLogin(), { principals: [flow] }))
		const checks = await checkContext(entityRunOf(ctx), fresh, [
			actor("alpha", "o1"),
			actor("same", "o1"),
			actor("other", "o2"),
		])
		expect(checks.altScope).toEqual({ org_id: "o2" })
		expect(checks.altAuth?.()).toEqual({ authorization: "Bearer other" })
		expect(typeof checks.refreshIfStale).toBe("function")
	})
})

describe("checkContext extras", () => {
	it("lets a check say a record it made has moved where teardown cannot reach it", async () => {
		const { checks, ctx } = await contextFor(notesDoc(), fresh)
		ctx.principals.recorder(ctx.principals.ownerOf(ctx.principals.alpha))("note", createdId("n9") as never, {})
		checks.recordMoved?.("note", "n9", "archived by the check")
		await unwind(ctx)
		expect(ctx.state.teardown?.failed[0]?.reason).toMatch(/^archived by the check; /)
	})

	it("gives the invite unless the profile excludes it", async () => {
		const invited = tagged((paths) => {
			operationAt({ paths }, "/notes/{note_id}", "patch")["x-invite"] = {
				accept: "notes.get",
				invite: "notes.update",
				revoke: "notes.delete",
			}
		})
		const kept = await contextFor(invited, fresh)
		expect(kept.checks.invite?.invite).toBe("notes.update")
		const excluded = await contextFor(invited, fresh, { profile: "p", profiles: { p: { exclude: ["notes.update"] } } })
		expect(excluded.checks.invite).toBeNull()
	})

	it("has no item routes or collection key for a list-only entity with no collection", async () => {
		const doc = {
			info: { title: "t", version: "1" },
			openapi: "3.1.0",
			paths: {
				"/notes": {
					get: {
						operationId: "notes.list",
						responses: {
							"200": { content: { "application/json": { schema: { type: "object" } } }, description: "ok" },
						},
						"x-entity": { action: "list", name: "note" },
					},
				},
			},
		} as unknown as OpenApiDocument
		const ctx = await contextOf(
			optionsFor((_, path) => (path === "/openapi.json" ? { body: doc, status: 200 } : { body: {}, status: 200 })),
		)
		const checks = await checkContext(entityRunOf(ctx), fresh, [actor("alpha", "o1")])
		expect([checks.readOp, checks.updateOp, checks.deleteOp, checks.collectionKey]).toEqual([
			undefined,
			undefined,
			undefined,
			null,
		])
	})
})
