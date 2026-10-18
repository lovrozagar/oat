import { describe, expect, it } from "vitest"
import type { Handle } from "../reference/http/node.ts"
import { inProcess, type Via } from "./harness/launch.ts"
import { answer } from "./harness/serve.ts"
import { runSeedContractSuite } from "./seed-contract.ts"

/* A transport that hosts `allowed` handlers, then cannot reach anything. */
function hostsOnly(allowed: number): Via {
	let hosted = 0
	return {
		host: (handle) => {
			hosted += 1
			return hosted <= allowed ? inProcess.host(handle) : Promise.reject(new Error("no host"))
		},
		launch: () => Promise.reject(new Error("unused")),
	}
}

/* In process, with every hosted backend seen through `wrap`. */
function wrapped(wrap: (handle: Handle) => Handle): Via {
	return { ...inProcess, host: (handle) => inProcess.host(wrap(handle)) }
}

/* The paid extract no longer says it is costly, so the cheap profile has no reason to skip it. */
const uncosted = wrapped((handle) => async (request) => {
	const response = await handle(request)
	if (request.url.pathname !== "/v1/openapi/spec") return response
	return answer(200, JSON.parse(response.body.replace('"x-cost":"high",', "")))
})

/* Something in front of the backend answers register itself: the backend never sees one. */
const intercepted = wrapped(
	(handle) => async (request) =>
		request.url.pathname === "/v1/auth/register" ? answer(201, { email: "alpha@x.test", id: "u1" }) : handle(request),
)

describe("runSeedContractSuite", () => {
	it("holds the seed, cheap, invite and register contracts in process", async () => {
		const results = await runSeedContractSuite(inProcess)
		expect(results.filter((r) => !r.ok).map((r) => `${r.name}: ${r.detail}`)).toEqual([])
		expect(results.map((r) => r.name)).toEqual([
			"default: {} on a column object seeds",
			"cyclic $ref: # after deref does not throw",
			"format: email matches a conservative regex",
			"fixture strings honour minLength with pattern",
			"minLength > maxLength is a generation gap",
			"overflow names table.create, not unknown",
			"invite op is not entity.create",
			"cheap profile does not POST extract.once",
			"full profile still invokes extract.once",
			"invite-only member is not seeded with a generated email",
			"auth.registerWithEmail is not seeded",
		])
		expect(results.slice(6).map((r) => r.detail)).toEqual([
			"create=none invite=org.inviteMember",
			expect.stringMatching(/^hits=0 skip=.*x-cost: high/),
			"hits=1 posted=true",
			expect.stringMatching(/^seedJunk=false inviteAsSent=true ran=true bodies=\[/),
			"register calls=auth",
		])
	}, 180_000)

	it("reports every case it could not run under that case's name", async () => {
		const results = await runSeedContractSuite(hostsOnly(0))
		expect(results.slice(7).map((r) => [r.name, r.ok, r.detail])).toEqual([
			["cheap profile does not POST extract.once", false, "no host"],
			["invite-only member is not seeded with a generated email", false, "no host"],
			["auth.registerWithEmail is not seeded", false, "no host"],
		])
	})

	it("keeps the cheap verdict when only the full run cannot be reached", async () => {
		const results = await runSeedContractSuite(hostsOnly(1))
		expect(results.slice(7, 9).map((r) => [r.name, r.ok])).toEqual([
			["cheap profile does not POST extract.once", true],
			["cheap profile does not POST extract.once", false],
		])
	}, 180_000)

	it("fails the cheap contract when the paid operation is not marked costly", async () => {
		const results = await runSeedContractSuite(uncosted)
		const cheap = results.find((r) => r.name === "cheap profile does not POST extract.once")
		expect([cheap?.ok, cheap?.detail]).toEqual([false, expect.stringMatching(/^hits=[1-9]\d* skip=none$/)])
	}, 180_000)

	it("says no register call reached the backend when none did", async () => {
		const results = await runSeedContractSuite(intercepted)
		const register = results.find((r) => r.name === "auth.registerWithEmail is not seeded")
		expect([register?.ok, register?.detail]).toEqual([false, "register calls=none"])
	}, 180_000)
})
