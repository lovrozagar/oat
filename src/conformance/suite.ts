/**
 * Conformance suite: the measurement loop.
 *
 * For each injected defect, assert oat reports exactly the check that defect should trip — and
 * for the clean baseline, assert it reports nothing at all. The baseline is the harder bar: a
 * tool that cries wolf on a correct backend is worse than no tool.
 *
 * Adding a check to oat means adding a defect here and expecting it. That keeps "smart" honest.
 */

import { execFile } from "node:child_process"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { DEFECTS, type DefectName } from "../reference/defects.ts"
import { STRING_PAYLOADS, catalogProblems } from "../runtime/payloads.ts"
import { coverageByCheck, renderConsole, renderRepros, type ReportInput } from "../report/render.ts"
import { CHECKS } from "../runtime/checks.ts"
import type { Finding } from "../runtime/finding.ts"
import { type PrincipalSpec, run } from "../runtime/run.ts"
import { buildModel } from "../spec/graph.ts"
import { dereference, loadSpec } from "../spec/load.ts"
import type { OpenApiDocument } from "../spec/types.ts"
import { SPEC_FIXTURES } from "./specs.ts"

export interface ParserResult {
	name: string
	why: string
	ok: boolean
	detail: string
}

/**
 * Parser robustness. These fixtures are shapes real published documents contain; the bar is that
 * oat never throws and never hangs on them, not that it models them well.
 */
export { runSeedContractSuite } from "./seed-contract.ts"

export function runParserSuite(): ParserResult[] {
	return SPEC_FIXTURES.map((fixture) => {
		try {
			const { doc, externalRefs } = dereference(fixture.doc as OpenApiDocument)
			const model = buildModel(doc)

			const problems: string[] = []
			if (fixture.expectOperations !== undefined && model.operations.length !== fixture.expectOperations) {
				problems.push(`expected ${fixture.expectOperations} operation(s), modelled ${model.operations.length}`)
			}
			if (fixture.expectEntities !== undefined && model.entities.size !== fixture.expectEntities) {
				problems.push(`expected ${fixture.expectEntities} entity/entities, modelled ${model.entities.size}`)
			}
			if (fixture.name === "external-ref" && externalRefs.length === 0) {
				problems.push("external $ref was silently resolved instead of reported")
			}
			if (fixture.name === "irregular-plurals") {
				const names = [...model.entities.keys()]
				for (const bad of ["statu", "analyse", "peopl", "campuse", "inbo"]) {
					if (names.includes(bad)) problems.push(`mangled plural produced entity "${bad}"`)
				}
			}
			if (fixture.name === "multiple-arrays-in-envelope") {
				const op = model.operations[0]
				if (op?.collection?.key !== "reports") {
					problems.push(`collection key resolved to "${op?.collection?.key ?? "none"}", expected "reports"`)
				}
			}
			if (fixture.name === "query-roles-by-alias") {
				const op = model.operations[0]
				if (op?.query?.source !== "heuristic") {
					problems.push(`query source is ${op?.query?.source ?? "null"}, expected heuristic`)
				}
				if (op?.query?.maxLimit !== 50) {
					problems.push(`maxLimit is ${String(op?.query?.maxLimit)}, expected 50 from per_page.maximum`)
				}
				if (op?.conventions.order !== "sort" || op?.conventions.select !== "fields" || op?.conventions.search !== "q") {
					problems.push(
						`roles resolved to order=${op?.conventions.order} select=${op?.conventions.select} search=${op?.conventions.search}`,
					)
				}
			}
			if (fixture.name === "pagination-only-is-not-query") {
				const op = model.operations[0]
				if (op?.query !== null) {
					problems.push(`query capability inferred from page/limit/status: ${op?.query?.source ?? "unknown"}`)
				}
			}

			return {
				detail: problems.join("; ") || `${model.operations.length} ops, ${model.entities.size} entities`,
				name: fixture.name,
				ok: problems.length === 0,
				why: fixture.why,
			}
		} catch (error) {
			return {
				detail: `threw: ${error instanceof Error ? error.message : String(error)}`,
				name: fixture.name,
				ok: false,
				why: fixture.why,
			}
		}
	})
}

/**
 * The annotated example document must resolve to what its comments claim.
 *
 * `labs/annotated-openapi.yaml` is the only place that shows a reader where each tag goes in a
 * real document, and documentation that drifts from the implementation is worse than none — it
 * teaches a shape that no longer works. Asserting the derived model here means the example cannot
 * rot: rename a tag or change how a role resolves, and this fails.
 *
 * It also proved its worth immediately. The first version was invalid YAML (`{workspace_id}` inside
 * a flow sequence) and named an `x-invalidate` route that did not exist in the document.
 */
export async function runExampleSpecSuite(): Promise<ParserResult[]> {
	const path = new URL("../../labs/annotated-openapi.yaml", import.meta.url).pathname
	const results: ParserResult[] = []
	const fail = (name: string, why: string, detail: string): void => {
		results.push({ detail, name, ok: false, why })
	}

	let model: ReturnType<typeof buildModel>
	try {
		const { doc } = dereference(await loadSpec(path))
		model = buildModel(doc)
	} catch (error) {
		fail(
			"annotated-openapi.yaml",
			"the documented example must be a parseable OpenAPI document",
			error instanceof Error ? error.message : String(error),
		)
		return results
	}

	const list = model.byOperationId.get("widget.list")
	const create = model.byOperationId.get("widget.create")
	const update = model.byOperationId.get("widget.update")
	const start = model.byOperationId.get("export.start")
	const widgetRead = model.byOperationId.get("widget.read")
	const templateRead = model.byOperationId.get("template.read")

	const expectations: Array<[string, string, unknown, unknown]> = [
		["x-query resolves the filter grammar", "the comment claims postgrest", list?.conventions.grammar, "postgrest"],
		["x-query declares filterable fields", "not guessed from the schema", list?.query?.source, "tag"],
		[
			"x-query accepts structured filterable rows",
			"declared-or-skip catalog",
			list?.query?.filterFields?.[0]?.field,
			"id",
		],
		["x-query sets maxLimit", "used to bound page-size probes", list?.query?.maxLimit, 100],
		["limit resolves as page size", "distinguished by maximum + default", list?.conventions.limit, "limit"],
		["cursor role resolves", "declared alongside page", list?.conventions.cursor, "cursor"],
		["x-tenant is declared, not inferred", "decides SECURITY vs AMBIGUITY", list?.tenantSource, "tag"],
		["workspace widget read is tagged", "SECURITY vs AMBIGUITY is unchanged", widgetRead?.tenantSource, "tag"],
		[
			"public catalogue is unscoped",
			"no x-tenant and template_id is not a tenant name",
			templateRead?.tenantSource,
			null,
		],
		["public catalogue has no tenant param", 'omit is not the string "null"', templateRead?.tenantParam, null],
		["x-invalidate names two routes", "one of them cross-entity", create?.invalidates.length, 2],
		["idempotency header is modelled", "a promise oat replays", create?.idempotencyHeader, "Idempotency-Key"],
		["x-immutable is read", "probed for rejection", update?.immutable.includes("workspace_id"), true],
		["x-async is read", "oat follows the job", start?.async?.poll, "export.read"],
		["x-feature-gate is read", "a matching 403 is coverage, not a seed defect", create?.featureGate, "widgets"],
	]

	for (const [name, why, actual, expected] of expectations) {
		const ok = JSON.stringify(actual) === JSON.stringify(expected)
		results.push({
			detail: ok ? `${JSON.stringify(actual)}` : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
			name,
			ok,
			why,
		})
	}
	return results
}

