import { afterEach, describe, expect, it } from "vitest"
import { judgeDefect } from "../../src/conformance/matrix/cases.ts"
import { PRINCIPALS, SECURITY } from "../../src/conformance/matrix/principals.ts"
import { createMemoryServer } from "../../src/reference/http/engines.ts"
import { run } from "../../src/runtime/run/index.ts"
import { listening } from "../../src/conformance/harness/launch.ts"
import {
	type Served,
	serveBoolean,
	serveCreateFirst,
	serveEnumAndBoolean,
	serveHandleQuery,
	serveNested,
	serveProfile,
	serveTwoReads,
} from "../support/self-identity-fixtures.ts"

const DEFECT_VERDICTS = new Set(["BACKEND_BUG", "SECURITY", "SPEC_BUG"])

let open: Array<{ close: () => Promise<void> }> = []
afterEach(async () => {
	for (const server of open) await server.close()
	open = []
})

/* Registers a started server for teardown and returns its base url. */
async function track(started: Served | Promise<Served>): Promise<string> {
	const served = await started
	open.push(served)
	return served.url
}

async function runProfile(baseUrl: string) {
	return run({
		baseUrl,
		principals: { alpha: {} },
		security: { bearer: { static: "alpha" } },
		seed: 1,
		spec: `${baseUrl}/openapi.json`,
	})
}

type ProfileResult = Awaited<ReturnType<typeof runProfile>>

function defectsOf(result: ProfileResult) {
	return result.findings.filter((finding) => DEFECT_VERDICTS.has(finding.verdict))
}

function statusOf(result: ProfileResult, operationId: string) {
	return result.scope.operations.find((op) => op.operationId === operationId)?.status
}

async function readsUpdatesAndRefuses() {
	const result = await runProfile(await track(serveProfile("hold")))
	expect(defectsOf(result)).toEqual([])
	expect(result.entitiesTested).toEqual(["profile"])
	const read = result.scope.operations.find((op) => op.operationId === "profile.read")
	const update = result.scope.operations.find((op) => op.operationId === "profile.update")
	expect(read?.status).toBe("passed")
	expect(update?.status).toBe("passed")
	expect(read?.checks.passed).toContain("auth.self-is-the-caller")
	const anonymous = result.client.transcript.find((exchange) => exchange.status === 401)
	expect(anonymous?.requestHeaders["authorization"]).toBeUndefined()
	const patched = result.client.transcript.find((exchange) => exchange.method === "PATCH")
	expect(patched?.requestBody).toEqual({ first_name: "Oat" })
}

async function reportsOpenCallerRoute() {
	const result = await runProfile(await track(serveProfile("open")))
	expect(defectsOf(result).map((finding) => finding.check)).toContain("auth.self-is-the-caller")
	expect(statusOf(result, "profile.read")).toBe("failed")
}

async function reportsForgottenUpdate() {
	const result = await runProfile(await track(serveProfile("forget")))
	expect(defectsOf(result).map((finding) => finding.summary)).toContain("an update to the caller did not stick")
	expect(statusOf(result, "profile.update")).toBe("failed")
}

async function throttledReadIsNoLostUpdate() {
	const result = await runProfile(await track(serveProfile("throttle")))
	expect(defectsOf(result).map((finding) => finding.summary)).not.toContain("an update to the caller did not stick")
	expect(statusOf(result, "profile.update")).not.toBe("failed")
}

async function flipsBooleanOnlyField() {
	const result = await runProfile(await track(serveBoolean()))
	expect(defectsOf(result)).toEqual([])
	const patches = result.client.transcript.filter((exchange) => exchange.method === "PATCH")
	expect(patches.map((exchange) => exchange.requestBody)).toEqual([{ dismissed: true }, { dismissed: false }])
	const reads = result.client.transcript.filter((exchange) => exchange.method === "GET" && exchange.status === 200)
	expect(
		reads.some(
			(exchange) =>
				exchange.responseBody !== null && (exchange.responseBody as { dismissed?: boolean }).dismissed === true,
		),
	).toBe(true)
}

async function flipsBooleanBesideEnum() {
	const result = await runProfile(await track(serveEnumAndBoolean()))
	expect(defectsOf(result)).toEqual([])
	const patches = result.client.transcript.filter((exchange) => exchange.method === "PATCH")
	expect(patches[0]?.requestBody).toEqual({ dismissed: true })
}

