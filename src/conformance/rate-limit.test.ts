import { describe, expect, it } from "vitest"
import { inProcess, type Via } from "./harness/launch.ts"
import { answer } from "./harness/serve.ts"
import { runRateLimitSuite } from "./rate-limit.ts"

describe("runRateLimitSuite", () => {
	it("retries a first 429 and adopts an existing table past a 402", async () => {
		const results = await runRateLimitSuite(inProcess)
		expect(results.filter((r) => !r.ok).map((r) => `${r.name}: ${r.detail}`)).toEqual([])
		expect(results.map((r) => r.detail)).toEqual([
			"delta=1000 cap=30000",
			"ok",
			"status=201 seq=429,201",
			"blocked=0 entities=thing",
			"blocked=false invented=false backend402=false tested=row,table",
		])
	}, 120_000)

	it("reports each backend it could not reach once, under its first case", async () => {
		const nowhere: Via = { ...inProcess, host: () => Promise.reject(new Error("no host")) }
		const results = await runRateLimitSuite(nowhere)
		expect(results.slice(2).map((r) => [r.name, r.ok, r.detail])).toEqual([
			["Client.request retries a 429 with Retry-After and returns 201", false, "no host"],
			["row seeds after table.create 402 when a same-tenant table already exists", false, "no host"],
		])
	})

	it("fails each case when every create is refused", async () => {
		const refusing: Via = {
			...inProcess,
			host: (handle) => inProcess.host(async (request) => (request.method === "POST" ? answer(500) : handle(request))),
		}
		const results = await runRateLimitSuite(refusing)
		expect(results.slice(2).map((r) => [r.ok, r.detail])).toEqual([
			[false, "status=500 seq=500"],
			[false, "blocked=1 entities="],
			[false, "blocked=true invented=false backend402=false tested=table"],
		])
	}, 120_000)
})
