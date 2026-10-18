import { describe, expect, it } from "vitest"
import { inProcess, type Via } from "../harness/launch.ts"
import type { Handle } from "../../reference/http/node.ts"
import { type ReferenceResponse, referenceRequest, respond } from "../../reference/http/wire.ts"
import { publicCatalogue } from "./public-catalogue.ts"
import { runTenantScopeSuite } from "./tenant-scope.ts"

/* A transport that cannot reach anything: each case reports why, and the rest still run. */
const nowhere: Via = {
	host: () => Promise.reject(new Error("no host")),
	launch: () => Promise.reject(new Error("no reference")),
}

describe("runTenantScopeSuite", () => {
	it("keeps a public catalogue out of isolation, and splits stated from inferred tenancy", async () => {
		const results = await runTenantScopeSuite(inProcess)
		expect(results.filter((r) => !r.ok).map((r) => `${r.name}: ${r.detail}`)).toEqual([])
		expect(results.map((r) => r.detail)).toEqual([
			"check did not apply; no finding",
			"SECURITY",
			"AMBIGUITY",
			"check did not apply; no finding",
			"SECURITY",
			"AMBIGUITY",
		])
	}, 180_000)

	it("reports every case it could not run", async () => {
		const results = await runTenantScopeSuite(nowhere)
		expect(results.map((r) => [r.ok, r.detail])).toEqual([
			[false, "no host"],
			[false, "no reference"],
			[false, "no reference"],
			[false, "no host"],
			[false, "no reference"],
			[false, "no reference"],
		])
	})

	it("names the verdict a leak got instead of the one it should have", async () => {
		/* The reference launches without the defect it was asked for: no leak to find. */
		const unbroken: Via = {
			...inProcess,
			launch: (backend, options) => inProcess.launch(backend, { ...options, defects: [] }),
		}
		const results = await runTenantScopeSuite(unbroken)
		expect(results.map((r) => r.detail)).toEqual([
			"check did not apply; no finding",
			"expected SECURITY, got no finding",
			"expected AMBIGUITY, got no finding",
			"check did not apply; no finding",
			"expected SECURITY, got no finding",
			"expected AMBIGUITY, got no finding",
		])
	}, 300_000)
})

const WORKSPACE = { in: "path", name: "workspace_id", required: true, schema: { type: "string" } }

/** The catalogue's document with every route under a workspace that `x-tenant` names. */
function tenanted(spec: { paths: Record<string, Record<string, Record<string, unknown>>> }): unknown {
	const paths = Object.entries(spec.paths).map(([path, item]) => {
		const ops = Object.entries(item).map(([method, op]) => {
			const parameters = [WORKSPACE, ...((op.parameters as unknown[] | undefined) ?? [])]
			return [method, { ...op, parameters, "x-tenant": "workspace_id" }]
		})
		return [path.replace("/v1/", "/v1/workspaces/{workspace_id}/"), Object.fromEntries(ops)]
	})
	return { ...spec, paths: Object.fromEntries(paths) }
}

interface Row {
	id: string
}

/** Rows of `workspace` only: what an enforcing backend answers in place of the shared table. */
function scoped(answer: ReferenceResponse, owners: Map<string, string>, workspace: string): ReferenceResponse {
	const body = JSON.parse(answer.body) as Row | { templates: Row[] }
	if (!("templates" in body)) return owners.get(body.id) === workspace ? answer : respond(404, { error: "not_found" })
	return respond(200, { templates: body.templates.filter((row) => owners.get(row.id) === workspace) })
}

/**
 * The public catalogue mounted under a stated tenant: one shared table that leaks across
 * workspaces, or, with `enforce`, each row kept to the workspace that made it.
 */
function catalogueUnder(enforce: boolean): Handle {
	const catalogue = publicCatalogue()
	const owners = new Map<string, string>()
	return async (request) => {
		const [, workspace = ""] = /^\/v1\/workspaces\/([^/]+)\//.exec(request.url.pathname) ?? []
		const url = new URL(request.url)
		url.pathname = request.url.pathname.replace(`/workspaces/${workspace}/`, "/")
		const answer = await catalogue(referenceRequest(request.method, url, request.headers, request.text))
		if (url.pathname === "/v1/openapi/spec") {
			return respond(200, tenanted(JSON.parse(answer.body) as Parameters<typeof tenanted>[0]))
		}
		if (answer.status === 201) owners.set((JSON.parse(answer.body) as Row).id, workspace)
		if (!enforce || answer.status !== 200 || request.method !== "GET") return answer
		return scoped(answer, owners, workspace)
	}
}

describe("runTenantScopeSuite against a catalogue that states a tenant", () => {
	it("fails the catalogue cases, naming the findings and that the checks ran", async () => {
		const results = await runTenantScopeSuite({ ...inProcess, host: () => inProcess.host(catalogueUnder(false)) })
		expect([results[0], results[3]].map((r) => [r?.ok, r?.detail])).toEqual([
			[false, "findings=SECURITY:tenant.item-not-readable-cross-tenant; ran=true; skipped=false"],
			[false, "findings=SECURITY:tenant.filter-does-not-bypass-scope; ran=true; skipped=false"],
		])
	}, 300_000)

	it("fails them too where the stated tenant holds: the checks applied", async () => {
		const results = await runTenantScopeSuite({ ...inProcess, host: () => inProcess.host(catalogueUnder(true)) })
		expect([results[0], results[3]].map((r) => [r?.ok, r?.detail])).toEqual([
			[false, "findings=none; ran=true; skipped=false"],
			[false, "findings=none; ran=true; skipped=false"],
		])
	}, 300_000)
})
