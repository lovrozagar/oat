import { describe, expect, it } from "vitest"
import { isNetworkError } from "../../src/errors/network.ts"
import { fetchWithNetworkRetry } from "../../src/runtime/network/fetch.ts"
import { probeOrigin } from "../../src/runtime/network/probe.ts"
import { failing, net } from "../support/network-fixtures.ts"

const SPEC = "http://x.test/spec"

async function probesReachableAndRefused(): Promise<void> {
	expect(await probeOrigin("http://x.test", { online: () => false })).toBe(false)
	expect(await probeOrigin("not a url")).toBe(false)
	expect(await probeOrigin("http://x.test", { fetchImpl: async () => new Response(null, { status: 404 }) })).toBe(true)
	expect(await probeOrigin("http://x.test", { fetchImpl: failing("ECONNREFUSED") })).toBe(false)
	expect(
		await probeOrigin("http://x.test", {
			fetchImpl: async () => {
				throw new SyntaxError("bug")
			},
		}),
	).toBe(true)
	expect(await probeOrigin("http://x.test", { fetchImpl: async () => new Response(null, { status: 204 }) })).toBe(true)
}

async function usesDefaults(): Promise<void> {
	const original = globalThis.fetch
	globalThis.fetch = (async () => new Response("ok")) as typeof fetch
	try {
		const res = await fetchWithNetworkRetry(SPEC)
		expect(await res.text()).toBe("ok")
	} finally {
		globalThis.fetch = original
	}

	let clock = 0
	const waits: string[] = []
	await expect(
		fetchWithNetworkRetry(
			SPEC,
			{},
			{
				fetchImpl: failing("ECONNRESET"),
				now: () => clock,
				onWait: (info) => waits.push(info.kind),
				retries: 0,
				sleep: async (ms) => {
					clock += ms
				},
			},
		),
	).rejects.toSatisfy((error: unknown) => isNetworkError(error) && error.kind === "reset")
	expect(waits.length).toBeGreaterThan(0)
}

async function retriesABlip(): Promise<void> {
	let hits = 0
	const sleeps: number[] = []
	const res = await fetchWithNetworkRetry(
		SPEC,
		{ method: "GET" },
		{
			fetchImpl: async () => {
				hits += 1
				if (hits < 3) throw net("ECONNRESET")
				return new Response("ok", { status: 200 })
			},
			retries: 4,
			sleep: async (ms) => {
				sleeps.push(ms)
			},
			waitMs: 0,
		},
	)
	expect(await res.text()).toBe("ok")
	expect(hits).toBe(3)
	expect(sleeps).toEqual([250, 500])
}

async function waitsThenFailsNamed(): Promise<void> {
	let clock = 0
	await expect(
		fetchWithNetworkRetry(
			SPEC,
			{},
			{
				fetchImpl: failing("ENETUNREACH"),
				probe: async () => false,
				retries: 0,
				sleep: async (ms) => {
					clock += ms
				},
				waitMs: 80,
			},
		),
	).rejects.toSatisfy((error: unknown) => {
		return (
			isNetworkError(error) &&
			error.kind === "unreachable" &&
			error.message.includes("never") === false &&
			error.message.includes("not a backend")
		)
	})
	void clock
}

async function recoversAfterProbe(): Promise<void> {
	let hits = 0
	const res = await fetchWithNetworkRetry(
		SPEC,
		{ method: "POST" },
		{
			fetchImpl: async () => {
				hits += 1
				if (hits === 1) throw net("ENOTFOUND")
				return new Response("{}", { status: 200 })
			},
			probe: async () => true,
			retries: 0,
			sleep: async () => undefined,
			waitMs: 200,
		},
	)
	expect(res.status).toBe(200)
}

async function passesAbortSignal(): Promise<void> {
	let sawSignal = false
	const res = await fetchWithNetworkRetry(
		SPEC,
		{},
		{
			fetchImpl: async (_url, init) => {
				sawSignal = init?.signal !== undefined
				return new Response("ok")
			},
			requestTimeoutMs: 1_000,
			retries: 0,
			waitMs: 0,
		},
	)
	expect(res.status).toBe(200)
	expect(sawSignal).toBe(true)
}

async function usesDefaultProbe(): Promise<void> {
	let clock = 0
	await expect(
		fetchWithNetworkRetry(
			SPEC,
			{},
			{
				fetchImpl: failing("ECONNREFUSED"),
				now: () => clock,
				retries: 0,
				sleep: async (ms) => {
					clock += ms
				},
				waitMs: 80,
			},
		),
	).rejects.toSatisfy((error: unknown) => isNetworkError(error) && error.kind === "refused")
}

async function propagatesPostRecoveryFailure(): Promise<void> {
	await expect(
		fetchWithNetworkRetry(
			SPEC,
			{},
			{
				fetchImpl: failing("ECONNRESET"),
				probe: async () => true,
				retries: 0,
				sleep: async () => undefined,
				waitMs: 100,
			},
		),
	).rejects.toSatisfy((error: unknown) => isNetworkError(error) && error.kind === "reset")
}

async function keepsTlsErrors(): Promise<void> {
	await expect(
		fetchWithNetworkRetry(SPEC, {}, { fetchImpl: failing("UNABLE_TO_VERIFY_LEAF_SIGNATURE"), retries: 2, waitMs: 0 }),
	).rejects.toBeInstanceOf(TypeError)
}

describe("probeOrigin / fetchWithNetworkRetry", () => {
	it("probeOrigin treats a reachable host as up and a refused port as down", probesReachableAndRefused)
	it("uses default retries, fetch, sleep, and wait budget", usesDefaults)
	it("retries a blip and then succeeds", retriesABlip)
	it("waits for the link after retries, then fails with a named NetworkError", waitsThenFailsNamed)
	it("recovers after the wait budget probe succeeds", recoversAfterProbe)
	it("passes AbortSignal when requestTimeoutMs is set", passesAbortSignal)
	it("uses the default origin probe after retries", usesDefaultProbe)
	it("propagates a post-recovery failure", propagatesPostRecoveryFailure)
	it("does not swallow a TLS / programming error", keepsTlsErrors)
})
