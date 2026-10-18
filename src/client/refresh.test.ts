import { describe, expect, it } from "vitest"
import type { Exchange } from "../runtime/exchange.ts"
import { afterUnauthorized, AuthRefreshError, refreshing } from "./refresh.ts"

const answer = (status: number, seq = 1): Exchange => ({ seq, status }) as Exchange

describe("AuthRefreshError", () => {
	it("names the principal when known, with the reason", () => {
		expect(new AuthRefreshError("alpha", new Error("401 at /token")).message).toBe(
			'refreshing the credential of "alpha" failed: 401 at /token',
		)
		const unnamed = new AuthRefreshError(undefined, "down")
		expect(unnamed.message).toBe("refreshing the credential failed: down")
		expect(unnamed.name).toBe("AuthRefreshError")
		expect(unnamed.reason).toBe("down")
	})
})

describe("refreshing", () => {
	it("passes force through and resolves when the refresh does", async () => {
		const forced: Array<boolean | undefined> = []
		const refresh = refreshing(
			async (force) => {
				forced.push(force)
			},
			() => "alpha",
		)
		await refresh(true)
		await refresh()
		expect(forced).toEqual([true, undefined])
	})

	it("raises a failed refresh as the principal's", async () => {
		const refresh = refreshing(
			async () => {
				throw new Error("token endpoint 500")
			},
			() => "beta",
		)
		const error = await refresh(false).catch((caught: unknown) => caught)
		expect(error).toBeInstanceOf(AuthRefreshError)
		expect(error).toMatchObject({ principal: "beta" })
	})
})

describe("afterUnauthorized", () => {
	it("supersedes a 401, forces one refresh, and sends again", async () => {
		const events: string[] = []
		const result = await afterUnauthorized(answer(401), {
			refresh: async (force) => {
				events.push(`refresh ${String(force)}`)
			},
			send: async () => {
				events.push("send")
				return answer(200, 2)
			},
			supersede: (exchange) => events.push(`supersede ${exchange.seq}`),
		})
		expect(result.status).toBe(200)
		expect(events).toEqual(["supersede 1", "refresh true", "send"])
	})

	it("keeps any other answer, and a 401 it cannot refresh", async () => {
		const never = { refresh: undefined, send: () => Promise.reject(new Error("sent")), supersede: () => undefined }
		expect((await afterUnauthorized(answer(401), never)).status).toBe(401)
		const ok = answer(200)
		expect(await afterUnauthorized(ok, { ...never, refresh: async () => undefined })).toBe(ok)
	})
})
