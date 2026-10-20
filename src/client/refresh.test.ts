import { describe, expect, it } from "vitest"
import type { Exchange } from "../runtime/exchange.ts"
import { afterUnauthorized } from "./refresh.ts"

const answer = (status: number, seq = 1): Exchange => ({ seq, status }) as Exchange

describe("afterUnauthorized", () => {
	it("renews the credential a 401 carried, supersedes the 401, and sends again", async () => {
		const events: string[] = []
		const result = await afterUnauthorized(answer(401), {
			renew: async () => {
				events.push("renew")
				return true
			},
			send: async () => {
				events.push("send")
				return answer(200, 2)
			},
			supersede: (exchange) => events.push(`supersede ${exchange.seq}`),
		})
		expect(result.status).toBe(200)
		expect(events).toEqual(["renew", "supersede 1", "send"])
	})

	it("keeps any other answer, and a 401 the request may not renew for", async () => {
		const renewals: string[] = []
		const never = {
			renew: async () => (renewals.push("asked"), false),
			send: () => Promise.reject(new Error("sent")),
			supersede: () => {
				throw new Error("superseded")
			},
		}
		expect((await afterUnauthorized(answer(401), never)).status).toBe(401)
		const ok = answer(200)
		expect(await afterUnauthorized(ok, never)).toBe(ok)
		expect(renewals).toEqual(["asked"])
	})
})