/**
 * A skip on one entity must not look like the check never ran.
 *
 * Multi-entity labs made this lie: invalidate ran on every child and the console still said
 * "did not apply" because the parents skipped it.
 */
export function runCoverageReportSuite(): ParserResult[] {
	const input = {
		checksRun: ["invalidation.declared-route-changes", "list.read-after-write"],
		checksSkipped: [
			{ check: "invalidation.declared-route-changes", entity: "parent", needs: "a foreign read route" },
			{ check: "async.reaches-terminal-state", entity: "parent", needs: "x-async" },
			{ check: "async.reaches-terminal-state", entity: "child", needs: "x-async" },
		],
		checksSuppressed: [],
		client: { transcript: [] },
		durationMs: 1,
		entitiesTested: ["parent", "child"],
		findings: [],
	} as unknown as ReportInput

	const coverage = coverageByCheck(input)
	const text = renderConsole(input)
	const cases: Array<[string, string, boolean]> = [
		[
			"invalidate is partial, not never",
			"it ran on the child",
			coverage.partialSkip.some((r) => r.check === "invalidation.declared-route-changes"),
		],
		[
			"async never applied",
			"neither entity had x-async",
			coverage.never.some((r) => r.check === "async.reaches-terminal-state"),
		],
		[
			"console does not put a ran check under DID NOT APPLY",
			"the invalidate line lives in APPLIED ONLY ON SOME ENTITIES",
			text.includes("APPLIED ONLY ON SOME ENTITIES") &&
				(text.split("APPLIED ONLY ON SOME ENTITIES")[0] ?? "").includes("invalidation") === false,
		],
	]
	return cases.map(([name, why, ok]) => ({
		detail: ok ? "true" : "false",
		name,
		ok,
		why,
	}))
}

/**
 * `doctor` claims each tag unlocks specific checks. This proves it.
 *
 * The reference backend is run twice — with its tags and with them stripped — and the checks that
 * disappear must be exactly the set `TAG_UNLOCKS` promises. Without this the claim is a hand-
 * maintained list that drifts the moment a check's applicability changes, and a coverage promise
 * nobody verified is worse than no promise.
 */
export async function runTagUnlockSuite(): Promise<ParserResult[]> {
	const { createMemoryServer } = await import("../reference/http.ts")
	const { TAG_UNLOCKS } = await import("../report/console.ts")

	const ran = async (untagged: boolean): Promise<Set<string>> => {
		const server = await createMemoryServer({ untagged })
		try {
			const result = await run({
				baseUrl: server.url,
				principals: PRINCIPALS,
				seed: 42,
				spec: `${server.url}/v1/openapi/spec`,
			})
			return new Set(result.checksRun)
		} finally {
			await server.close()
		}
	}

	const tagged = await ran(false)
	const untagged = await ran(true)
	const lost = [...tagged].filter((id) => !untagged.has(id)).sort()
	const promised = Object.values(TAG_UNLOCKS).flat().sort()

	const missing = promised.filter((id) => !lost.includes(id))
	const unclaimed = lost.filter((id) => !promised.includes(id))
	const ok = missing.length === 0 && unclaimed.length === 0

	return [
		{
			detail: ok
				? `${lost.length} check(s) unlocked by tags, exactly as documented`
				: `promised-but-not-lost: [${missing.join(", ")}]; lost-but-unclaimed: [${unclaimed.join(", ")}]`,
			name: "doctor's tag-unlock claims are true",
			ok,
			why: "a coverage promise nobody verified is worse than no promise",
		},
	]
}

/**
 * A public catalogue is unscoped. Two principals, create as A, GET or filter as B → 200 is
 * the contract, and the isolation checks must not apply. The workspace-scoped widget fixture
 * is unchanged: tag → SECURITY, heuristic → AMBIGUITY. Same split for item GET and for
 * `filter=id.eq.<other tenant>`.
 */