async function createsCallerBeforeRead() {
	const result = await runProfile(await track(serveCreateFirst()))
	expect(defectsOf(result)).toEqual([])
	for (const id of ["profile.create", "profile.read", "profile.update"]) {
		expect(statusOf(result, id)).toBe("passed")
	}
	const post = result.client.transcript.find((exchange) => exchange.method === "POST" && exchange.status === 201)
	const sent = (post?.requestBody as { display_name?: unknown } | undefined)?.display_name
	const firstRead = result.client.transcript.find((exchange) => exchange.method === "GET" && exchange.status === 200)
	expect(sent).toEqual(expect.any(String))
	expect((firstRead?.responseBody as { display_name?: unknown } | undefined)?.display_name).toBe(sent)
	const postAt = result.client.transcript.findIndex((exchange) => exchange.method === "POST")
	const readAt = result.client.transcript.findIndex((exchange) => exchange.method === "GET" && exchange.status === 200)
	expect(postAt).toBeGreaterThanOrEqual(0)
	expect(readAt).toBeGreaterThan(postAt)
}

async function flipsNestedBoolean() {
	const result = await runProfile(await track(serveNested()))
	expect(defectsOf(result)).toEqual([])
	const patches = result.client.transcript.filter((exchange) => exchange.method === "PATCH")
	expect(patches.map((exchange) => exchange.requestBody)).toEqual([{ dismissed: false }, { dismissed: true }])
	expect(statusOf(result, "profile.update")).toBe("passed")
}

async function asksWithCreatedHandle() {
	const { served, state } = await serveHandleQuery()
	const result = await runProfile(await track(served))
	expect(defectsOf(result)).toEqual([])
	expect(statusOf(result, "profile.available")).toBe("passed")
	expect(state.seen).not.toBe("")
	expect(state.seen).toBe(state.stored?.handle)
}

async function gradesBothReads() {
	const result = await runProfile(await track(serveTwoReads()))
	expect(defectsOf(result)).toEqual([])
	for (const id of ["profile.read", "profile.flags"]) {
		const op = result.scope.operations.find((item) => item.operationId === id)
		expect(op?.status).toBe("passed")
		expect(op?.checks.passed).toContain("auth.self-is-the-caller")
	}
	const paths = result.client.transcript
		.filter((exchange) => exchange.method === "GET" && exchange.status === 200)
		.map((exchange) => new URL(exchange.url).pathname)
	expect(paths).toContain("/v1/me")
	expect(paths).toContain("/v1/me/flags")
}

async function referenceCaughtOnlyWhenDropped() {
	const dropped = await judgeDefect("CALLER_UPDATE_DROPPED", {
		backend: "memory",
		dialect: "postgrest",
		via: listening,
	})
	expect(dropped.error).toBeUndefined()
	expect(dropped.detected).toBe(true)
	expect(dropped.spurious).toEqual([])
}

async function untaggedReferenceBlamesNoCaller() {
	const server = await createMemoryServer({ untagged: true })
	open.push(server)
	const result = await run({
		baseUrl: server.url,
		principals: PRINCIPALS,
		security: SECURITY,
		seed: 42,
		spec: `${server.url}/v1/openapi/spec`,
	})
	const blamed = result.findings.filter(
		(finding) =>
			DEFECT_VERDICTS.has(finding.verdict) &&
			(finding.entity === "profile" || finding.entity === "me" || finding.check === "auth.self-is-the-caller"),
	)
	expect(blamed).toEqual([])
}

describe("identity self", () => {
	it("reads the caller, sees an update stick, and refuses a missing token", readsUpdatesAndRefuses)
	it("reports a caller route that answers with no token", reportsOpenCallerRoute)
	it("reports an update the next read does not show", reportsForgottenUpdate)
	it("does not call a rate-limited read a lost update", throttledReadIsNoLostUpdate)
	it("flips a boolean-only caller field, reads it back, and restores it", flipsBooleanOnlyField)
	it("flips a boolean when the only other field is an enum", flipsBooleanBesideEnum)
	it("creates the caller through the spec create before the read", createsCallerBeforeRead)
	it("flips a boolean the read nests under other keys", flipsNestedBoolean)
	it("asks a caller query with the handle the create just sent", asksWithCreatedHandle)
	it("grades both reads on one caller entity", gradesBothReads)
	it("the reference backend is caught only when the caller update does not stick", referenceCaughtOnlyWhenDropped)
	it("an untagged reference does not blame the caller routes", untaggedReferenceBlamesNoCaller)
})
