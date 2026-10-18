import { describe, expect, it } from "vitest"
import { exchange } from "../checks/__fixtures__/harness.ts"
import { me, selfInput } from "./__fixtures__/me.ts"
import { callerEchoed, createCaller, failedToCreate } from "./create.ts"

const resolveInput = async () => "from-hook"

const SIGNUP = {
	properties: { display_name: { type: "string" }, handle: { type: "string" }, label: { type: "string" } },
	required: ["handle"],
	type: "object",
}

describe("createCaller", () => {
	it("is null when the spec has no create", async () => {
		const { input, findings } = selfInput(() => undefined)
		expect(await createCaller(input, findings)).toBeNull()
	})

	it("sends only the required fields, distinct, and returns what it sent", async () => {
		const { input, findings, sent } = selfInput(() => ({ status: 201 }), me({ create: SIGNUP }), {
			nonce: "n0",
			seed: 3,
		})
		const created = await createCaller(input, findings)
		expect(created).toMatchObject({ body: { handle: "Quarterly Report 0 n0" } })
		expect(sent.map((request) => `${request.method} ${request.path}`)).toEqual(["POST /me"])
	})

	it("sends every field when none is required, and fills in what a hook supplies", async () => {
		const optional = { properties: { handle: { type: "string" } }, type: "object" }
		const { input, findings } = selfInput(() => ({ status: 201 }), me({ create: optional }), { resolveInput })
		expect(await createCaller(input, findings)).toMatchObject({ body: { handle: "from-hook" } })
		/* Required but undescribed, or described only by fields it does not require. */
		const undescribed = { required: ["handle"], type: "object" }
		const bare = selfInput(() => ({ status: 201 }), me({ create: undescribed }))
		expect(await createCaller(bare.input, bare.findings)).toMatchObject({ body: { handle: "Quarterly Report 0" } })
		const elsewhere = { properties: { label: { type: "string" } }, required: ["handle"], type: "object" }
		const other = selfInput(() => ({ status: 201 }), me({ create: elsewhere }))
		expect(await createCaller(other.input, other.findings)).toMatchObject({ body: { handle: "Quarterly Report 0" } })
		/* Properties as a list is no schema at all: generation says so. */
		const listed = { properties: [], required: ["handle"], type: "object" }
		const odd = selfInput(() => ({ status: 201 }), me({ create: listed }))
		expect(await createCaller(odd.input, odd.findings)).toMatchObject({
			kind: "unresolved",
			reason: expect.stringContaining("schema cannot be compiled"),
		})
	})
})

describe("createCaller, when it cannot", () => {
	it("cannot create through a route that needs an id, or without a body", async () => {
		const pathed = selfInput(() => undefined, me({ create: SIGNUP, createPath: "/me/{slot}" }))
		expect(await createCaller(pathed.input, pathed.findings)).toEqual({
			kind: "unresolved",
			reason: "me.create needs a path id",
		})
		const bodiless = selfInput(() => undefined, me({ create: null }))
		expect(await createCaller(bodiless.input, bodiless.findings)).toEqual({
			kind: "unresolved",
			reason: "me.create declares no request body",
		})
	})

	it("says why no body can be made, a malformed schema included", async () => {
		const impossible = {
			properties: { n: { maximum: 1, minimum: 5, type: "integer" } },
			required: ["n"],
			type: "object",
		}
		const { input, findings } = selfInput(() => undefined, me({ create: impossible }))
		expect(await createCaller(input, findings)).toMatchObject({
			kind: "unresolved",
			reason: expect.stringContaining("me.create"),
		})
		const malformed = selfInput(() => undefined, me({ create: { allOf: [{ allOf: 5 }] } }))
		expect(await createCaller(malformed.input, malformed.findings)).toMatchObject({
			kind: "unresolved",
			reason: expect.stringContaining("allOf/0/allOf is not a list of schemas"),
		})
	})

	it("reports a create the backend refused", async () => {
		const { input, findings } = selfInput(() => ({ status: 500 }), me({ create: SIGNUP }))
		expect(await createCaller(input, findings)).toEqual({ kind: "finding", verdict: "BACKEND_BUG" })
		expect(findings.findings[0]?.summary).toBe("creating the caller failed")
	})
})

describe("what a create leaves", () => {
	it("is an outcome to end on, or a created caller, or nothing", () => {
		expect(failedToCreate({ kind: "unresolved", reason: "x" })).toBe(true)
		expect(failedToCreate({ body: {}, exchange: exchange("POST", "/me", { status: 201 }) })).toBe(false)
		expect(failedToCreate(null)).toBe(false)
	})

	it("shows on the next read when a sent scalar comes back under its field", () => {
		expect(callerEchoed({ handle: "h", tags: ["x"] }, { handle: "h" })).toBe(true)
		expect(callerEchoed({ handle: "h", meta: null }, { handle: "other" })).toBe(false)
		expect(callerEchoed({ handle: "h" }, null)).toBe(false)
		expect(callerEchoed({ handle: "h" }, [{ handle: "h" }])).toBe(false)
	})
})