export async function runTenantScopeSuite(): Promise<ParserResult[]> {
	const results: ParserResult[] = []

	try {
		const server = await servePublicCatalogue()
		try {
			const result = await run({
				baseUrl: server.url,
				principals: [
					{ headers: { authorization: "Bearer tok_alpha" }, id: "alpha", roots: { workspace_id: "ws_a" } },
					{ headers: { authorization: "Bearer tok_beta" }, id: "beta", roots: { workspace_id: "ws_b" } },
				],
				seed: 42,
				spec: `${server.url}/v1/openapi/spec`,
			})
			const tenantFindings = result.findings.filter(
				(f) =>
					f.check === "tenant.item-not-readable-cross-tenant" || f.check === "tenant.denial-does-not-reveal-existence",
			)
			const skipped = result.checksSkipped.some((s) => s.check === "tenant.item-not-readable-cross-tenant")
			const ran = result.checksRun.includes("tenant.item-not-readable-cross-tenant")
			const ok = tenantFindings.length === 0 && skipped && !ran
			results.push({
				detail: ok
					? "check did not apply; no finding"
					: `findings=${tenantFindings.map((f) => `${f.verdict}:${f.check}`).join(",") || "none"}; ` +
						`ran=${String(ran)}; skipped=${String(skipped)}`,
				name: "public catalogue 200 is not a finding",
				ok,
				why: "no x-tenant and template_id is not a tenant name, so isolation does not apply",
			})
		} finally {
			await server.close()
		}
	} catch (error) {
		results.push({
			detail: error instanceof Error ? error.message : String(error),
			name: "public catalogue 200 is not a finding",
			ok: false,
			why: "no x-tenant and template_id is not a tenant name, so isolation does not apply",
		})
	}

	const leak = async (untagged: boolean): Promise<{ verdict: string | null; check: string | null }> => {
		const { createMemoryServer } = await import("../reference/http.ts")
		const backend = await createMemoryServer({ defects: ["CROSS_TENANT_READ"], untagged })
		try {
			const result = await run({
				baseUrl: backend.url,
				only: ["table"],
				principals: PRINCIPALS,
				seed: 42,
				spec: `${backend.url}/v1/openapi/spec`,
			})
			const hit = result.findings.find((f) => f.check === "tenant.item-not-readable-cross-tenant")
			return { check: hit?.check ?? null, verdict: hit?.verdict ?? null }
		} finally {
			await backend.close()
		}
	}

	try {
		const tagged = await leak(false)
		const ok = tagged.verdict === "SECURITY"
		results.push({
			detail: ok ? "SECURITY" : `expected SECURITY, got ${tagged.verdict ?? "no finding"}`,
			name: "tagged tenant leak is SECURITY",
			ok,
			why: "x-tenant + 200 from the other principal is a stated-boundary breach",
		})
	} catch (error) {
		results.push({
			detail: error instanceof Error ? error.message : String(error),
			name: "tagged tenant leak is SECURITY",
			ok: false,
			why: "x-tenant + 200 from the other principal is a stated-boundary breach",
		})
	}

	try {
		const inferred = await leak(true)
		const ok = inferred.verdict === "AMBIGUITY"
		results.push({
			detail: ok ? "AMBIGUITY" : `expected AMBIGUITY, got ${inferred.verdict ?? "no finding"}`,
			name: "inferred tenant leak is AMBIGUITY",
			ok,
			why: "workspace_id / project_id still infers a tenant when x-tenant is stripped",
		})
	} catch (error) {
		results.push({
			detail: error instanceof Error ? error.message : String(error),
			name: "inferred tenant leak is AMBIGUITY",
			ok: false,
			why: "workspace_id / project_id still infers a tenant when x-tenant is stripped",
		})
	}

	try {
		const server = await servePublicCatalogue()
		try {
			const result = await run({
				baseUrl: server.url,
				principals: [
					{ headers: { authorization: "Bearer tok_alpha" }, id: "alpha", roots: { workspace_id: "ws_a" } },
					{ headers: { authorization: "Bearer tok_beta" }, id: "beta", roots: { workspace_id: "ws_b" } },
				],
				seed: 42,
				spec: `${server.url}/v1/openapi/spec`,
			})
			const hits = result.findings.filter((f) => f.check === "tenant.filter-does-not-bypass-scope")
			const skipped = result.checksSkipped.some((s) => s.check === "tenant.filter-does-not-bypass-scope")
			const ran = result.checksRun.includes("tenant.filter-does-not-bypass-scope")
			const ok = hits.length === 0 && skipped && !ran
			results.push({
				detail: ok
					? "check did not apply; no finding"
					: `findings=${hits.map((f) => `${f.verdict}:${f.check}`).join(",") || "none"}; ` +
						`ran=${String(ran)}; skipped=${String(skipped)}`,
				name: "public catalogue filter 200 is not a finding",
				ok,
				why: "no x-tenant and no tenant-named path param, so a 200 on id.eq.<other row> is the contract",
			})
		} finally {
			await server.close()
		}
	} catch (error) {
		results.push({
			detail: error instanceof Error ? error.message : String(error),
			name: "public catalogue filter 200 is not a finding",
			ok: false,
			why: "no x-tenant and no tenant-named path param, so a 200 on id.eq.<other row> is the contract",
		})
	}

	const leakFilter = async (untagged: boolean): Promise<{ verdict: string | null; check: string | null }> => {
		const { createMemoryServer } = await import("../reference/http.ts")
		const backend = await createMemoryServer({ defects: ["TENANT_LEAK_VIA_FILTER"], untagged })
		try {
			const result = await run({
				baseUrl: backend.url,
				only: ["table"],
				principals: PRINCIPALS,
				seed: 42,
				spec: `${backend.url}/v1/openapi/spec`,
			})
			const hit = result.findings.find((f) => f.check === "tenant.filter-does-not-bypass-scope")
			return { check: hit?.check ?? null, verdict: hit?.verdict ?? null }
		} finally {
			await backend.close()
		}
	}

	try {
		const tagged = await leakFilter(false)
		const ok = tagged.verdict === "SECURITY"
		results.push({
			detail: ok ? "SECURITY" : `expected SECURITY, got ${tagged.verdict ?? "no finding"}`,
			name: "tagged tenant filter leak is SECURITY",
			ok,
			why: "x-tenant + filter 200 of the other tenant's row is a stated-boundary breach",
		})
	} catch (error) {
		results.push({
			detail: error instanceof Error ? error.message : String(error),
			name: "tagged tenant filter leak is SECURITY",
			ok: false,
			why: "x-tenant + filter 200 of the other tenant's row is a stated-boundary breach",
		})
	}

	try {
		const inferred = await leakFilter(true)
		const ok = inferred.verdict === "AMBIGUITY"
		results.push({
			detail: ok ? "AMBIGUITY" : `expected AMBIGUITY, got ${inferred.verdict ?? "no finding"}`,
			name: "inferred tenant filter leak is AMBIGUITY",
			ok,
			why: "workspace_id / project_id still infers a tenant when x-tenant is stripped",
		})
	} catch (error) {
		results.push({
			detail: error instanceof Error ? error.message : String(error),
			name: "inferred tenant filter leak is AMBIGUITY",
			ok: false,
			why: "workspace_id / project_id still infers a tenant when x-tenant is stripped",
		})
	}

	return results
}

const PUBLIC_CATALOGUE_SPEC = {
	info: { title: "Public catalogue", version: "1.0" },
	openapi: "3.1.0",
	paths: {
		"/v1/templates": {
			get: {
				operationId: "template.list",
				parameters: [
					{
						description: "PostgREST filter expression, e.g. id.eq.value",
						in: "query",
						name: "filter",
						required: false,
						schema: { type: "string" },
					},
				],
				responses: {
					"200": {
						content: {
							"application/json": {
								schema: {
									properties: {
										templates: {
											items: { properties: { id: { type: "string" }, name: { type: "string" } }, type: "object" },
											type: "array",
										},
									},
									required: ["templates"],
									type: "object",
								},
							},
						},
						description: "ok",
					},
				},
				"x-entity": { action: "list", identity: "id", name: "template" },
			},
			post: {
				operationId: "template.create",
				requestBody: {
					content: {
						"application/json": {
							schema: {
								additionalProperties: false,
								properties: { name: { maxLength: 128, type: "string" } },
								required: ["name"],
								type: "object",
							},
						},
					},
					required: true,
				},
				responses: {
					"201": {
						content: {
							"application/json": {
								schema: { properties: { id: { type: "string" }, name: { type: "string" } }, type: "object" },
							},
						},
						description: "created",
					},
				},
				"x-entity": { action: "create", identity: "id", name: "template" },
			},
		},
		"/v1/templates/{template_id}": {
			delete: {
				operationId: "template.delete",
				parameters: [{ in: "path", name: "template_id", required: true, schema: { type: "string" } }],
				responses: { "204": { description: "deleted" } },
				"x-entity": { action: "delete", identity: "id", name: "template" },
			},
			get: {
				operationId: "template.read",
				parameters: [{ in: "path", name: "template_id", required: true, schema: { type: "string" } }],
				responses: {
					"200": {
						content: {
							"application/json": {
								schema: { properties: { id: { type: "string" }, name: { type: "string" } }, type: "object" },
							},
						},
						description: "ok",
					},
				},
				"x-entity": { action: "read", identity: "id", name: "template" },
			},
		},
	},
}

