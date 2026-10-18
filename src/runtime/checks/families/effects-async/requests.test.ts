import { describe, expect, it } from "vitest"
import type { InviteSpec } from "../../../../spec/extensions/invite.ts"
import { contextFor, modelOf, op } from "../../__fixtures__/harness.ts"
import type { Actor } from "../../core/context.ts"
import { baseDocument } from "./__fixtures__/documents.ts"
import { bodyForOp, forOperation, subject } from "./requests.ts"

const model = modelOf(baseDocument())
const create = op(model, "createWidget")

function actor(id: string, roots: Record<string, string>, inviteAs?: string): Actor {
	return { headers: () => ({}), id, inviteAs, rank: 1, role: undefined, roots, scope: {} }
}

const invite = { granteeField: "email" } as InviteSpec

describe("forOperation", () => {
	it("attributes what is reported through it to the operation, into the same collector", () => {
		const { ctx, findings } = contextFor(model, "listWidgets", () => undefined)
		forOperation(ctx, create).findings.gap("effects.declared-effect-occurs", "widget", "summary", "detail")
		expect(findings.findings).toHaveLength(1)
		expect(findings.findings[0]?.operations).toEqual(["createWidget"])
	})
})

describe("bodyForOp", () => {
	it("builds a valid body from the request schema when nothing is an invite", () => {
		const { ctx } = contextFor(model, "listWidgets", () => undefined)
		const body = bodyForOp(ctx, create)
		expect(typeof body.name).toBe("string")
		expect(body).not.toHaveProperty("email")
	})

	it("puts a peer from another tenant in the invite's grantee field before one from the owner's", () => {
		const actors = [
			actor("owner", { org: "a" }),
			actor("same", { org: "a" }, "same@test"),
			actor("other", { org: "b" }, "other@test"),
		]
		const { ctx } = contextFor(model, "listWidgets", () => undefined, { actors, invite })
		expect(bodyForOp(ctx, create).email).toBe("other@test")
	})

	it("falls back to a peer in the owner's tenant when no other tenant has an invitee", () => {
		const actors = [actor("owner", { org: "a" }, "owner@test"), actor("same", { org: "a" }, "same@test")]
		const { ctx } = contextFor(model, "listWidgets", () => undefined, { actors, invite })
		expect(bodyForOp(ctx, create).email).toBe("same@test")
	})

	it("prefers the operation's own invite over the entity's, and leaves the field alone with no invitee", () => {
		const own = { ...create, invite: { granteeField: "key" } as InviteSpec }
		const { ctx } = contextFor(model, "listWidgets", () => undefined, {
			actors: [actor("owner", {}), actor("peer", {}, "peer@test")],
			invite,
		})
		expect(bodyForOp(ctx, own)).toMatchObject({ key: "peer@test" })
		const lonely = contextFor(model, "listWidgets", () => undefined, { actors: [actor("owner", {})], invite })
		expect(bodyForOp(lonely.ctx, own)).not.toHaveProperty("key")
	})

	it("sends an empty body for an operation without a request schema", () => {
		const { ctx } = contextFor(model, "listWidgets", () => undefined)
		expect(bodyForOp(ctx, op(model, "getWidget"))).toEqual({})
	})
})

describe("subject", () => {
	it("is the entity, or the operation and fixture when a fixture drove the invocation", () => {
		expect(subject("widget", "cloneWidget")).toBe("widget")
		expect(subject("widget", "cloneWidget", "a.png")).toBe("cloneWidget · a.png")
	})
})
