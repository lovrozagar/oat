import { describe, expect, it } from "vitest"
import type { OpenApiDocument } from "../../../spec/types.ts"
import { FencedError } from "../../fence.ts"
import { contextOf, optionsFor, secured } from "../__fixtures__/api.ts"
import { rootRead } from "./root-read.ts"

/* An entity whose path id is the caller's root: its read, with the root filled in, is its test. */

const org = { properties: { id: { type: "string" } }, type: "object" }
const doc = secured({
	info: { title: "orgs", version: "1" },
	openapi: "3.1.0",
	paths: {
		"/orgs/{org_id}": {
			get: {
				operationId: "org.get",
				parameters: [{ in: "path", name: "org_id", required: true, schema: { type: "string" } }],
				responses: { "200": { content: { "application/json": { schema: org } }, description: "ok" } },
				"x-entity": { action: "read", identity: "root", name: "org" },
			},
		},
	},
}) as unknown as OpenApiDocument

const orgs = (_: string, path: string) =>
	path === "/openapi.json"
		? { body: doc, status: 200 }
		: path === "/orgs/o1"
			? { body: { id: "o1" }, status: 200 }
			: undefined

/* The root read cannot reach the backend. */
const down = (method: string, path: string) => {
	if (path !== "/orgs/o1") return orgs(method, path)
	throw new Error("fetch failed", {
		cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
	})
}

/* The transport throws something that is not a network failure. */
const broken = (method: string, path: string) => {
	if (path !== "/orgs/o1") return orgs(method, path)
	throw new Error("the transport broke")
}

/* The fence refuses the root read. */
const fenced = (method: string, path: string) => {
	if (path !== "/orgs/o1") return orgs(method, path)
	throw new FencedError({ method, phase: "assertion", reason: "no reads", url: path })
}

describe("rootRead", () => {
	it("reads the root the first principal holds, and grades the read", async () => {
		const options = optionsFor(orgs, { principals: { alpha: { scope: { org_id: "o1" } } } })
		const ctx = await contextOf(options)
		const entity = ctx.model.entities.get("org")
		if (entity === undefined) throw new Error("no org entity")
		await rootRead(ctx, entity)
		expect(options.seen.at(-1)).toMatchObject({ method: "GET", path: "/orgs/o1" })
		expect(ctx.state.entitiesTested).toEqual(["org"])
	})

	it("stands down on the network, as every other stage does, when the root read cannot reach the backend", async () => {
		const ctx = await contextOf(optionsFor(down, { principals: { alpha: { scope: { org_id: "o1" } } } }))
		const entity = ctx.model.entities.get("org")
		if (entity === undefined) throw new Error("no org entity")
		await rootRead(ctx, entity)
		expect(ctx.findings.findings.map((finding) => [finding.check, finding.entity])).toEqual([
			["net.unreachable", "org"],
		])
		expect(ctx.network.outcome).toMatchObject({ kind: "refused" })
	})

	it("reports any other error as a check that could not complete, with its message", async () => {
		const ctx = await contextOf(optionsFor(broken, { principals: { alpha: { scope: { org_id: "o1" } } } }))
		const entity = ctx.model.entities.get("org")
		if (entity === undefined) throw new Error("no org entity")
		await rootRead(ctx, entity)
		expect(ctx.findings.findings).toMatchObject([
			{
				check: "read.matches-caller-root",
				detail: "the transport broke",
				summary: 'check "read.matches-caller-root" could not complete',
				verdict: "COVERAGE_GAP",
			},
		])
	})

	it("reports a fenced root read under the fence, attributed to the read", async () => {
		const ctx = await contextOf(optionsFor(fenced, { principals: { alpha: { scope: { org_id: "o1" } } } }))
		const entity = ctx.model.entities.get("org")
		if (entity === undefined) throw new Error("no org entity")
		await rootRead(ctx, entity)
		expect(ctx.findings.findings.map((finding) => [finding.check, finding.verdict, finding.operations])).toEqual([
			["fence", "BLOCKED", ["org.get"]],
		])
	})
})