async function servePublicCatalogue(): Promise<{ close: () => Promise<void>; url: string }> {
	const rows = new Map<string, { id: string; name: string }>()
	let seq = 0
	const tokens = new Set(["tok_alpha", "tok_beta"])

	const readJson = (req: IncomingMessage): Promise<unknown> =>
		new Promise((resolve, reject) => {
			const chunks: Buffer[] = []
			req.on("data", (chunk: Buffer) => {
				chunks.push(chunk)
			})
			req.on("end", () => {
				const text = Buffer.concat(chunks).toString("utf8")
				if (text === "") {
					resolve(undefined)
					return
				}
				try {
					resolve(JSON.parse(text) as unknown)
				} catch (error) {
					reject(error)
				}
			})
			req.on("error", reject)
		})

	const send = (res: ServerResponse, status: number, body?: unknown): void => {
		if (body === undefined) {
			res.writeHead(status)
			res.end()
			return
		}
		const text = JSON.stringify(body)
		res.writeHead(status, { "content-type": "application/json", "content-length": String(Buffer.byteLength(text)) })
		res.end(text)
	}

	const server = createServer((req, res) => {
		void (async () => {
			const url = new URL(req.url ?? "/", "http://127.0.0.1")
			const method = (req.method ?? "GET").toUpperCase()
			if (url.pathname === "/v1/openapi/spec" && method === "GET") {
				return send(res, 200, PUBLIC_CATALOGUE_SPEC)
			}
			const header = req.headers.authorization
			if (typeof header !== "string" || !header.startsWith("Bearer ") || !tokens.has(header.slice(7).trim())) {
				return send(res, 401, { error: "unauthorized" })
			}
			if (url.pathname === "/v1/templates" && method === "GET") {
				const raw = url.searchParams.get("filter")
				const match = raw === null ? null : /^id\.eq\.(.+)$/.exec(raw)
				if (match !== null) {
					const row = rows.get(match[1] ?? "")
					return send(res, 200, { templates: row === undefined ? [] : [row] })
				}
				return send(res, 200, { templates: [...rows.values()] })
			}
			if (url.pathname === "/v1/templates" && method === "POST") {
				const body = (await readJson(req)) as { name?: unknown }
				const name = typeof body?.name === "string" ? body.name : ""
				const id = `tmpl_${String((seq += 1))}`
				const row = { id, name }
				rows.set(id, row)
				return send(res, 201, row)
			}
			const item = /^\/v1\/templates\/([^/]+)$/.exec(url.pathname)
			if (item !== null && method === "GET") {
				const row = rows.get(decodeURIComponent(item[1] ?? ""))
				return row === undefined ? send(res, 404, { error: "not_found" }) : send(res, 200, row)
			}
			if (item !== null && method === "DELETE") {
				const id = decodeURIComponent(item[1] ?? "")
				if (!rows.has(id)) return send(res, 404, { error: "not_found" })
				rows.delete(id)
				return send(res, 204)
			}
			return send(res, 404, { error: "not_found" })
		})().catch(() => {
			if (!res.headersSent) send(res, 500, { error: "internal" })
		})
	})

	await new Promise<void>((resolve) => {
		server.listen(0, "127.0.0.1", resolve)
	})
	const addr = server.address() as AddressInfo
	return {
		close: () =>
			new Promise((resolve, reject) => {
				server.close((error) => (error ? reject(error) : resolve()))
			}),
		url: `http://127.0.0.1:${addr.port}`,
	}
}

export function runPayloadCatalogSuite(): ParserResult[] {
	const problems = catalogProblems()
	return [
		{
			detail: problems.join("; ") || `${STRING_PAYLOADS.length} cases, JSON-stable, no NUL`,
			name: "string-payload-catalog",
			ok: problems.length === 0,
			why: "the payload catalog must be unique, JSON-round-trippable, and cover every promised family",
		},
	]
}

export function renderParserSuite(results: ParserResult[]): { text: string; failures: number } {
	const lines: string[] = []
	let failures = 0
	lines.push("")
	lines.push("  spec fixture                  result")
	lines.push("  ─────────────────────────────────────────────────────────────────────────")
	for (const result of results) {
		if (!result.ok) failures++
		lines.push(`  ${result.ok ? "✓" : "✗"} ${result.name.padEnd(28)} ${result.detail}`)
		if (!result.ok) lines.push(`      ${result.why}`)
	}
	lines.push("")
	lines.push(`  ${results.length - failures}/${results.length} hostile specs handled`)
	lines.push("")
	return { failures, text: lines.join("\n") }
}

const exec = promisify(execFile)

/**
 * Generated reproducers are shell scripts, so a quoting mistake turns them into scripts that run
 * against a literal `$BASE` with a literal `$TOKEN` — they look right and do the wrong thing.
 * `bash -n` parses without executing, which catches that class before anyone copies one.
 */
export async function checkReproSyntax(findings: Finding[]): Promise<string[]> {
	const scripts = renderRepros(findings, "https://example.test")
	if (scripts.length === 0) return []
	const dir = await mkdtemp(join(tmpdir(), "oat-repro-"))
	const failures: string[] = []
	for (const script of scripts) {
		const path = join(dir, script.filename)
		await writeFile(path, script.content)
		try {
			await exec("bash", ["-n", path])
		} catch (error) {
			failures.push(`${script.filename}: ${error instanceof Error ? error.message : String(error)}`)
		}
		/* An unexpanded variable inside single quotes is syntactically valid and semantically
		 * wrong, so parse success is not enough. Checked per line and skipping comments: prose
		 * apostrophes ("schema's") would otherwise let the match span into unrelated code. */
		for (const line of script.content.split("\n")) {
			if (line.trimStart().startsWith("#")) continue
			if (/'[^']*\$(BASE|TOKEN)[^']*'/.test(line)) {
				failures.push(
					`${script.filename}: $BASE/$TOKEN appears inside single quotes and will not expand — ${line.trim()}`,
				)
			}
		}
	}
	return failures
}

/**
 * Which check each defect must trip.
 *
 * The first id is the primary — the diagnosis oat is required to reach. Any further ids are
 * *acceptable* consequences: one defect can legitimately violate several properties at once, and
 * calling those false positives would push oat toward under-reporting real problems.
 */
