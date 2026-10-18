import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { afterEach, describe, expect, it } from "vitest"
import { Client } from "../../src/client/client.ts"
import { confirmDeletes } from "../../src/runtime/contract.ts"
import { FindingCollector } from "../../src/runtime/finding.ts"
import { GradeLedger } from "../../src/runtime/scope.ts"
import { buildModel } from "../../src/spec/graph/build.ts"
import { dereference } from "../../src/spec/load/dereference.ts"
import type { OpenApiDocument } from "../../src/spec/types.ts"
import { Redactor } from "../../src/security/redact.ts"

/*
 * A delete of a whole collection (forget every trusted device) has no item to read back. The read
 * on its path is the list, and the list it leaves empty is the proof. A list that still holds
 * rows after it is the defect.
 */

const closers: Array<() => Promise<void>> = []

afterEach(async () => {
	await Promise.all(closers.splice(0).map((close) => close()))
})

const device = { properties: { id: { type: "string" } }, required: ["id"], type: "object" }

const spec: OpenApiDocument = {
	info: { title: "collection-delete", version: "1" },
	openapi: "3.1.0",
	paths: {
		"/v1/devices": {
			delete: {
				operationId: "devices.forgetAll",
				responses: { "200": { description: "forgotten" } },
			},
			get: {
				operationId: "devices.list",
				responses: {
					"200": {
						content: {
							"application/json": {
								schema: {
									properties: { devices: { items: device, type: "array" } },
									required: ["devices"],
									type: "object",
								},
							},
						},
						description: "ok",
					},
				},
			},
		},
	},
} as OpenApiDocument

async function confirm(keeps: boolean) {
	const devices = [{ id: "d1" }, { id: "d2" }]
	const server = createServer((req, res) => {
		if (req.method === "DELETE" && !keeps) devices.splice(0)
		res.writeHead(200, { "content-type": "application/json" })
		res.end(JSON.stringify(req.method === "DELETE" ? { forgotten: 2 } : { devices }))
	})
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
	closers.push(() => new Promise((resolve) => server.close(() => resolve())))
	const model = buildModel(dereference(spec).doc)
	const client = new Client({
		baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
		redactor: new Redactor(),
	})
	await client.request("DELETE", "/v1/devices", { operationId: "devices.forgetAll" })
	const findings = new FindingCollector()
	const grades = new GradeLedger()
	await confirmDeletes({
		auth: () => ({}),
		client,
		findings,
		grades,
		inScope: () => true,
		mode: "full",
		model,
		stopped: () => false,
	})
	return { evidence: grades.evidence.get("devices.forgetAll"), findings: findings.findings }
}

describe("confirming a delete of a whole collection", () => {
	it("is proven by the empty list it leaves", async () => {
		const { evidence, findings } = await confirm(false)
		expect(findings).toEqual([])
		expect(evidence?.observation).toBeDefined()
	})

	it("is a defect when the list still holds rows", async () => {
		const { findings } = await confirm(true)
		expect(findings.map((finding) => finding.check)).toEqual(["delete.absent-record-returns-404"])
	})
})
