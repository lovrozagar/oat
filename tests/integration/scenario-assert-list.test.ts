import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { afterEach, describe, expect, it } from "vitest"
import type { Scenario, ScenarioAssert } from "../../src/config/define/types.ts"
import { run } from "../../src/runtime/run/index.ts"
import type { OpenApiDocument } from "../../src/spec/types.ts"

/*
 * One response often has to show several things at once (a file with its format, its owner and
 * no secrets); a step that can be read only a few times must check them all on one exchange.
 */

const closers: Array<() => Promise<void>> = []

afterEach(async () => {
	await Promise.all(closers.splice(0).map((close) => close()))
})

const ok = { "200": { content: { "application/json": { schema: { type: "object" } } }, description: "ok" } }
const spec = {
	info: { title: "file", version: "1" },
	openapi: "3.1.0",
	paths: {
		"/v1/request": { post: { operationId: "file.request", responses: ok } },
		"/v1/file": { get: { operationId: "file.download", responses: ok } },
	},
} as unknown as OpenApiDocument

async function serve(): Promise<string> {
	const server = createServer((req: IncomingMessage, res: ServerResponse) => {
		res.writeHead(200, {
			"content-disposition": "attachment; filename=export.json",
			"content-type": "application/json",
		})
		res.end(JSON.stringify(req.url === "/openapi.json" ? spec : { format: "export.v1", owner: "a@x.test" }))
	})
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
	closers.push(() => new Promise((resolve) => server.close(() => resolve())))
	return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

async function runWith(assert: ScenarioAssert[]) {
	const url = await serve()
	const scenario: Scenario = {
		covers: ["file.request", "file.download"],
		id: "file",
		steps: [{ operationId: "file.request" }, { assert, operationId: "file.download" }],
	}
	const result = await run({
		baseUrl: url,
		ops: ["file.request", "file.download"],
		principals: { alpha: {} },
		scenarios: [scenario],
		seed: 1,
		spec: `${url}/openapi.json`,
	})
	return (id: string) => result.scope.operations.find((op) => op.operationId === id)
}

describe("a list of asserts on one step", () => {
	it("passes when every one holds on the same exchange, and each one's observes count", async () => {
		const row = await runWith([
			{ contains: "attachment;", from: "header:content-disposition" },
			{ equals: "export.v1", from: "$.format", observes: ["file.request"] },
			{ from: "$", omits: '"token":' },
		])
		expect(row("file.download")?.status).toBe("passed")
		expect(row("file.request")?.tier).toBe("verified")
	})

	it("fails when any one does not hold", async () => {
		const row = await runWith([
			{ equals: "export.v1", from: "$.format" },
			{ equals: "b@x.test", from: "$.owner" },
		])
		expect(row("file.download")?.status).toBe("failed")
	})
})