export const EXPECTED: Record<DefectName, string | string[]> = {
	CREATED_201_AS_200: "create.status-matches-document",
	CROSS_TENANT_READ: "tenant.item-not-readable-cross-tenant",
	EXISTENCE_LEAK_VIA_STATUS: "tenant.denial-does-not-reveal-existence",
	IDEMPOTENCY_IGNORED: "idempotency.replay-does-not-duplicate",
	PARENT_PROJECTION_STALE: "invalidation.declared-route-changes",
	SPEC_OVERCLAIMS_FILTERABLE: "spec.declared-filterable-is-filterable",
	SPEC_OVERCLAIMS_SORTABLE: ["spec.declared-sortable-is-sortable", "spec.declared-sortable-nulls-accepted"],
	FILTER_GROUP_COMBINATOR_SWAPPED: [
		"filter.and-composes-as-intersection",
		/* Only fires where an or() combinator exists to swap at all — the postgrest-shaped
		 * dialects. On the others the swap still corrupts and(), which is the primary. */
		"filter.or-composes-as-union",
	],
	SPEC_OVERCLAIMS_SELECTABLE: "spec.declared-selectable-is-selectable",
	FILTER_AFTER_PAGINATION: [
		"query.filter-selects-from-whole-set",
		/* The same misordering makes a filtered page shorter than the page size, which the
		 * count and negation properties observe from their own angles. */
		"count.matches-filtered-set",
		"filter.negation-partitions-the-set",
		"filter.equality-selects-exactly-one",
		"filter.zero-match-returns-none",
		"query.axes-compose",
		/* A range predicate is evaluated over the same truncated window, so it under-matches too. */
		"filter.numeric-comparison-is-numeric",
		/* And a record that falls outside the window is absent from a filtered projection while
		 * present in the item route, which is a genuine disagreement between read paths. */
		"consistency.projections-agree",
		/* The tenant-scoping probe filters too, so its records fall outside the window and the
		 * leak it looks for cannot be observed. */
		"tenant.filter-does-not-bypass-scope",
	],
	FILTER_DROPPED_WHEN_SORTED: [
		"query.axes-compose",
		/* A sorted page walk gathers its set with the filter present, so the same drop shows up
		 * there — and the negation check partitions across pages under a sort too. */
		"filter.negation-partitions-the-set",
		"pagination.page-walk-covers-set",
		"count.matches-filtered-set",
	],
	FILTER_DROPPED_WHEN_SELECTED: "query.filter-and-select-compose",
	FILTER_DROPPED_WHEN_SEARCHED: "query.search-and-filter-compose",
	FILTER_DROPPED_WHEN_SORTED_AND_SELECTED: "query.filter-sort-select-compose",
	FILTER_DROPPED_WHEN_SORTED_AND_SEARCHED: "query.filter-search-sort-compose",
	FILTER_DROPPED_WHEN_SEARCHED_AND_SELECTED: "query.filter-search-select-compose",
	LIST_DETAIL_DISAGREE: [
		"consistency.projections-agree",
		/* A listing serving a different value for a searchable field also breaks every predicate
		 * evaluated against the stored value: the record comes back under a name the caller can
		 * see but cannot search or filter for. */
		"search.q-narrows-result",
		"filter.equality-selects-exactly-one",
		"select.projection-honoured",
		"sort.order-is-applied",
	],
	COUNT_IGNORES_FILTER: "count.matches-filtered-set",
	CURSOR_DRIFT: "pagination.cursor-agrees-with-page",
	DELETE_MISSING_OK: "delete.absent-record-returns-404",
	ERROR_500_ON_BAD_FILTER: [
		"error.malformed-filter-not-5xx",
		/* 500 is not in the document. The status-vs-document check is a real second symptom,
		 * not a misdiagnosis: the handler crashed and invented a code the spec never named. */
		"response.status-is-documented",
	],
	FILTER_IGNORED: "filter.unknown-field-rejected",
	IMMUTABLE_WRITABLE: "patch.immutable-field-rejected",
	LIKE_UNESCAPED: "filter.like-metacharacters-escaped",
	OFF_BY_ONE_PAGE: "pagination.page-walk-covers-set",
	PATCH_REPLACES: ["patch.minimality", "consistency.projections-agree"],
	SELECT_IGNORED: "select.projection-honoured",
	SOFT_DELETE_LEAK: "softdelete.absent-from-default-list",
	STALE_LIST: "list.read-after-write",
	TENANT_LEAK_VIA_FILTER: "tenant.filter-does-not-bypass-scope",
	UNSTABLE_SORT: [
		"pagination.page-walk-covers-set",
		/* An unstable default order can hide a just-created record behind a page boundary,
		 * which the write-visibility check observes as a lost write. Same root cause. */
		"list.read-after-write",
		"sort.stable-tiebreak",
	],
	LIMIT_IGNORED: "pagination.limit-bounds-page-size",
	LIMIT_EXCEEDS_MAX: "pagination.limit-respects-documented-max",
	HASMORE_ALWAYS_FALSE: "pagination.has-more-is-accurate",
	ORDER_IGNORED: "sort.order-is-applied",
	SEARCH_IGNORED: "search.q-narrows-result",
	CREATE_DROPS_FIELD: "create.persists-submitted-fields",
	STRING_PAYLOAD_MANGLED: "payload.string-survives",
	RESPONSE_STATUS_UNDECLARED: "response.status-is-documented",
	ENUM_NOT_VALIDATED: "validation.enum-enforced",
	MAXLENGTH_NOT_VALIDATED: "validation.max-length-enforced",
	REQUIRED_NOT_VALIDATED: "validation.required-enforced",
	CONTENT_TYPE_NOT_ENFORCED: "validation.content-type-enforced",
	ERROR_SCHEMA_DRIFT: "schema.error-response-matches-document",
	RESPONSE_SCHEMA_DRIFT: "schema.success-response-matches-document",
	FILTER_EQ_NOT_APPLIED: [
		"filter.equality-selects-exactly-one",
		"filter.zero-match-returns-none",
		"filter.negation-partitions-the-set",
		"count.matches-filtered-set",
		"filter.like-metacharacters-escaped",
	],
	EMPTY_RESULT_RETURNS_ALL: [
		"filter.zero-match-returns-none",
		"filter.unknown-field-rejected",
		"filter.like-metacharacters-escaped",
		/* Falling back to the unfiltered set breaks every narrowing predicate, not just the
		 * filter that triggered it — search and the tenant-scoped filter included. */
		"search.q-narrows-result",
		"tenant.filter-does-not-bypass-scope",
		"filter.negation-partitions-the-set",
		/* A page walk narrows too: the final page's query legitimately matches nothing, and a
		 * backend that answers "nothing" with "everything" makes records reappear mid-walk. */
		"pagination.page-walk-covers-set",
		"count.matches-filtered-set",
		"filter.empty-in",
	],
	COUNT_ALWAYS_ZERO: ["count.consistent-with-returned-page", "count.matches-filtered-set"],
	NEQ_DROPS_NULLS: "filter.negation-partitions-the-set",
	SORT_DESC_DROPS_NULLS: "sort.reverse-symmetry",
	EFFECT_NOT_APPLIED: ["effects.declared-effect-occurs", "async.reaches-terminal-state"],
	COLUMN_NAME_MISMATCH: [
		"create.persists-submitted-fields",
		"list.read-after-write",
		"search.q-narrows-result",
		"filter.equality-selects-exactly-one",
		"sort.order-is-applied",
		"sort.multi-key-tiebreak",
		"response.status-is-documented",
		/*
		 * On an engine with double-quoted-string fallback the response *shape* is corrupted, not
		 * just its values: D1 returns the unresolved identifier as the key, quotes included, so a
		 * row comes back as `{ "\"name\"": "name" }`. The declared property is then missing and an
		 * undeclared one is present, which is a genuine schema violation rather than a knock-on
		 * mis-diagnosis. Verified against a live D1; `node:sqlite` compiles the fallback off and
		 * never reaches this shape.
		 */
		"schema.success-response-matches-document",
	],
	NUMERIC_COMPARED_AS_TEXT: [
		"filter.numeric-comparison-is-numeric",
		"sort.order-is-applied",
		"sort.reverse-symmetry",
		"sort.numeric-order-is-numeric",
		"pagination.page-walk-covers-set",
		"pagination.cursor-agrees-with-page",
	],
	COLLATION_INCONSISTENT: "pagination.cursor-agrees-with-page",
	ROLE_MONOTONICITY_BROKEN: "auth.rank-is-monotonic",
	INVITE_NEVER_GRANTS: "auth.invite-grants-then-revokes",
	REVOKE_IGNORED: "auth.invite-grants-then-revokes",
	CONCURRENT_WRITE_LOST: [
		"concurrency.no-lost-update",
		/* The defect *is* read-modify-write: PATCH reads the row, then writes every column back.
		 * That is PUT semantics wearing a PATCH label, so whenever anything else touches the row
		 * inside that window the rewrite clobbers a field the caller never named — which is
		 * precisely what the minimality check asserts against. It surfaces on a backend with real
		 * latency and hides on one without, so it is a legitimate second symptom, not a false
		 * positive. */
		"patch.minimality",
	],
	FILTER_IN_FIRST_ONLY: "filter.in-is-union-of-eq",
	FILTER_GTE_IS_GT: "filter.gte-is-gt-or-eq",
	FILTER_ILIKE_IS_LIKE: "filter.ilike-is-case-insensitive",
	FILTER_IS_NULL_MATCHES_ALL: "filter.is-null-selects-nulls",
	FILTER_ILLEGAL_OP_IGNORED: "filter.illegal-op-rejected",
	SORT_NUMERIC_AS_TEXT: "sort.numeric-order-is-numeric",
	SORT_MULTI_KEY_IGNORED: "sort.multi-key-tiebreak",
	SELECT_FIELD_MISSING: "select.requested-fields-present",
	ASYNC_NEVER_COMPLETES: "async.reaches-terminal-state",
	ASYNC_RECEIPT_MISSING_ID: [
		"async.receipt-identifies-the-job",
		"async.reaches-terminal-state",
		"schema.success-response-matches-document",
	],
}

