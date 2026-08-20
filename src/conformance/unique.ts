/**
 * `x-unique` is a declared fact. These cases prove a 409 duplicate is a pass, a 2xx is
 * BACKEND_BUG, and that missing / malformed tags do not invent a unique check.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { report } from "../report/console.ts"
import { run } from "../runtime/run.ts"
import { formatUniqueSets, readUnique } from "../spec/extensions.ts"
import { buildModel } from "../spec/graph.ts"
import { dereference } from "../spec/load.ts"
import type { OpenApiDocument, OperationObject } from "../spec/types.ts"
import type { ParserResult } from "./suite.ts"

const ITEM = {
	properties: { email: { type: "string" }, id: { type: "string" }, name: { type: "string" }, slug: { type: "string" } },
	required: ["id", "name"],
	type: "object",
}

const ERROR_SCHEMA = {
	properties: { error_key: { type: "string" }, status: { type: "integer" } },
	required: ["error_key"],
	type: "object",
}

const GATE_SCHEMA = {
	properties: {
		error_key: { type: "string" },
		vars: { additionalProperties: true, type: "object" },
	},
	type: "object",
}

interface SpecOptions {
	tag?: unknown
	omitTag?: boolean
	generated?: string[]
	immutable?: string[]
	idempotencyRequired?: boolean
	create409Schema?: Record<string, unknown>
	featureGate?: string
	updateBody?: string[]
}

function widgetSpec(options: SpecOptions = {}): OpenApiDocument {
	const uniqueExt = options.omitTag === true ? {} : { "x-unique": options.tag === undefined ? [["name"]] : options.tag }
	const createBodyProps: Record<string, unknown> = {
		email: { type: "string" },
		name: { type: "string", maxLength: 128 },
		slug: { type: "string" },
	}
	const updateProps: Record<string, unknown> = {}
	for (const name of options.updateBody ?? ["email", "name", "slug"]) {
		updateProps[name] = createBodyProps[name] ?? { type: "string" }
	}
	if ((options.updateBody ?? []).includes("workspace_id") || options.immutable?.includes("workspace_id")) {
		updateProps.workspace_id = { type: "string" }
	}

	const create: Record<string, unknown> = {
		operationId: "widget.create",
		parameters: [
			{ in: "path", name: "org_id", required: true, schema: { type: "string" } },
			{
				in: "header",
				name: "Idempotency-Key",
				required: options.idempotencyRequired === true,
				schema: { type: "string" },
			},
		],
		requestBody: {
			content: {
				"application/json": {
					schema: {
						additionalProperties: false,
						properties: createBodyProps,
						required: ["name"],
						type: "object",
					},
				},
			},
			required: true,
		},
		responses: {
			"201": { content: { "application/json": { schema: ITEM } }, description: "created" },
			"402": { description: "plan limit" },
			"403": { content: { "application/json": { schema: GATE_SCHEMA } }, description: "forbidden" },
			"409": {
				content: { "application/json": { schema: options.create409Schema ?? ERROR_SCHEMA } },
				description: "conflict",
			},
		},
		"x-entity": { action: "create", identity: "id", name: "widget" },
		"x-generated": options.generated ?? ["id"],
		...uniqueExt,
		...(options.featureGate === undefined ? {} : { "x-feature-gate": options.featureGate }),
	}

	return {
		info: { title: "unique harness", version: "1" },
		openapi: "3.1.0",
		paths: {
			"/v1/orgs/{org_id}/widgets": {
				get: {
					operationId: "widget.list",
					parameters: [{ in: "path", name: "org_id", required: true, schema: { type: "string" } }],
					responses: {
						"200": {
							content: {
								"application/json": {
									schema: {
										properties: { widgets: { items: ITEM, type: "array" } },
										required: ["widgets"],
										type: "object",
									},
								},
							},
							description: "ok",
						},
					},
					"x-entity": { action: "list", identity: "id", name: "widget" },
				},
				parameters: [{ in: "path", name: "org_id", required: true, schema: { type: "string" } }],
				post: create,
			},
			"/v1/orgs/{org_id}/widgets/{widget_id}": {
				delete: {
					operationId: "widget.delete",
					parameters: [
						{ in: "path", name: "org_id", required: true, schema: { type: "string" } },
						{ in: "path", name: "widget_id", required: true, schema: { type: "string" } },
					],
					responses: { "204": { description: "gone" } },
					"x-entity": { action: "delete", identity: "id", name: "widget" },
				},
				get: {
					operationId: "widget.read",
					parameters: [
						{ in: "path", name: "org_id", required: true, schema: { type: "string" } },
						{ in: "path", name: "widget_id", required: true, schema: { type: "string" } },
					],
					responses: {
						"200": { content: { "application/json": { schema: ITEM } }, description: "ok" },
						"404": { content: { "application/json": { schema: ERROR_SCHEMA } }, description: "missing" },
					},
					"x-entity": { action: "read", identity: "id", name: "widget" },
				},
				patch: {
					operationId: "widget.update",
					parameters: [
						{ in: "path", name: "org_id", required: true, schema: { type: "string" } },
						{ in: "path", name: "widget_id", required: true, schema: { type: "string" } },
					],
					requestBody: {
						content: {
							"application/json": {
								schema: { additionalProperties: false, properties: updateProps, type: "object" },
							},
						},
					},
					responses: {
						"200": { content: { "application/json": { schema: ITEM } }, description: "ok" },
						"402": { description: "plan limit" },
						"403": { content: { "application/json": { schema: GATE_SCHEMA } }, description: "forbidden" },
						"409": { content: { "application/json": { schema: ERROR_SCHEMA } }, description: "conflict" },
					},
					"x-entity": { action: "update", identity: "id", name: "widget" },
					"x-immutable": options.immutable ?? [],
					...uniqueExt,
					...(options.featureGate === undefined ? {} : { "x-feature-gate": options.featureGate }),
				},
			},
		},
	} as OpenApiDocument
}

type DuplicateMode = "409" | "201" | "per-set" | "gate-403" | "402" | "409-drift"

interface HarnessOptions {
	spec: SpecOptions
	seedConflict?: boolean
	listSeeded?: boolean
	duplicate?: DuplicateMode
	updateDuplicate?: "409" | "201" | "ok"
}

interface Row {
	email: string
	id: string
	name: string
	slug: string
}

function send(res: ServerResponse, status: number, body?: unknown): void {
	if (body === undefined) {
		res.writeHead(status)
		res.end()
		return
	}
	const text = JSON.stringify(body)
	res.writeHead(status, { "content-length": String(Buffer.byteLength(text)), "content-type": "application/json" })
	res.end(text)
}

function readJson(req: IncomingMessage): Promise<unknown> {
	return new Promise((resolve, reject) => {
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
}

function conflict(
	sets: string[][],
	existing: Row[],
	incoming: Record<string, unknown>,
	exceptId?: string,
): string[] | null {
	for (const set of sets) {
		const hit = existing.find((row) => {
			if (exceptId !== undefined && row.id === exceptId) return false
			return set.every((col) => incoming[col] !== undefined && String(row[col as keyof Row]) === String(incoming[col]))
		})
		if (hit !== undefined) return set
	}
	return null
}

function setsOf(tag: unknown): string[][] {
	const parsed = readUnique({ "x-unique": tag } as OperationObject)
	return parsed ?? []
}

async function serveHarness(options: HarnessOptions): Promise<{
	close: () => Promise<void>
	posts: Array<{ headers: Record<string, string | string[] | undefined>; body: unknown }>
	url: string
}> {
	const spec = widgetSpec(options.spec)
	const tag = options.spec.omitTag === true ? null : (options.spec.tag ?? [["name"]])
	const uniqueSets = tag === null ? [] : setsOf(tag)
	const rows = new Map<string, Row>()
	const posts: Array<{ headers: Record<string, string | string[] | undefined>; body: unknown }> = []
	let seq = 0
	if (options.listSeeded === true) {
		rows.set("w_existing", { email: "seed@example.test", id: "w_existing", name: "Existing Widget", slug: "existing" })
	}

	const server = createServer((req, res) => {
		void (async () => {
			const url = new URL(req.url ?? "/", "http://127.0.0.1")
			const method = (req.method ?? "GET").toUpperCase()
			if (url.pathname === "/v1/openapi/spec" && method === "GET") return send(res, 200, spec)

			const header = req.headers.authorization
			if (typeof header !== "string" || !header.startsWith("Bearer ")) {
				return send(res, 401, { error_key: "unauthorized" })
			}

			if (url.pathname === "/v1/orgs/org_1/widgets" && method === "GET") {
				return send(res, 200, { widgets: [...rows.values()] })
			}
			if (url.pathname === "/v1/orgs/org_1/widgets" && method === "POST") {
				const body = ((await readJson(req)) ?? {}) as Record<string, unknown>
				posts.push({ body, headers: { ...req.headers } })
				if (options.seedConflict === true && posts.length === 1) {
					return send(res, 409, { error_key: "conflict", status: 409 })
				}
				const colliding = conflict(uniqueSets, [...rows.values()], body)
				if (colliding !== null) {
					const mode = options.duplicate ?? "409"
					if (mode === "gate-403") {
						return send(res, 403, {
							error_key: "forbidden",
							vars: { feature: options.spec.featureGate ?? "widgets", type: "feature_gate" },
						})
					}
					if (mode === "402") return send(res, 402, { error_key: "payment_required" })
					if (mode === "409-drift") return send(res, 409, { oops: true })
					if (mode === "201") {
						/* fall through and insert */
					} else if (mode === "per-set") {
						if (colliding.includes("name") || colliding.includes("email")) {
							return send(res, 409, { error_key: "conflict", status: 409 })
						}
					} else {
						return send(res, 409, { error_key: "conflict", status: 409 })
					}
				}
				const id = `w_${String((seq += 1))}`
				const row: Row = {
					email: typeof body.email === "string" ? body.email : `${id}@example.test`,
					id,
					name: typeof body.name === "string" ? body.name : id,
					slug: typeof body.slug === "string" ? body.slug : id,
				}
				rows.set(id, row)
				return send(res, 201, row)
			}

			const item = /^\/v1\/orgs\/org_1\/widgets\/([^/]+)$/.exec(url.pathname)
			if (item !== null && method === "GET") {
				const row = rows.get(decodeURIComponent(item[1] ?? ""))
				return row === undefined ? send(res, 404, { error_key: "not_found" }) : send(res, 200, row)
			}
			if (item !== null && method === "PATCH") {
				const id = decodeURIComponent(item[1] ?? "")
				const row = rows.get(id)
				if (row === undefined) return send(res, 404, { error_key: "not_found" })
				const body = ((await readJson(req)) ?? {}) as Record<string, unknown>
				posts.push({ body, headers: { ...req.headers } })
				const next = { ...row, ...body }
				const colliding = conflict(uniqueSets, [...rows.values()], next, id)
				const mode = options.updateDuplicate ?? "409"
				if (colliding !== null) {
					if (mode === "409") return send(res, 409, { error_key: "conflict", status: 409 })
					if (mode === "201") {
						/* accept */
					}
				}
				if (typeof body.email === "string") row.email = body.email
				if (typeof body.name === "string") row.name = body.name
				if (typeof body.slug === "string") row.slug = body.slug
				return send(res, 200, row)
			}
			if (item !== null && method === "DELETE") {
				rows.delete(decodeURIComponent(item[1] ?? ""))
				return send(res, 204)
			}
			return send(res, 404, { error_key: "not_found" })
		})().catch(() => {
			if (!res.headersSent) send(res, 500, { error_key: "internal" })
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
		posts,
		url: `http://127.0.0.1:${addr.port}`,
	}
}

