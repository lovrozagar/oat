import { describe, expect, it, vi } from "vitest"
import { modelOf, op } from "../../__fixtures__/harness.ts"
import { runCheck } from "../../core/run.ts"
import { inviteGrantsThenRevokes } from "./auth-invite-grants-then-revokes.ts"
import { actor } from "./__fixtures__/context.ts"
import { delegate, GATED, inviteBackend, inviteContext, inviteDocument, owner } from "./__fixtures__/invites.ts"
import { documentedJsonBody, pointerValue } from "./invite-flow.ts"

const LINK = "https://mail.test/accept/t1"
const QUICK = { attempts: 1, initialMs: 0, maxMs: 0 }

describe("the invite token", () => {
	it("is asked of the out-of-band hook, by grantee and kind, when the tag says so", async () => {
		const resolveOutOfBand = vi.fn(async () => "t9")
		const doc = inviteDocument({ tag: { tokenFrom: "outOfBand", tokenKind: "share" } })
		const { ctx, sent } = inviteContext(doc, inviteBackend({ invited: { grant_id: "g1" } }), {
			hooks: { resolveOutOfBand },
			outOfBand: QUICK,
		})
		expect(await runCheck(inviteGrantsThenRevokes, ctx)).toEqual({ kind: "asserted" })
		expect(resolveOutOfBand).toHaveBeenCalledWith(
			expect.objectContaining({
				address: "bob",
				kind: "share",
				scope: { inviteAs: "bob", note_id: "n1", org_id: "o1" },
			}),
		)
		expect(sent[3]?.path).toBe("/invites/t9/accept")
	})

	it("is unresolved when no hook can deliver it, naming the default kind", async () => {
		const doc = inviteDocument({ tag: { tokenFrom: "outOfBand" } })
		const { ctx, sent } = inviteContext(doc, inviteBackend())
		const outcome = await runCheck(inviteGrantsThenRevokes, ctx)
		expect(outcome).toMatchObject({
			kind: "unresolved",
			reason: expect.stringContaining('needs a "note-invite" value'),
		})
		expect(sent.map((s) => s.method).at(-1)).toBe("DELETE")
	})

	it("reports a hook's failure as the reason, whatever it threw", async () => {
		const resolveOutOfBand = vi.fn(async () => {
			throw "mailbox offline"
		})
		const doc = inviteDocument({ tag: { tokenFrom: "outOfBand" } })
		const { ctx } = inviteContext(doc, inviteBackend(), { hooks: { resolveOutOfBand }, outOfBand: QUICK })
		expect(await runCheck(inviteGrantsThenRevokes, ctx)).toEqual({ kind: "unresolved", reason: "mailbox offline" })
	})
})

describe("accepting by link", () => {
	const linked = inviteDocument({ tag: { acceptFrom: "link", tokenPointer: "$.link" } })

	it("follows the mailed link as the delegate", async () => {
		const backend = inviteBackend({ invited: { grant_id: "g1", link: LINK } })
		const { ctx, sent } = inviteContext(linked, backend)
		expect(await runCheck(inviteGrantsThenRevokes, ctx)).toEqual({ kind: "asserted" })
		expect(sent[3]).toMatchObject({ method: "GET", options: { redirect: "follow" }, path: LINK })
		expect(sent[3]?.options.headers).toEqual(delegate.headers())
	})

	it("accepts a redirect from the link, and fails on an error, even a gate-shaped one", async () => {
		const redirected = inviteBackend({
			invited: { grant_id: "g1", link: LINK },
			override: { [`GET ${LINK}`]: { status: 302 } },
		})
		/* The redirect counts as accepted: the check goes on to the read, which this backend never opened. */
		const afterRedirect = inviteContext(linked, redirected)
		await runCheck(inviteGrantsThenRevokes, afterRedirect.ctx)
		expect(afterRedirect.findings.findings[0]?.summary).toBe("accepting an invite does not grant access")
		const refused = inviteBackend({ invited: { grant_id: "g1", link: LINK }, override: { [`GET ${LINK}`]: GATED } })
		expect(await runCheck(inviteGrantsThenRevokes, inviteContext(linked, refused).ctx)).toEqual({
			kind: "unresolved",
			reason: "accept returned 403",
		})
	})

	it("is unresolved when the link is not an absolute http(s) URL", async () => {
		const { ctx, sent } = inviteContext(linked, inviteBackend({ invited: { grant_id: "g1", link: "t1" } }))
		expect(await runCheck(inviteGrantsThenRevokes, ctx)).toEqual({
			kind: "unresolved",
			reason: 'x-invite.acceptFrom: link needs an absolute http(s) URL, got "t1"',
		})
		expect(sent.map((s) => s.method)).toEqual(["GET", "POST", "GET", "DELETE"])
	})
})