/**
 * Defects only the SQL-backed reference can exhibit.
 *
 * The in-memory store has no physical column names, so a DDL/read naming mismatch has nowhere
 * to happen. Running it there would report a miss for something that cannot occur.
 */
export const SQL_ONLY: ReadonlySet<DefectName> = new Set<DefectName>([
	"COLUMN_NAME_MISMATCH",
	"NUMERIC_COMPARED_AS_TEXT",
	"COLLATION_INCONSISTENT",
	"CONCURRENT_WRITE_LOST",
])

export type Backend = "memory" | "sqlite" | "postgres" | "d1"

/**
 * The only defects a remote D1 can say anything an in-process engine cannot.
 *
 * Every statement against D1 is a network round trip, so a full pass costs minutes. The defects
 * worth paying that for are the ones whose behaviour comes from the *engine build* — collation,
 * type affinity, NULL ordering, LIKE escaping, identifier resolution — plus the lost-update one,
 * which only becomes realistic when a write genuinely takes time. Everything else is decided in
 * the request handler, where D1 would re-derive a result `node:sqlite` already gave for free.
 */
export const ENGINE_SENSITIVE: ReadonlySet<DefectName> = new Set<DefectName>([
	"COLLATION_INCONSISTENT",
	"COLUMN_NAME_MISMATCH",
	"CONCURRENT_WRITE_LOST",
	"LIKE_UNESCAPED",
	"NEQ_DROPS_NULLS",
	"NUMERIC_COMPARED_AS_TEXT",
	"SORT_DESC_DROPS_NULLS",
	"UNSTABLE_SORT",
])

/**
 * Defects that need cursor pagination to exist at all. A dialect that pages only by number
 * cannot exhibit them, so reporting a miss there would be reporting the absence of a feature.
 */
/**
 * Dialects that publish a cursor. Named rather than inferred, because "which defects can this
 * shape even exhibit" is a property of the fixture, and a new dialect that forgets to declare
 * itself here shows up as missed detections rather than as silent exclusions.
 */
export const DIALECTS_WITH_CURSOR: ReadonlySet<string> = new Set(["postgrest"])

/**
 * Dialects that report a total. A shape publishing no count cannot publish a wrong one, so the
 * count defects have nowhere to happen — the same reasoning that excuses cursor defects on a
 * cursorless API, and not an excuse for a check that merely failed to fire.
 */
export const DIALECTS_WITH_TOTAL: ReadonlySet<string> = new Set(["postgrest", "classic", "jsonapi"])

/**
 * Dialects whose filtering is an expression language rather than one parameter per field.
 *
 * Equality-per-field has no expression to malform, no unknown *field* distinct from an unknown
 * query parameter, and no way to write a pattern — so the defects that live inside a filter
 * grammar have nowhere to happen.
 */
export const DIALECTS_WITH_FILTER_EXPRESSION: ReadonlySet<string> = new Set([
	"postgrest",
	"classic",
	"linked",
	"jsonapi",
])

/**
 * How many checks must actually run against each shape.
 *
 * The recurring bug in this tool has been a check that cannot *express* a request looking exactly
 * like a backend that ignores one: gating on a `page` parameter against an offset-paged API, or on
 * a `filter` parameter against one that filters per field. Every instance was found by adding a
 * new dialect and noticing the number drop — which only works if someone is looking.
 *
 * These floors make it automatic. They are deliberately set at the current coverage, so any change
 * that quietly stops a check from applying fails the suite and names it, rather than waiting for a
 * sixth dialect to expose the same class again. Raising a floor when coverage genuinely improves
 * is the intended maintenance; lowering one needs a reason stated in the commit.
 */
const ALL_CHECK_IDS = CHECKS.map((check) => check.id)

export const COVERAGE_FLOOR: Record<string, number> = {
	classic: 78,
	jsonapi: 85,
	linked: 87,
	plain: 69,
	postgrest: 88,
}

/** Defects that need a filter expression language to exist at all. */
export const EXPRESSION_ONLY: ReadonlySet<DefectName> = new Set<DefectName>([
	"ERROR_500_ON_BAD_FILTER",
	/* Per-field equality has no declared filter *expression* to overclaim: an unrecognised
	 * parameter is simply ignored, which is conventional rather than a broken promise. */
	"SPEC_OVERCLAIMS_FILTERABLE",
	"FILTER_IGNORED",
	"LIKE_UNESCAPED",
	"NEQ_DROPS_NULLS",
	"NUMERIC_COMPARED_AS_TEXT",
	"FILTER_ILLEGAL_OP_IGNORED",
	"FILTER_GTE_IS_GT",
])

/**
 * Defects that need a postgrest-shaped filter writer (`in` / `ilike` / `is`). Colon and
 * equality cannot emit those operators, so injecting the lie there is a miss that names the
 * grammar rather than oat.
 */
