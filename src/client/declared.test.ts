import { describe, expect, it } from "vitest"
import { withDeclared } from "./declared.ts"
import { NOTHING_PLACED, type Placement } from "./placing.ts"
import type { ResolvedOperation } from "./types.ts"

const resolved = (more: Partial<ResolvedOperation> = {}): ResolvedOperation => ({
	operationId: "rows.list",
	template: "/rows",
	...more,
})

const placing = (headers: Record<string, string>, cookies: Record<string, string> = {}): Placement => ({
	forged: false,
	principal: "alpha",
	schemes: ["key"],
	sends: { key: { cookies, headers, query: {} } },
})

describe("withDeclared", () => {
	it("adds nothing for a request no operation resolves, or one that declares nothing", () => {
		const layers = [{ g: "1" }]
		expect(withDeclared(null, NOTHING_PLACED, layers)).toEqual(layers)
		expect(withDeclared(resolved(), NOTHING_PLACED, layers)).toEqual([{}, { g: "1" }])
	})

	it("writes each header in its declared style, under every layer, never over one that sends it", () => {
		const operation = resolved({
			paramStyles: { header: { "X-Range": { explode: true } } },
			requiredHeaders: { "X-Range": { max: 5, min: 1 }, "X-Version": "2", "x-mine": "doc" },
		})
		expect(withDeclared(operation, NOTHING_PLACED, [{ "X-Mine": "caller" }])).toEqual([
			{ "X-Range": "max=5,min=1", "X-Version": "2" },
			{ "X-Mine": "caller" },
		])
	})

	/* Ruling A4: the declared value is an example; the credential placed under that name is the operation's security. */
	it("never sends a declared header or cookie under a name the credential is placed in, whatever its case", () => {
		const operation = resolved({ requiredCookies: { sid: "doc" }, requiredHeaders: { "x-token": "doc" } })
		expect(withDeclared(operation, placing({ "X-Token": "live" }, { sid: "live" }), [])).toEqual([{}])
	})

	it("starts a Cookie header, or joins the topmost one, leaving out a cookie a layer already sends", () => {
		const operation = resolved({
			paramStyles: { cookie: { tags: { explode: false } } },
			requiredCookies: { lang: "en", tags: ["a", "b"], theme: "dark" },
		})
		expect(withDeclared(operation, NOTHING_PLACED, [])).toEqual([{ cookie: "lang=en; tags=a,b; theme=dark" }])
		expect(withDeclared(operation, NOTHING_PLACED, [{ Cookie: "theme=light" }, { a: "1" }])).toEqual([
			{},
			{ Cookie: "theme=light; lang=en; tags=a,b" },
			{ a: "1" },
		])
	})
})
