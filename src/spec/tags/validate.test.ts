import { describe, expect, it } from "vitest"
import { GapCollector } from "../extensions/gaps.ts"
import type { OperationObject } from "../types.ts"
import { validateTags } from "./validate.ts"

const gapsOf = (op: Record<string, unknown>): string[] => {
	const gaps = new GapCollector()
	validateTags(op as OperationObject, "op", gaps)
	return gaps.gaps.map((gap) => `${gap.tag}: ${gap.detail}`)
}

describe("validateTags", () => {
	it("records nothing for well-formed tags, or for none", () => {
		expect(
			gapsOf({
				parameters: [
					{ in: "path", name: "id", "x-root": true },
					{ in: "query", name: "q" },
				],
				"x-async": { poll: "GET /jobs/{id}", pollIntervalMs: 10 },
				"x-bind": { path: { id: "$.id" } },
				"x-cleanup": "DELETE /a/{id}",
				"x-cost": "low",
				"x-entity": { action: "create", name: "note" },
				"x-invalidate": ["GET /a"],
				"x-invite": { accept: "POST /a", invite: "POST /i", revoke: "DELETE /i", tokenFrom: "outOfBand" },
				"x-rate-limit": { category: "c", rps: 2 },
				"x-tenant": false,
				"x-wait": { operationId: "w" },
			}),
		).toEqual([])
		expect(gapsOf({})).toEqual([])
	})
})

describe("validateTags and an x-query block", () => {
	it("records a malformed sort, select or searchCase as a gap naming the key", () => {
		expect(gapsOf({ "x-query": { sort: { maxKeys: -1 } } })).toEqual([
			'x-query: x-query "sort" "maxKeys" must be a positive integer; oat cannot use it',
		])
		expect(gapsOf({ "x-query": { searchCase: "loose" } })).toEqual([
			'x-query: x-query "searchCase" must be one of "sensitive", "insensitive"; oat cannot use it',
		])
	})
})

describe("validateTags malformed tags", () => {
	it("records every malformed tag, in a fixed order, as one the run cannot use", () => {
		expect(
			gapsOf({
				"x-wait": {},
				"x-tenant": "",
				"x-soft-delete": 1,
				"x-rate-limit": { rps: 1 },
				"x-query": { maxLimit: 0 },
				"x-invite": { invite: "POST /i" },
				"x-invalidate": ["/a"],
				"x-immutable": "a",
				"x-idempotent": 1,
				"x-generated": [1],
				"x-fresh-principal": "no",
				"x-feature-gate": "",
				"x-destructive": "yes",
				"x-cost": "huge",
				"x-cleanup": "/a",
				"x-async": {},
				"x-bind": { body: { a: 1 } },
				"x-before": 3,
			}),
		).toEqual([
			"x-before: x-before must be a non-empty string; oat cannot use it",
			'x-bind: x-bind "body" must map names to strings; oat cannot use it',
			'x-async: x-async needs "poll"; oat cannot use it',
			'x-cleanup: x-cleanup must be a route like "GET /path"; oat cannot use it',
			'x-cost: x-cost must be one of "low", "medium", "high"; oat cannot use it',
			"x-destructive: x-destructive must be true or false; oat cannot use it",
			"x-feature-gate: x-feature-gate must be a non-empty string; oat cannot use it",
			"x-fresh-principal: x-fresh-principal must be true or false; oat cannot use it",
			"x-generated: x-generated must be an array of strings; oat cannot use it",
			"x-idempotent: x-idempotent must be true or false; oat cannot use it",
			"x-immutable: x-immutable must be an array of strings; oat cannot use it",
			'x-invalidate: x-invalidate must be an array of routes like "GET /path"; oat cannot use it',
			'x-invite: x-invite needs "accept"; oat cannot use it',
			'x-query: x-query "maxLimit" must be a positive integer; oat cannot use it',
			'x-rate-limit: x-rate-limit needs "category"; oat cannot use it',
			"x-soft-delete: x-soft-delete must be a non-empty string; oat cannot use it",
			"x-tenant: x-tenant must be a path parameter name or false; oat cannot use it",
			'x-wait: x-wait needs "operationId"; oat cannot use it',
		])
		expect(
			gapsOf({ "x-invite": { accept: "POST /a", acceptFrom: "email", invite: "POST /i", revoke: "DELETE /i" } }),
		).toEqual(['x-invite: x-invite "acceptFrom" must be one of "link"; oat cannot use it'])
		expect(gapsOf({ "x-invalidate": "GET /a" })).toEqual([
			'x-invalidate: x-invalidate must be an array of routes like "GET /path"; oat cannot use it',
		])
	})
})

describe("validateTags x-entity and x-root", () => {
	it("needs both a name and an action to name an entity, unless the tag only locates the record", () => {
		expect(gapsOf({ "x-entity": { recordPath: "$.data" } })).toEqual([])
		expect(gapsOf({ "x-entity": { createdIdFrom: "$.id" } })).toEqual([])
		expect(gapsOf({ "x-entity": { action: "read", recordPath: "$.data" } })).toEqual([
			'x-entity: x-entity needs "name"; oat cannot use it',
		])
		expect(gapsOf({ "x-entity": { name: "note", recordPath: "$.data" } })).toEqual([
			'x-entity: x-entity needs "action"; oat cannot use it',
		])
		expect(gapsOf({ "x-entity": {} })).toEqual(['x-entity: x-entity needs "name"; oat cannot use it'])
		expect(gapsOf({ "x-entity": { action: "rename", name: "n" } })).toEqual([
			'x-entity: x-entity "action" must be one of "create", "list", "read", "update", "delete", "action"; oat cannot use it',
		])
	})

	it("records a parameter's x-root that is not a boolean", () => {
		expect(gapsOf({ parameters: [{ in: "path", name: "org", "x-root": "yes" }] })).toEqual([
			'x-root: x-root on "org" must be true or false; oat cannot use it',
		])
	})
})