export const POSTGREST_OP_ONLY: ReadonlySet<DefectName> = new Set<DefectName>([
	"FILTER_IN_FIRST_ONLY",
	"FILTER_ILIKE_IS_LIKE",
	"FILTER_IS_NULL_MATCHES_ALL",
])

export const DIALECTS_WITH_POSTGREST_FILTER: ReadonlySet<string> = new Set(["postgrest", "linked", "jsonapi"])

/** Defects that need a reported total to exist at all. */
export const COUNT_ONLY: ReadonlySet<DefectName> = new Set<DefectName>(["COUNT_ALWAYS_ZERO", "COUNT_IGNORES_FILTER"])

export const CURSOR_ONLY: ReadonlySet<DefectName> = new Set<DefectName>(["CURSOR_DRIFT", "COLLATION_INCONSISTENT"])

/** Whether this runtime can host the SQLite backend (`node:sqlite` needs a flag on Node 22). */
export async function sqliteAvailable(): Promise<boolean> {
	try {
		/* Constructing is the real test: on some builds the module resolves but the class is
		 * unusable, and a probe that only imports would report a false positive. */
		const { DatabaseSync } = await import("node:sqlite")
		new DatabaseSync(":memory:").close()
		return true
	} catch {
		return false
	}
}

/**
 * Whether D1 credentials are present. Deliberately not a live probe: a network call on every
 * `oat conformance` would tax the common path to answer a question about an opt-in backend.
 */
export function d1Available(): boolean {
	return (
		process.env.CLOUDFLARE_ACCOUNT_ID !== undefined &&
		process.env.CLOUDFLARE_D1_DATABASE_ID !== undefined &&
		process.env.CLOUDFLARE_API_TOKEN !== undefined
	)
}

/** Whether a Postgres server is reachable. Requires a running server, not just the driver. */
export async function postgresAvailable(): Promise<boolean> {
	try {
		const { default: postgres } = await import("postgres")
		const sql = postgres({ connect_timeout: 3, database: "postgres", max: 1, onnotice: () => {} })
		try {
			await sql`select 1`
			return true
		} finally {
			await sql.end({ timeout: 3 })
		}
	} catch {
		return false
	}
}

function primaryOf(expected: string | string[]): string {
	return Array.isArray(expected) ? (expected[0] ?? "") : expected
}

function acceptableOf(expected: string | string[]): string[] {
	return Array.isArray(expected) ? expected : [expected]
}

export const PRINCIPALS: PrincipalSpec[] = [
	{
		auth: {
			credentialFrom: "$.access_token",
			steps: [{ body: { key: "key_alpha" }, operationId: "auth.token" }],
		},
		id: "alpha",
		rank: 2,
		role: "owner",
		roots: { project_id: "proj_alpha" },
	},
	{
		auth: {
			credentialFrom: "$.access_token",
			steps: [{ body: { key: "key_beta" }, operationId: "auth.token" }],
		},
		id: "beta",
		inviteAs: "key_beta",
		rank: 2,
		role: "owner",
		roots: { project_id: "proj_beta" },
	},
	{
		auth: {
			credentialFrom: "$.access_token",
			steps: [{ body: { key: "key_alpha_member" }, operationId: "auth.token" }],
		},
		id: "alpha_member",
		rank: 1,
		role: "member",
		roots: { project_id: "proj_alpha" },
	},
	{
		auth: {
			credentialFrom: "$.access_token",
			steps: [{ body: { key: "key_alpha_viewer" }, operationId: "auth.token" }],
		},
		id: "alpha_viewer",
		rank: 0,
		role: "viewer",
		roots: { project_id: "proj_alpha" },
	},
]

export interface CaseResult {
	label: string
	defect: DefectName | null
	expected: string | null
	detected: boolean
	/** Findings unrelated to the injected defect — false positives. */
	spurious: Finding[]
	findings: Finding[]
	entitiesTested: string[]
	/** Checks that actually executed. A clean run that ran nothing is not a pass. */
	checksRun: string[]
	/** Records created and not cleaned up. */
	leaked?: number
	/** Checks this defect may legitimately trip, primary first. */
	acceptable?: string[]
	error?: string
}

async function runAgainst(
	defects: DefectName[],
	untagged = false,
	backend: Backend = "memory",
	dialect = "postgrest",
): Promise<{
	findings: Finding[]
	entitiesTested: string[]
	checksRun: string[]
	leaked: number
}> {
	/* One HTTP implementation, one store per engine — see reference/http.ts. Imported lazily so
	 * an optional runtime such as node:sqlite cannot take down paths that never touch it. */
	const { createD1Server, createMemoryServer, createPostgresServer, createSqliteServer } =
		await import("../reference/http.ts")
	const factory =
		backend === "memory"
			? createMemoryServer
			: backend === "sqlite"
				? createSqliteServer
				: backend === "d1"
					? createD1Server
					: createPostgresServer
	const server = await factory({ defects, dialect, untagged })
	try {
		const result = await run({
			baseUrl: server.url,
			principals: PRINCIPALS,
			seed: 42,
			spec: `${server.url}/v1/openapi/spec`,
		})
		return {
			checksRun: result.checksRun,
			entitiesTested: result.entitiesTested,
			findings: result.findings,
			/* Records the run created and did not remove. A tester that litters is one nobody
			 * runs twice against anything real, so this is asserted, not assumed. */
			leaked: result.created - (result.teardown?.removed ?? 0),
		}
	} finally {
		await server.close()
	}
}

