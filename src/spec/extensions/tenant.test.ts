import { describe, expect, it } from "vitest"
import type { Endpoint, OperationObject } from "../types.ts"
import { GapCollector } from "./gaps.ts"
import { pathParameterNames, readRootParams, readTenantParam, readTenantSource } from "./tenant.ts"

const at = (path: string, tenant?: unknown): Endpoint => ({
	method: "get",
	op: (tenant === undefined ? {} : { "x-tenant": tenant }) as OperationObject,
	operationId: "op",
	path,
})

describe("x-tenant", () => {
	it("takes the tag, refuses on false, else guesses from the path with a gap", () => {
		const gaps = new GapCollector()
		expect(readTenantParam(at("/orgs/{org_id}/notes", "workspace"), gaps)).toBe("workspace")
		expect(readTenantParam(at("/projects/{project_id}/notes", false), gaps)).toBeNull()
		expect(readTenantParam(at("/projects/{project_id}/notes"), gaps)).toBe("project_id")
		expect(readTenantParam(at("/notes/{id}"), gaps)).toBeNull()
		expect(readTenantParam(at("/projects/{projectId}/notes"))).toBe("projectId")
		expect(gaps.gaps).toEqual([
			{
				detail: 'assuming "project_id" scopes this operation to a tenant, inferred from its name',
				operationId: "op",
				tag: "x-tenant",
			},
		])
	})

	it("says where the tenant came from", () => {
		expect(readTenantSource(at("/x", "org"))).toBe("tag")
		expect(readTenantSource(at("/orgs/{org}/x", false))).toBeNull()
		expect(readTenantSource(at("/orgs/{organization_slug}/x"))).toBe("heuristic")
		expect(readTenantSource(at("/notes/{id}"))).toBeNull()
	})
})

describe("path parameters", () => {
	it("names each template parameter", () => {
		expect(pathParameterNames("/a/{x}/b/{y_id}")).toEqual(["x", "y_id"])
		expect(pathParameterNames("/a/{}")).toEqual([])
	})

	it("lists the parameters declared as roots", () => {
		const op = {
			parameters: [
				{ in: "path", name: "org", "x-root": true },
				{ in: "path", name: "id" },
				{ in: "query", name: "q", "x-root": true },
			],
		} as OperationObject
		expect(readRootParams(op)).toEqual(["org"])
		expect(readRootParams({} as OperationObject)).toEqual([])
	})
})
