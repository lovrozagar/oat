import { describe, expect, it } from "vitest"
import { doc, list, member, members, ok } from "../__fixtures__/documents.ts"
import { dereference } from "../load/dereference.ts"
import { buildModel } from "./build.ts"
import { operation, operationsOf } from "./__fixtures__/operations.ts"
import { separateSameNamedCollections } from "./naming.ts"

const views = (parent: string, param: string) => ({
	[`/v1/${parent}/{${param}}/members`]: {
		get: { operationId: `${parent}.members.list`, responses: ok(list(member)) },
	},
})

const entitiesAfter = (paths: Record<string, unknown>) => {
	const { operations } = operationsOf(paths)
	separateSameNamedCollections(operations)
	return operations.map((op) => [op.operationId, op.entity])
}

describe("separateSameNamedCollections", () => {
	it("keeps same-named collections under different parents apart", () => {
		const model = buildModel(
			dereference(doc({ ...members("projects", "project_id"), ...members("orgs", "org_id") })).doc,
		)
		expect([...model.entities.keys()].sort()).toEqual(["org-member", "project-member"])
		expect(model.entities.get("project-member")?.list).toBe("projects.members.list")
		expect(model.entities.get("org-member")?.create).toBe("orgs.members.create")
	})

	it("names a split collection by its final name when it reports a gap", () => {
		const both = doc({ ...views("projects", "project_id"), ...views("orgs", "org_id") })
		const found = buildModel(dereference(both).doc)
			.gaps.gaps.filter((gap) => gap.tag === "x-entity")
			.map((gap) => gap.detail)
		expect(found.some((detail) => detail.includes('treats "org-member" as its own entity'))).toBe(true)
		expect(found.some((detail) => detail.includes('treats "member"'))).toBe(false)
	})

	it("leaves a name alone when only one collection carries it", () => {
		expect([...buildModel(dereference(doc(members("projects", "project_id"))).doc).entities.keys()]).toEqual(["member"])
	})
})

describe("separateSameNamedCollections by depth", () => {
	it("reaches further up, past versions, until the names differ, and stops when it runs out", () => {
		expect(
			entitiesAfter({
				"/v1/a/{x}/team/{t}/members": { get: { operationId: "a", responses: ok(list(member)) } },
				"/v2/b/{y}/team/{t}/members": { get: { operationId: "b", responses: ok(list(member)) } },
				"/members": { get: { operationId: "c", responses: ok(list(member)) } },
				"/v1": { get: { operationId: "root", responses: ok(list(member)) } },
				"/tags": { get: { operationId: "tags", responses: ok(list(member)) } },
			}),
		).toEqual([
			["a", "a-team-member"],
			["b", "b-team-member"],
			["c", "member"],
			["root", null],
			["tags", "tag"],
		])
		expect(
			entitiesAfter({
				"/team/{t}/members": { get: { operationId: "a", responses: ok(list(member)) } },
				"/team/{t}/x/{y}/members": { get: { operationId: "b", responses: ok(list(member)) } },
			}),
		).toEqual([
			["a", "team-member"],
			["b", "x-member"],
		])
		expect(
			entitiesAfter({
				"/v1/team/members": { get: { operationId: "a", responses: ok(list(member)) } },
				"/v2/team/members": { get: { operationId: "b", responses: ok(list(member)) } },
			}),
		).toEqual([
			["a", "team-member"],
			["b", "team-member"],
		])
	})

	it("leaves tagged names, and names no segment carries, as they are", () => {
		const tagged = operation({ entity: "member", entitySource: "tag", path: "/a/{x}/members" })
		const unmatched = operation({ entity: "member", entitySource: "heuristic", path: "/a/{x}/people" })
		const other = operation({ entity: "member", entitySource: "heuristic", path: "/b/{x}/members" })
		const none = operation({ entity: null, path: "/c/{x}/members" })
		separateSameNamedCollections([tagged, unmatched, other, none])
		expect([tagged.entity, unmatched.entity, other.entity, none.entity]).toEqual(["member", "member", "member", null])
	})
})
