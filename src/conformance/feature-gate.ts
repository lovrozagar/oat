/**
 * `x-feature-gate` is a declared fact. These cases prove a matching 403 is coverage, and that
 * the two ways to be wrong — no tag, or a tag that disagrees with `vars.feature` — stay failures.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { report } from "../report/console.ts"
import { run } from "../runtime/run.ts"
import { buildModel } from "../spec/graph.ts"
import { dereference } from "../spec/load.ts"
import type { OpenApiDocument } from "../spec/types.ts"
import type { ParserResult } from "./suite.ts"

const FORBIDDEN_SCHEMA = {
	properties: {
		error_key: { type: "string" },
		status: { type: "integer" },
		status_key: { type: "string" },
		success: { type: "boolean" },
		vars: { additionalProperties: true, type: "object" },
	},
	type: "object",
}

const WEBHOOK_ITEM = {
	properties: { id: { type: "string" }, url: { type: "string" } },
	required: ["id", "url"],
	type: "object",
}

function webhookSpec(tag: string | null): OpenApiDocument {
	const create: Record<string, unknown> = {
		operationId: "webhook.create",
		requestBody: {
			content: {
				"application/json": {
					schema: {
						additionalProperties: false,
						properties: { url: { type: "string" } },
						required: ["url"],
						type: "object",
					},
				},
			},
			required: true,
		},
		responses: {
			"201": {
				content: { "application/json": { schema: WEBHOOK_ITEM } },
				description: "created",
			},
			"403": {
				content: { "application/json": { schema: FORBIDDEN_SCHEMA } },
				description: "forbidden",
			},
		},
		"x-entity": { action: "create", identity: "id", name: "webhook" },
	}
	if (tag !== null) create["x-feature-gate"] = tag

	return {
		info: { title: "Feature-gate harness", version: "1.0" },
		openapi: "3.1.0",
		paths: {
			"/v1/orgs/{org_id}/webhooks": {
				get: {
					operationId: "webhook.list",
					parameters: [{ in: "path", name: "org_id", required: true, schema: { type: "string" } }],
					responses: {
						"200": {
							content: {
								"application/json": {
									schema: {
										properties: { webhooks: { items: WEBHOOK_ITEM, type: "array" } },
										required: ["webhooks"],
										type: "object",
									},
								},
							},
							description: "ok",
						},
					},
					"x-entity": { action: "list", identity: "id", name: "webhook" },
				},
				parameters: [{ in: "path", name: "org_id", required: true, schema: { type: "string" } }],
				post: create,
			},
			"/v1/orgs/{org_id}/webhooks/{webhook_id}": {
				get: {
					operationId: "webhook.read",
					parameters: [
						{ in: "path", name: "org_id", required: true, schema: { type: "string" } },
						{ in: "path", name: "webhook_id", required: true, schema: { type: "string" } },
					],
					responses: {
						"200": {
							content: { "application/json": { schema: WEBHOOK_ITEM } },
							description: "ok",
						},
						"404": {
							content: {
								"application/json": {
									schema: { properties: { error_key: { type: "string" } }, type: "object" },
								},
							},
							description: "not found",
						},
					},
					"x-entity": { action: "read", identity: "id", name: "webhook" },
				},
				patch: {
					operationId: "webhook.update",
					parameters: [
						{ in: "path", name: "org_id", required: true, schema: { type: "string" } },
						{ in: "path", name: "webhook_id", required: true, schema: { type: "string" } },
					],
					requestBody: {
						content: {
							"application/json": {
								schema: { additionalProperties: false, properties: { url: { type: "string" } }, type: "object" },
							},
						},
					},
					responses: {
						"200": {
							content: { "application/json": { schema: WEBHOOK_ITEM } },
							description: "ok",
						},
						"403": {
							content: { "application/json": { schema: FORBIDDEN_SCHEMA } },
							description: "forbidden",
						},
						"404": {
							content: {
								"application/json": {
									schema: { properties: { error_key: { type: "string" } }, type: "object" },
								},
							},
							description: "not found",
						},
					},
					"x-entity": { action: "update", identity: "id", name: "webhook" },
					...(tag !== null ? { "x-feature-gate": tag } : {}),
				},
			},
			"/v1/orgs/{org_id}/invites": {
				get: {
					operationId: "invite.list",
					parameters: [{ in: "path", name: "org_id", required: true, schema: { type: "string" } }],
					responses: {
						"200": {
							content: {
								"application/json": {
									schema: {
										properties: {
											invites: {
												items: {
													properties: { email: { type: "string" }, id: { type: "string" } },
													type: "object",
												},
												type: "array",
											},
										},
										required: ["invites"],
										type: "object",
									},
								},
							},
							description: "ok",
						},
					},
					"x-entity": { action: "list", identity: "id", name: "invite" },
				},
				parameters: [{ in: "path", name: "org_id", required: true, schema: { type: "string" } }],
				post: {
					operationId: "invite.create",
					requestBody: {
						content: {
							"application/json": {
								schema: {
									additionalProperties: false,
									properties: { email: { type: "string" } },
									required: ["email"],
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
									schema: {
										properties: { email: { type: "string" }, id: { type: "string" } },
										type: "object",
									},
								},
							},
							description: "created",
						},
					},
					"x-entity": { action: "create", identity: "id", name: "invite" },
				},
			},
		},
	} as OpenApiDocument
}

type CreateMode = "gate-match" | "gate-mismatch" | "plain-403" | "created"
type UpdateMode = "ok" | "gate-match"

interface HarnessOptions {
	create: CreateMode
	listSeeded?: boolean
	specTag: string | null
	update?: UpdateMode
}

function gateBody(feature: string): Record<string, unknown> {
	return {
		error_key: "forbidden",
		status: 403,
		status_key: "forbidden",
		success: false,
		vars: {
			current_plan: "free",
			feature,
			feature_name: feature === "webhooks" ? "Webhooks" : feature,
			required_plan: "pro",
			type: "feature_gate",
		},
	}
}

async function serveHarness(options: HarnessOptions): Promise<{ close: () => Promise<void>; url: string }> {
	const spec = webhookSpec(options.specTag)
	const webhooks = new Map<string, { id: string; url: string }>()
	const invites = new Map<string, { email: string; id: string }>()
	let seq = 0
	if (options.listSeeded === true) {
		webhooks.set("wh_existing", { id: "wh_existing", url: "https://example.test/hook" })
	}

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
		res.writeHead(status, { "content-length": String(Buffer.byteLength(text)), "content-type": "application/json" })
		res.end(text)
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

			if (url.pathname === "/v1/orgs/org_1/webhooks" && method === "GET") {
				return send(res, 200, { webhooks: [...webhooks.values()] })
			}
			if (url.pathname === "/v1/orgs/org_1/webhooks" && method === "POST") {
				if (options.create === "gate-match") return send(res, 403, gateBody("webhooks"))
				if (options.create === "gate-mismatch") return send(res, 403, gateBody("custom_domain"))
				if (options.create === "plain-403") return send(res, 403, { error_key: "forbidden" })
				const body = (await readJson(req)) as { url?: unknown }
				if (typeof body?.url !== "string") {
					return send(res, 400, { error_key: "required", vars: { field: "url" } })
				}
				const id = `wh_${String((seq += 1))}`
				const row = { id, url: body.url }
				webhooks.set(id, row)
				return send(res, 201, row)
			}

			const item = /^\/v1\/orgs\/org_1\/webhooks\/([^/]+)$/.exec(url.pathname)
			if (item !== null && method === "GET") {
				const row = webhooks.get(decodeURIComponent(item[1] ?? ""))
				return row === undefined ? send(res, 404, { error_key: "not_found" }) : send(res, 200, row)
			}
			if (item !== null && method === "PATCH") {
				if ((options.update ?? "ok") === "gate-match") return send(res, 403, gateBody("webhooks"))
				const row = webhooks.get(decodeURIComponent(item[1] ?? ""))
				if (row === undefined) return send(res, 404, { error_key: "not_found" })
				const body = (await readJson(req)) as { url?: unknown }
				if (typeof body?.url === "string") row.url = body.url
				return send(res, 200, row)
			}

			if (url.pathname === "/v1/orgs/org_1/invites" && method === "GET") {
				return send(res, 200, { invites: [...invites.values()] })
			}
			if (url.pathname === "/v1/orgs/org_1/invites" && method === "POST") {
				const body = (await readJson(req)) as { email?: unknown }
				if (typeof body?.email !== "string") {
					return send(res, 400, { error_key: "required", vars: { field: "email" } })
				}
				const id = `inv_${String((seq += 1))}`
				const row = { email: body.email, id }
				invites.set(id, row)
				return send(res, 201, row)
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
		url: `http://127.0.0.1:${addr.port}`,
	}
}

const PRINCIPALS = [{ headers: { authorization: "Bearer tok_alpha" }, id: "alpha", roots: { org_id: "org_1" } }]

async function against(
	options: HarnessOptions,
	only?: string[],
): Promise<{
	findings: Awaited<ReturnType<typeof run>>["findings"]
	checksSkipped: Awaited<ReturnType<typeof run>>["checksSkipped"]
}> {
	const server = await serveHarness(options)
	try {
		const result = await run({
			baseUrl: server.url,
			...(only === undefined ? {} : { only }),
			principals: PRINCIPALS,
			seed: 1,
			spec: `${server.url}/v1/openapi/spec`,
		})
		return { checksSkipped: result.checksSkipped, findings: result.findings }
	} finally {
		await server.close()
	}
}

function defects(findings: Awaited<ReturnType<typeof run>>["findings"]): typeof findings {
	return findings.filter((f) => f.verdict !== "COVERAGE_GAP" && f.verdict !== "BLOCKED")
}

export async function runFeatureGateSuite(): Promise<ParserResult[]> {
	const results: ParserResult[] = []
	const push = (name: string, why: string, ok: boolean, detail: string): void => {
		results.push({ detail, name, ok, why })
	}

	const { doc: defensive } = dereference({
		info: { title: "defensive", version: "1" },
		openapi: "3.1.0",
		paths: {
			"/v1/things": {
				post: {
					operationId: "thing.create",
					responses: { "201": { description: "ok" } },
					"x-entity": { action: "create", identity: "id", name: "thing" },
					"x-feature-gate": { not: "a string" },
				},
			},
		},
	} as OpenApiDocument)
	const defensiveModel = buildModel(defensive)
	push(
		"non-string x-feature-gate is null",
		"same defensive read as x-cost / x-rate-limit",
		defensiveModel.byOperationId.get("thing.create")?.featureGate === null,
		`featureGate=${String(defensiveModel.byOperationId.get("thing.create")?.featureGate)}`,
	)

	const tagged = buildModel(webhookSpec("webhooks"))
	const planText = report.plan(tagged, false)
	const doctor = report.doctor(tagged, [], false)
	push(
		"plan lists x-feature-gate",
		"doctor / plan should show the tag",
		planText.includes("x-feature-gate: webhooks") &&
			tagged.byOperationId.get("webhook.create")?.featureGate === "webhooks",
		planText.includes("x-feature-gate: webhooks") ? "shown" : "missing from plan",
	)
	push(
		"doctor lists x-feature-gate",
		"doctor / plan should show the tag",
		doctor.text.includes("x-feature-gate: webhooks"),
		doctor.text.includes("x-feature-gate: webhooks") ? "shown" : "missing from doctor",
	)

	try {
		const { findings } = await against({ create: "gate-match", specTag: "webhooks" }, ["webhook", "invite"])
		const seed = findings.find((f) => f.check === "world.seed" && f.entity === "webhook")
		const inviteSeed = findings.find((f) => f.check === "world.seed" && f.entity === "invite")
		const real = defects(findings)
		const namesTag = seed?.detail.includes("x-feature-gate: webhooks") === true
		push(
			"matching gate 403 is a coverage gap",
			"the backend matched the document",
			seed?.verdict === "COVERAGE_GAP" && namesTag && real.length === 0,
			`seed=${seed?.verdict ?? "none"} detail=${seed?.detail ?? "—"} defects=${real.map((f) => f.check).join(",") || "none"}`,
		)
		push(
			"untagged invite still seeds",
			"CRUD without the tag is unchanged",
			inviteSeed === undefined && real.length === 0,
			inviteSeed === undefined ? "invite has no world.seed finding" : `${inviteSeed.verdict}: ${inviteSeed.detail}`,
		)
	} catch (error) {
		push(
			"matching gate 403 is a coverage gap",
			"the backend matched the document",
			false,
			error instanceof Error ? error.message : String(error),
		)
		push("untagged invite still seeds", "CRUD without the tag is unchanged", false, "harness threw")
	}

	try {
		const { findings } = await against({ create: "gate-mismatch", specTag: "webhooks" }, ["webhook"])
		const seed = findings.find((f) => f.check === "world.seed" && f.entity === "webhook")
		push(
			"mismatched vars.feature stays a seed error",
			"backend/tag drift must not look documented",
			seed?.verdict === "BLOCKED",
			`seed=${seed?.verdict ?? "none"} ${seed?.detail ?? ""}`,
		)
	} catch (error) {
		push(
			"mismatched vars.feature stays a seed error",
			"backend/tag drift must not look documented",
			false,
			error instanceof Error ? error.message : String(error),
		)
	}

	try {
		const { findings } = await against({ create: "plain-403", specTag: null }, ["webhook"])
		const seed = findings.find((f) => f.check === "world.seed" && f.entity === "webhook")
		push(
			"untagged 403 stays a seed error",
			"do not treat every 403 as a feature gate",
			seed?.verdict === "BLOCKED",
			`seed=${seed?.verdict ?? "none"} ${seed?.detail ?? ""}`,
		)
	} catch (error) {
		push(
			"untagged 403 stays a seed error",
			"do not treat every 403 as a feature gate",
			false,
			error instanceof Error ? error.message : String(error),
		)
	}

	try {
		const { findings } = await against({ create: "created", specTag: "webhooks", update: "gate-match" }, ["webhook"])
		const seed = findings.find((f) => f.check === "world.seed" && f.entity === "webhook")
		const writeGaps = findings.filter(
			(f) => f.verdict === "COVERAGE_GAP" && f.detail.includes("x-feature-gate: webhooks") && f.check !== "world.seed",
		)
		const real = defects(findings)
		push(
			"gated update after a 201 create is a coverage gap",
			"the gate is off for create; a later write still cites the tag",
			seed === undefined && writeGaps.length > 0 && real.length === 0,
			`seed=${seed?.verdict ?? "none"} writeGaps=${writeGaps.map((f) => f.check).join(",") || "none"} defects=${real.map((f) => `${f.verdict}:${f.check}`).join(",") || "none"}`,
		)
	} catch (error) {
		push(
			"gated update after a 201 create is a coverage gap",
			"the gate is off for create; a later write still cites the tag",
			false,
			error instanceof Error ? error.message : String(error),
		)
	}

	try {
		const { findings } = await against({ create: "gate-match", listSeeded: true, specTag: "webhooks" }, ["webhook"])
		const seed = findings.find((f) => f.check === "world.seed" && f.entity === "webhook")
		const real = defects(findings)
		push(
			"gated create with existing rows is not a defect",
			"read-only checks may still run against the list, same as excluded create",
			seed?.verdict === "COVERAGE_GAP" && real.length === 0,
			`seed=${seed?.verdict ?? "none"} defects=${real.map((f) => `${f.verdict}:${f.check}`).join(",") || "none"}`,
		)
	} catch (error) {
		push(
			"gated create with existing rows is not a defect",
			"read-only checks may still run against the list, same as excluded create",
			false,
			error instanceof Error ? error.message : String(error),
		)
	}

	return results
}