const PRINCIPALS = [{ headers: { authorization: "Bearer tok_alpha" }, id: "alpha", roots: { org_id: "org_1" } }]

async function against(options: HarnessOptions): Promise<{
	result: Awaited<ReturnType<typeof run>>
	posts: Array<{ headers: Record<string, string | string[] | undefined>; body: unknown }>
}> {
	const server = await serveHarness(options)
	try {
		const result = await run({
			baseUrl: server.url,
			only: ["widget"],
			principals: PRINCIPALS,
			seed: 1,
			spec: `${server.url}/v1/openapi/spec`,
		})
		return { posts: server.posts, result }
	} finally {
		await server.close()
	}
}

function defects(findings: Awaited<ReturnType<typeof run>>["findings"]) {
	return findings.filter((f) => f.verdict !== "COVERAGE_GAP" && f.verdict !== "BLOCKED")
}

export async function runUniqueSuite(): Promise<ParserResult[]> {
	const results: ParserResult[] = []
	const push = (name: string, why: string, ok: boolean, detail: string): void => {
		results.push({ detail, name, ok, why })
	}

	const shapes: Array<[string, unknown]> = [
		["list of sets", [["email"], ["workspace_id", "slug"]]],
		["column objects", [{ columns: ["email"] }, { columns: ["workspace_id", "slug"] }]],
		["single string[]", ["email"]],
	]
	const expectedList = [
		readUnique({ "x-unique": [["email"], ["workspace_id", "slug"]] } as OperationObject),
		readUnique({ "x-unique": [{ columns: ["email"] }, { columns: ["workspace_id", "slug"] }] } as OperationObject),
		readUnique({ "x-unique": ["email"] } as OperationObject),
	]
	push(
		"accepted x-unique shapes parse to column sets",
		"list of sets, {columns}, and a single string[] are the documented forms",
		JSON.stringify(expectedList[0]) === JSON.stringify([["email"], ["workspace_id", "slug"]]) &&
			JSON.stringify(expectedList[1]) === JSON.stringify([["email"], ["workspace_id", "slug"]]) &&
			JSON.stringify(expectedList[2]) === JSON.stringify([["email"]]),
		shapes.map(([name], i) => `${name}=${JSON.stringify(expectedList[i])}`).join("; "),
	)
	push(
		"empty sets are dropped",
		"[[]] after filtering is explicit none",
		JSON.stringify(readUnique({ "x-unique": [[], []] } as OperationObject)) === "[]",
		JSON.stringify(readUnique({ "x-unique": [[], []] } as OperationObject)),
	)

	const { doc: malformed } = dereference({
		info: { title: "malformed", version: "1" },
		openapi: "3.1.0",
		paths: {
			"/v1/things": {
				post: {
					operationId: "thing.create",
					responses: { "201": { description: "ok" } },
					"x-entity": { action: "create", identity: "id", name: "thing" },
					"x-unique": { not: "an array" },
				},
			},
		},
	} as OpenApiDocument)
	const malformedModel = buildModel(malformed)
	const uniqueGap = malformedModel.gaps.gaps.some((gap) => gap.tag === "x-unique")
	push(
		"malformed x-unique is absent plus a doctor gap",
		"non-array is not a guess",
		malformedModel.byOperationId.get("thing.create")?.unique === null && uniqueGap,
		`unique=${String(malformedModel.byOperationId.get("thing.create")?.unique)} gap=${String(uniqueGap)}`,
	)

	const tagged = buildModel(widgetSpec({ tag: [["name"], ["email"]] }))
	const planText = report.plan(tagged, false)
	const doctor = report.doctor(tagged, [], false)
	push(
		"plan lists x-unique",
		"doctor / plan should show the effective sets",
		planText.includes("x-unique:") && planText.includes("[name]") && tagged.entities.get("widget")?.unique !== null,
		planText.includes("x-unique:")
			? formatUniqueSets(tagged.entities.get("widget")?.unique ?? null)
			: "missing from plan",
	)
	push(
		"doctor lists x-unique",
		"doctor / plan should show the effective sets",
		doctor.text.includes("x-unique:") && doctor.text.includes("[name]"),
		doctor.text.includes("x-unique:") ? "shown" : "missing from doctor",
	)

	const empty = buildModel(widgetSpec({ tag: [] }))
	push(
		"[] after filter does not run unique checks",
		"explicit none",
		JSON.stringify(empty.byOperationId.get("widget.create")?.unique) === "[]",
		JSON.stringify(empty.byOperationId.get("widget.create")?.unique),
	)

	try {
		const { result } = await against({ spec: { omitTag: true } })
		const ran = result.checksRun.includes("create.unique-conflict-rejected")
		push(
			"missing tag does not run unique checks",
			"do not infer uniqueness",
			!ran,
			ran ? "create.unique-conflict-rejected ran" : "absent from checksRun",
		)
	} catch (error) {
		push(
			"missing tag does not run unique checks",
			"do not infer uniqueness",
			false,
			error instanceof Error ? error.message : String(error),
		)
	}

	try {
		const { result } = await against({ duplicate: "409", spec: {}, updateDuplicate: "409" })
		const uniqueBug = defects(result.findings).filter((f) => f.check === "create.unique-conflict-rejected")
		const ran = result.checksRun.includes("create.unique-conflict-rejected")
		push(
			"409 duplicate create is not BACKEND_BUG",
			"the backend matched the document",
			ran && uniqueBug.length === 0,
			`ran=${String(ran)} bugs=${uniqueBug.map((f) => f.verdict).join(",") || "none"}`,
		)
	} catch (error) {
		push(
			"409 duplicate create is not BACKEND_BUG",
			"the backend matched the document",
			false,
			error instanceof Error ? error.message : String(error),
		)
	}

	try {
		const { result } = await against({ duplicate: "201", spec: {}, updateDuplicate: "ok" })
		const hit = result.findings.find(
			(f) => f.check === "create.unique-conflict-rejected" && f.verdict === "BACKEND_BUG",
		)
		push(
			"201 duplicate create is BACKEND_BUG",
			"a unique constraint that inserts is a backend bug",
			hit !== undefined,
			hit === undefined ? result.findings.map((f) => `${f.verdict}:${f.check}`).join(",") || "no finding" : hit.detail,
		)
	} catch (error) {
		push(
			"201 duplicate create is BACKEND_BUG",
			"a unique constraint that inserts is a backend bug",
			false,
			error instanceof Error ? error.message : String(error),
		)
	}

	try {
		const { result } = await against({ duplicate: "409", spec: {} })
		const grew = result.findings.some(
			(f) => f.check === "create.unique-conflict-rejected" && f.summary.includes("grew"),
		)
		push(
			"list does not grow on 409",
			"cardinality is part of the unique pass",
			!grew,
			grew ? "cardinality finding" : "no growth finding",
		)
	} catch (error) {
		push(
			"list does not grow on 409",
			"cardinality is part of the unique pass",
			false,
			error instanceof Error ? error.message : String(error),
		)
	}

	try {
		const { result } = await against({
			duplicate: "per-set",
			spec: { tag: [["name"], ["slug"]] },
			updateDuplicate: "ok",
		})
		const hit = result.findings.find(
			(f) => f.check === "create.unique-conflict-rejected" && f.verdict === "BACKEND_BUG",
		)
		push(
			"one 2xx set fails the check (not OR'd)",
			"probe each set separately",
			hit !== undefined,
			hit === undefined ? "no BACKEND_BUG" : hit.detail,
		)
	} catch (error) {
		push(
			"one 2xx set fails the check (not OR'd)",
			"probe each set separately",
			false,
			error instanceof Error ? error.message : String(error),
		)
	}

	try {
		const { result } = await against({
			spec: { generated: ["id"], omitTag: false, tag: [["id"]] },
		})
		const ran = result.checksRun.includes("create.unique-conflict-rejected")
		push(
			"generated-only unique set is skipped",
			"a set with no body columns is not a fail",
			!ran,
			ran ? "ran" : "skipped",
		)
	} catch (error) {
		push(
			"generated-only unique set is skipped",
			"a set with no body columns is not a fail",
			false,
			error instanceof Error ? error.message : String(error),
		)
	}

	try {
		const { result } = await against({
			spec: {
				generated: ["id", "workspace_id"],
				immutable: ["workspace_id"],
				tag: [["workspace_id"]],
				updateBody: ["workspace_id", "name"],
			},
			updateDuplicate: "ok",
		})
		const ran = result.checksRun.includes("update.unique-conflict-rejected")
		push(
			"all-x-immutable update set is skipped",
			"immutable unique columns are not a unique PATCH probe",
			!ran,
			ran ? "ran" : "skipped",
		)
	} catch (error) {
		push(
			"all-x-immutable update set is skipped",
			"immutable unique columns are not a unique PATCH probe",
			false,
			error instanceof Error ? error.message : String(error),
		)
	}

	try {
		const { result } = await against({ duplicate: "409", spec: {}, updateDuplicate: "409" })
		const bug = result.findings.find(
			(f) => f.check === "update.unique-conflict-rejected" && f.verdict === "BACKEND_BUG",
		)
		const ran = result.checksRun.includes("update.unique-conflict-rejected")
		push(
			"colliding PATCH 409 passes",
			"same scoring as create",
			ran && bug === undefined,
			`ran=${String(ran)} bug=${bug?.detail ?? "none"}`,
		)
	} catch (error) {
		push(
			"colliding PATCH 409 passes",
			"same scoring as create",
			false,
			error instanceof Error ? error.message : String(error),
		)
	}

	try {
		const { result } = await against({ duplicate: "409", spec: {}, updateDuplicate: "201" })
		const hit = result.findings.find(
			(f) => f.check === "update.unique-conflict-rejected" && f.verdict === "BACKEND_BUG",
		)
		push(
			"colliding PATCH 2xx is BACKEND_BUG",
			"update unique is the same class as create",
			hit !== undefined,
			hit === undefined ? "no finding" : hit.detail,
		)
	} catch (error) {
		push(
			"colliding PATCH 2xx is BACKEND_BUG",
			"update unique is the same class as create",
			false,
			error instanceof Error ? error.message : String(error),
		)
	}

	try {
		const { result, posts } = await against({ duplicate: "409", spec: { idempotencyRequired: true } })
		const uniquePosts = posts.filter((_, i) => i > 0)
		const reused = uniquePosts.some((post) => {
			const value = post.headers["idempotency-key"]
			const first = posts[0]?.headers["idempotency-key"]
			return typeof value === "string" && typeof first === "string" && value === first && value !== ""
		})
		const ran = result.checksRun.includes("create.unique-conflict-rejected")
		push(
			"unique probe does not reuse Idempotency-Key",
			"omit or send a fresh key",
			ran && !reused,
			reused ? "reused seed key" : "fresh or omitted",
		)
	} catch (error) {
		push(
			"unique probe does not reuse Idempotency-Key",
			"omit or send a fresh key",
			false,
			error instanceof Error ? error.message : String(error),
		)
	}

	try {
		const { result } = await against({
			duplicate: "409-drift",
			spec: {},
			updateDuplicate: "ok",
		})
		const drift = result.findings.find((f) => f.check === "schema.error-response-matches-document")
		push(
			"409 schema drift still reports",
			"coverage is not a free pass for an undeclared body",
			drift !== undefined,
			drift === undefined ? result.findings.map((f) => f.check).join(",") || "none" : drift.verdict,
		)
	} catch (error) {
		push(
			"409 schema drift still reports",
			"coverage is not a free pass for an undeclared body",
			false,
			error instanceof Error ? error.message : String(error),
		)
	}

	try {
		const { result } = await against({
			duplicate: "gate-403",
			spec: { featureGate: "widgets" },
			updateDuplicate: "ok",
		})
		const uniqueBug = result.findings.find(
			(f) => f.check === "create.unique-conflict-rejected" && f.verdict === "BACKEND_BUG",
		)
		const gap = result.findings.find(
			(f) => f.check === "create.unique-conflict-rejected" && f.verdict === "COVERAGE_GAP",
		)
		push(
			"feature-gate 403 on the probe is coverage, not a unique pass",
			"do not score a documented 403 as 409",
			uniqueBug === undefined && gap !== undefined,
			`bug=${uniqueBug?.verdict ?? "none"} gap=${gap?.verdict ?? "none"}`,
		)
	} catch (error) {
		push(
			"feature-gate 403 on the probe is coverage, not a unique pass",
			"do not score a documented 403 as 409",
			false,
			error instanceof Error ? error.message : String(error),
		)
	}

	try {
		const { result } = await against({ duplicate: "402", spec: {}, updateDuplicate: "ok" })
		const uniqueBug = result.findings.find(
			(f) => f.check === "create.unique-conflict-rejected" && f.verdict === "BACKEND_BUG",
		)
		const gap = result.findings.find(
			(f) => f.check === "create.unique-conflict-rejected" && f.verdict === "COVERAGE_GAP",
		)
		push(
			"402 on the probe is coverage, not a unique pass",
			"plan limit is not a unique 409",
			uniqueBug === undefined && gap !== undefined,
			`bug=${uniqueBug?.verdict ?? "none"} gap=${gap?.verdict ?? "none"}`,
		)
	} catch (error) {
		push(
			"402 on the probe is coverage, not a unique pass",
			"plan limit is not a unique 409",
			false,
			error instanceof Error ? error.message : String(error),
		)
	}

	try {
		const { result } = await against({
			duplicate: "409",
			listSeeded: true,
			seedConflict: true,
			spec: {},
			updateDuplicate: "ok",
		})
		const seed = result.findings.find((f) => f.check === "world.seed" && f.entity === "widget")
		const blocked = seed?.verdict === "BLOCKED"
		const namesTag = seed?.detail.includes("x-unique") === true
		const ran = result.checksRun.includes("create.unique-conflict-rejected")
		const uniquePassAsSeed = result.findings.some(
			(f) => f.check === "create.unique-conflict-rejected" && f.verdict !== "BACKEND_BUG" && f.evidence.length === 0,
		)
		push(
			"tagged seed 409 + nonempty list adopts",
			"world.seed is COVERAGE_GAP naming x-unique, not BLOCKED",
			seed?.verdict === "COVERAGE_GAP" && namesTag && !blocked,
			`seed=${seed?.verdict ?? "none"} ${seed?.detail ?? ""}`,
		)
		push(
			"unique check still runs after unique-409 adopt",
			"do not stand unique probes down with write-path skips",
			ran,
			ran ? "ran" : `checksRun=${result.checksRun.join(",")}`,
		)
		push(
			"seed 409 is not the unique check passing",
			"that check is the explicit second POST",
			!uniquePassAsSeed,
			uniquePassAsSeed ? "scored seed as unique pass" : "seed is not unique-check evidence",
		)
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error)
		push(
			"tagged seed 409 + nonempty list adopts",
			"world.seed is COVERAGE_GAP naming x-unique, not BLOCKED",
			false,
			msg,
		)
		push(
			"unique check still runs after unique-409 adopt",
			"do not stand unique probes down with write-path skips",
			false,
			msg,
		)
		push("seed 409 is not the unique check passing", "that check is the explicit second POST", false, msg)
	}

	try {
		const { result } = await against({ seedConflict: true, spec: {} })
		const seed = result.findings.find((f) => f.check === "world.seed" && f.entity === "widget")
		push(
			"tagged seed 409 + empty list is BLOCKED",
			"could not seed",
			seed?.verdict === "BLOCKED",
			`seed=${seed?.verdict ?? "none"} ${seed?.detail ?? ""}`,
		)
	} catch (error) {
		push(
			"tagged seed 409 + empty list is BLOCKED",
			"could not seed",
			false,
			error instanceof Error ? error.message : String(error),
		)
	}

	try {
		const { result } = await against({ seedConflict: true, spec: { omitTag: true } })
		const seed = result.findings.find((f) => f.check === "world.seed" && f.entity === "widget")
		push(
			"untagged seed 409 is still a seed failure",
			"do not treat every 409 as unique",
			seed?.verdict === "BLOCKED",
			`seed=${seed?.verdict ?? "none"} ${seed?.detail ?? ""}`,
		)
		const untaggedAdopts = seed?.verdict === "COVERAGE_GAP" && seed.detail.includes("x-unique")
		push(
			"untagged 409 does not adopt as x-unique",
			"no tag, no unique adopt",
			!untaggedAdopts,
			untaggedAdopts ? "adopted without a tag" : "not unique-adopt",
		)
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error)
		push("untagged seed 409 is still a seed failure", "do not treat every 409 as unique", false, msg)
		push("untagged 409 does not adopt as x-unique", "no tag, no unique adopt", false, msg)
	}

	try {
		const { result } = await against({ duplicate: "409", spec: {} })
		const uniqueBug = defects(result.findings).filter(
			(f) => f.check.startsWith("create.unique") || f.check.startsWith("update.unique"),
		)
		push(
			"409 duplicate and 201 distinct passes",
			"the cohort still inserts distinct unique values",
			uniqueBug.length === 0 && result.entitiesTested.includes("widget"),
			`bugs=${uniqueBug.map((f) => f.check).join(",") || "none"} entities=${result.entitiesTested.join(",")}`,
		)
	} catch (error) {
		push(
			"409 duplicate and 201 distinct passes",
			"the cohort still inserts distinct unique values",
			false,
			error instanceof Error ? error.message : String(error),
		)
	}

	try {
		const { result } = await against({ spec: { tag: [] } })
		const ran =
			result.checksRun.includes("create.unique-conflict-rejected") ||
			result.checksRun.includes("update.unique-conflict-rejected")
		push("explicit empty x-unique does not run the check", "[] after filter is none", !ran, ran ? "ran" : "absent")
	} catch (error) {
		push(
			"explicit empty x-unique does not run the check",
			"[] after filter is none",
			false,
			error instanceof Error ? error.message : String(error),
		)
	}

	const missingDoctor = report.doctor(buildModel(widgetSpec({ omitTag: true })), [], false)
	push(
		"doctor says unique checks do not run without the tag",
		"TAG_UNLOCKS names the locked checks",
		missingDoctor.text.includes("x-unique") && missingDoctor.text.includes("create.unique-conflict-rejected"),
		missingDoctor.text.includes("x-unique") ? "named" : "missing from doctor",
	)

	return results
}
