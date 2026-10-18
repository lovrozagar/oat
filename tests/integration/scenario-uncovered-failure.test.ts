import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { afterEach, describe, expect, it } from "vitest"
import type { Scenario } from "../../src/config/define-config.ts"
import { run } from "../../src/runtime/run/index.ts"
import type { OpenApiDocument } from "../../src/spec/types.ts"

/*
 * A support step (arming an account, setting the scene) is not what a scenario covers, but when it
 * fails the run must still say so: a scenario that stops in silence reads as one that never ran.
 */

const closers: Array<() => Promise<void>> = []

afterEach(async () => {
	await Promise.all(closers.splice(0).map((close) => close()))
})

const ok = { "200": { content: { "application/json": { schema: { type: "object" } } }, description: "ok" } }
const spec: OpenApiDocument = {
	info: { title: "arm", version: "1" },
	openapi: "3.1.0",
	paths: {
		"/v1/arm": { post: { operationId: "arm.set", responses: ok } },
		"/v1/state": { get: { operationId: "state.get", responses: ok } },
		"/v1/redeem": { post: { operationId: "offer.redeem", responses: ok } },
	},
} as OpenApiDocument

async function serve(): Promise<string> {
	const server = createServer((req: IncomingMessage, res: ServerResponse) => {
		res.writeHead(200, { "content-type": "application/json" })
		res.end(JSON.stringify(req.url === "/openapi.json" ? spec : { armed: false }))
	})
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
	closers.push(() => new Promise((resolve) => server.close(() => resolve())))
	return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

async function runScenario(covers: string[]) {
	const url = await serve()
	const scenario: Scenario = {
		covers,
		id: "arm",
		steps: [
			{ operationId: "arm.set" },
			{ assert: { equals: "true", from: "$.armed" }, operationId: "state.get" },
			{ operationId: "offer.redeem" },
		],
	}
	return run({
		baseUrl: url,
		principals: [{ headers: {}, id: "alpha" }],
		scenarios: [scenario],
		seed: 1,
		spec: `${url}/openapi.json`,
	})
}

describe("a scenario that stops on a step it does not cover", () => {
	it("still fails that step's operation when the scenario covers nothing", async () => {
		const result = await runScenario([])
		const finding = result.findings.find((item) => item.check === "scenario.arm")
		expect(finding?.verdict).toBe("BACKEND_BUG")
		expect(finding?.operations).toContain("state.get")
		expect(finding?.summary).toContain("stopped at step 2")
	})

	it("fails that step and blocks the covered operation it never reached", async () => {
		const result = await runScenario(["offer.redeem"])
		const verdicts = result.findings
			.filter((item) => item.check === "scenario.arm")
			.map((item) => `${item.verdict} ${(item.operations ?? []).join(",")}`)
		expect(verdicts).toContain("BACKEND_BUG state.get")
		expect(verdicts).toContain("BLOCKED offer.redeem")
	})
})