describe("the credential an accept issues", () => {
	it("is adopted by a delegate that can take one, and ignored by one that cannot", async () => {
		const adoptCredential = vi.fn()
		const adopting = actor("delegate", 1, { org_id: "o2" }, { adoptCredential, inviteAs: "bob" })
		const issuing = inviteBackend({ accepted: { access_token: "fresh" } })
		await runCheck(inviteGrantsThenRevokes, inviteContext(inviteDocument(), issuing, { actors: [owner, adopting] }).ctx)
		expect(adoptCredential).toHaveBeenCalledWith("fresh")
		const plain = inviteContext(inviteDocument(), inviteBackend({ accepted: { access_token: "fresh" } }))
		expect(await runCheck(inviteGrantsThenRevokes, plain.ctx)).toEqual({ kind: "asserted" })
	})
})

describe("accept and revoke bodies", () => {
	it("fills the declared JSON properties it knows, and sends none for a path-only operation", async () => {
		const doc = inviteDocument({
			acceptBody: { properties: { note: { type: "string" }, token: { type: "string" } }, type: "object" },
			revokeBody: { properties: { grant_id: { type: "string" } }, type: "object" },
			revokeMethod: "post",
			revokePath: "/orgs/{org_id}/grants",
		})
		const { ctx, sent } = inviteContext(doc, inviteBackend())
		expect(await runCheck(inviteGrantsThenRevokes, ctx)).toEqual({ kind: "asserted" })
		expect(sent[3]?.options).toMatchObject({ body: { token: "t1" }, headers: { "content-type": "application/json" } })
		expect(sent[5]).toMatchObject({ method: "POST", options: { body: { grant_id: "g1" } }, path: "/orgs/o1/grants" })
	})

	it("sends the token, else the grant id, where the body declares no properties", async () => {
		const doc = inviteDocument({ revokeBody: { type: "object" }, revokeMethod: "post", revokePath: "/grants" })
		const { ctx, sent } = inviteContext(doc, inviteBackend())
		await runCheck(inviteGrantsThenRevokes, ctx)
		expect(sent[5]).toMatchObject({ options: { body: { token: "t1" } }, path: "/grants" })
		const tokenless = inviteContext(doc, inviteBackend({ invited: { grant_id: "g1" } }))
		await runCheck(inviteGrantsThenRevokes, tokenless.ctx)
		expect(tokenless.sent.at(-1)?.options.body).toEqual({ grant_id: "g1" })
	})

	it("sends no body for a form, and nothing at all to an operation without a request body", () => {
		const doc = inviteDocument({ acceptBody: { type: "object" }, acceptMedia: "application/x-www-form-urlencoded" })
		const { ctx } = inviteContext(doc, inviteBackend())
		expect(documentedJsonBody(ctx, op(ctx.model, "acceptInvite"), { token: "t1" })).toBeUndefined()
		expect(documentedJsonBody(ctx, op(ctx.model, "revokeInvite"), { grant_id: "g1" })).toBeUndefined()
	})

	it("treats an empty properties object like none", () => {
		const { ctx } = inviteContext(inviteDocument({ revokeBody: { properties: {}, type: "object" } }), inviteBackend())
		expect(documentedJsonBody(ctx, op(ctx.model, "revokeInvite"), { grant_id: "g1", org_id: "o1" })).toEqual({
			grant_id: "g1",
		})
	})

	it("sends every known value when neither a token nor a grant id is among them", () => {
		const { ctx } = inviteContext(inviteDocument({ revokeBody: { type: "object" } }), inviteBackend())
		expect(documentedJsonBody(ctx, op(ctx.model, "revokeInvite"), { org_id: "o1" })).toEqual({ org_id: "o1" })
	})

	it("sends no body for an operation the document does not hold", () => {
		const { ctx } = inviteContext(inviteDocument(), inviteBackend())
		const ghost = { ...op(modelOf(inviteDocument()), "acceptInvite"), operationId: "ghost" }
		expect(documentedJsonBody(ctx, ghost, { token: "t1" })).toBeUndefined()
	})
})

describe("pointerValue", () => {
	it("reads a non-empty string or a finite number as text, and nothing else", () => {
		expect(pointerValue({ id: "g1" }, "$.id")).toBe("g1")
		expect(pointerValue({ id: 7 }, "$.id")).toBe("7")
		for (const id of ["", Number.NaN, null, { nested: true }]) expect(pointerValue({ id }, "$.id")).toBeUndefined()
	})
})