export async function runSuite(
	filter?: string[],
	backend: Backend = "memory",
	dialect = "postgrest",
): Promise<CaseResult[]> {
	const results: CaseResult[] = []

	/* Baseline first — everything downstream is meaningless if this is not clean. */
	try {
		const { findings, entitiesTested, checksRun, leaked } = await runAgainst([], false, backend, dialect)
		const real = findings.filter((f) => f.verdict !== "COVERAGE_GAP")
		results.push({
			checksRun,
			leaked,
			defect: null,
			detected: real.length === 0,
			entitiesTested,
			expected: null,
			findings,
			acceptable: [],
			label: "baseline (correct backend)",
			spurious: real,
		})
	} catch (error) {
		results.push({
			checksRun: [],
			defect: null,
			detected: false,
			entitiesTested: [],
			error: error instanceof Error ? error.message : String(error),
			expected: null,
			findings: [],
			label: "baseline (correct backend)",
			spurious: [],
		})
	}

	/* The same baseline with every meta tag stripped. oat must still be quiet on a correct
	 * backend when it is running on heuristics alone — a fallback that invents findings would
	 * make the tool unusable on any spec that has not been annotated yet. */
	try {
		const { findings, entitiesTested, checksRun } = await runAgainst([], true, backend, dialect)
		const real = findings.filter((f) => f.verdict !== "COVERAGE_GAP")
		results.push({
			checksRun,
			defect: null,
			detected: real.length === 0,
			entitiesTested,
			expected: null,
			findings,
			acceptable: [],
			label: "baseline (untagged spec)",
			spurious: real,
		})
	} catch (error) {
		results.push({
			checksRun: [],
			defect: null,
			detected: false,
			entitiesTested: [],
			error: error instanceof Error ? error.message : String(error),
			expected: null,
			findings: [],
			label: "baseline (untagged spec)",
			spurious: [],
		})
	}

	const names = (Object.keys(DEFECTS) as DefectName[])
		.filter((name) => filter === undefined || filter.length === 0 || filter.includes(name))
		/* A defect the backend structurally cannot exhibit is not a miss: the in-memory store has
		 * no physical column names, so a DDL/read mismatch has nowhere to happen. */
		.filter((name) => backend !== "memory" || !SQL_ONLY.has(name))
		/* Likewise a dialect that has no cursor cannot drift one. */
		.filter((name) => DIALECTS_WITH_CURSOR.has(dialect) || !CURSOR_ONLY.has(name))
		/* Likewise a shape with no total cannot report a wrong one. */
		.filter((name) => DIALECTS_WITH_TOTAL.has(dialect) || !COUNT_ONLY.has(name))
		/* And a shape with no filter *expression* cannot malform one. */
		.filter((name) => DIALECTS_WITH_FILTER_EXPRESSION.has(dialect) || !EXPRESSION_ONLY.has(name))
		.filter((name) => DIALECTS_WITH_POSTGREST_FILTER.has(dialect) || !POSTGREST_OP_ONLY.has(name))
		/* D1 is a network round trip per statement. Restricting it to the engine-sensitive set
		 * keeps a run to minutes rather than an hour, and drops nothing D1 could uniquely show. */
		.filter((name) => backend !== "d1" || ENGINE_SENSITIVE.has(name))

	for (const defect of names) {
		const expected = EXPECTED[defect]
		try {
			const { findings, entitiesTested, checksRun } = await runAgainst([defect], false, backend, dialect)
			const reproFailures = await checkReproSyntax(findings)
			if (reproFailures.length > 0) {
				results.push({
					acceptable: acceptableOf(expected),
					checksRun,
					defect,
					detected: false,
					entitiesTested,
					error: `generated reproducer is not runnable — ${reproFailures[0]}`,
					expected: primaryOf(expected),
					findings,
					label: defect,
					spurious: [],
				})
				continue
			}
			const real = findings.filter((f) => f.verdict !== "COVERAGE_GAP")
			const acceptable = acceptableOf(expected)
			results.push({
				acceptable,
				checksRun,
				defect,
				detected: real.some((f) => f.check === primaryOf(expected)),
				entitiesTested,
				expected: primaryOf(expected),
				findings,
				label: defect,
				spurious: real.filter((f) => !acceptable.includes(f.check)),
			})
		} catch (error) {
			results.push({
				checksRun: [],
				defect,
				detected: false,
				entitiesTested: [],
				error: error instanceof Error ? error.message : String(error),
				acceptable: acceptableOf(expected),
				expected: primaryOf(expected),
				findings: [],
				label: defect,
				spurious: [],
			})
		}
	}

	return results
}

export function renderSuite(results: CaseResult[], dialect = "postgrest"): { text: string; failures: number } {
	const lines: string[] = []
	let failures = 0

	lines.push("")
	lines.push("  defect                     detected  spurious  expected check")
	lines.push("  ─────────────────────────────────────────────────────────────────────────")

	/*
	 * A baseline that reports nothing because it ran nothing is not evidence of precision — and a
	 * baseline that runs *fewer checks than this shape is known to support* is a coverage
	 * regression wearing a clean result's clothes.
	 */
	const floor = COVERAGE_FLOOR[dialect] ?? 10

	for (const result of results) {
		const isBaseline = result.defect === null
		/* Only the *tagged* baseline is held to the floor. The untagged case deliberately strips
		 * every x-* tag to prove oat degrades gracefully without them, so running fewer checks
		 * there is the result being measured, not a regression. */
		const vacuous = result.label === "baseline (correct backend)" && result.checksRun.length < floor
		const leaked = result.leaked ?? 0
		const ok = isBaseline
			? result.spurious.length === 0 &&
				!vacuous &&
				leaked === 0 &&
				/* An untagged run that finds nothing *and* runs almost nothing proves nothing. */
				result.checksRun.length >= 10
			: result.detected && result.spurious.length === 0
		if (!ok) failures++

		const mark = ok ? "✓" : "✗"
		const detected = isBaseline
			? vacuous
				? "VACUOUS"
				: result.spurious.length === 0
					? "clean"
					: "noisy"
			: result.detected
				? "yes"
				: "NO"
		const coverage = isBaseline ? `${result.checksRun.length} checks` : (result.expected ?? "—")
		lines.push(
			`  ${mark} ${result.label.padEnd(26)} ${detected.padEnd(8)} ${String(result.spurious.length).padEnd(9)} ${coverage}`,
		)

		if (leaked > 0) {
			lines.push(
				`      left ${leaked} record(s) behind after teardown — a run must not litter the ` + "system under test",
			)
		}
		if (vacuous) {
			lines.push(
				`      only ${result.checksRun.length} check(s) ran, below the ${floor} this shape ` +
					"supports — a check that stopped applying reads exactly like a clean result",
			)
			const missing = ALL_CHECK_IDS.filter((id) => !result.checksRun.includes(id))
			if (missing.length > 0) lines.push(`      did not run: ${missing.join(", ")}`)
		}
		if (result.error !== undefined) lines.push(`      error: ${result.error}`)
		for (const finding of result.spurious.slice(0, 4)) {
			lines.push(`      spurious: [${finding.check}] ${finding.summary}`)
		}
		if (!isBaseline && !result.detected && result.error === undefined) {
			const others = result.findings.filter((f) => f.verdict !== "COVERAGE_GAP")
			lines.push(`      missed — reported instead: ${others.map((f) => f.check).join(", ") || "nothing"}`)
		}
	}

	const cases = results.length
	const detectionCases = results.filter((r) => r.defect !== null)
	const detected = detectionCases.filter((r) => r.detected).length
	const baseline = results.find((r) => r.defect === null)

	lines.push("")
	lines.push(`  recall     ${detected}/${detectionCases.length} injected defects detected`)
	lines.push(
		`  precision  ${baseline?.spurious.length === 0 ? "clean baseline — no findings against a correct backend" : `${baseline?.spurious.length ?? 0} false positive(s) on the correct backend`}`,
	)
	lines.push(`  ${cases - failures}/${cases} cases passed`)
	lines.push("")

	/* Every check must be exercised by at least one defect. An unexercised check has never been
	 * shown to detect anything, so its passing tells you nothing. */
	const baselineChecks = results.find((r) => r.defect === null)?.checksRun ?? []
	const proven = new Set(results.filter((r) => r.detected).flatMap((r) => r.acceptable ?? [r.expected ?? ""]))
	const unproven = baselineChecks.filter((id) => !proven.has(id))
	if (unproven.length > 0) {
		lines.push(`  ${unproven.length} check(s) run but never proven by an injected defect:`)
		for (const id of unproven) lines.push(`    ${id}`)
		lines.push("")
	}

	return { failures, text: lines.join("\n") }
}
