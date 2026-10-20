import { describe, expect, it } from "vitest"
import type { OutOfBandRequest } from "../../config/types/hooks.ts"
import { resolveOutOfBandValue, sentAt, triggerSentAt } from "./out-of-band.ts"

const quick = { attempts: 2, initialMs: 1, maxMs: 1 }

describe("sentAt", () => {
	it("is when the answer finished less how long it took", () => {
		expect(sentAt({ at: 100, durationMs: 30 })).toBe(70)
	})
})

/** A sent request: its URL and body, answered at `at` after one millisecond. */
const hop = (url: string, requestBody: unknown, at: number) => ({ at, durationMs: 1, requestBody, url })

describe("triggerSentAt", () => {
	it("is the latest request naming the address in its URL or body, plain or encoded", () => {
		const sent = [
			hop("http://api.test/invite", { email: "a@x.test" }, 10),
			hop("http://api.test/other", { email: "b@x.test" }, 20),
		]
		expect(triggerSentAt(sent, "a@x.test")).toBe(9)
		expect(triggerSentAt([hop("http://api.test/r?to=a%40x.test", undefined, 5)], "a@x.test")).toBe(4)
		expect(triggerSentAt([hop("http://api.test/r", "to=a@x.test", 7)], "a@x.test")).toBe(6)
	})

	it("cannot tell for an empty address or when no request names it", () => {
		expect(triggerSentAt([hop("http://api.test/a@x.test", null, 1)], "")).toBeUndefined()
		expect(triggerSentAt([hop("http://api.test/r", null, 1)], "a@x.test")).toBeUndefined()
	})
})

describe("resolveOutOfBandValue", () => {
	it("refuses without a hook to ask", async () => {
		await expect(
			resolveOutOfBandValue(undefined, "a@x.test", { kind: "email-verify", label: 'principal "a"' }),
		).rejects.toThrow(
			'oat: principal "a" needs a "email-verify" value delivered outside HTTP, but the config declares no ' +
				"resolveOutOfBand hook.",
		)
	})

	it("polls until the value arrives, asking with the address, scope and send time, and no credential", async () => {
		const asked: OutOfBandRequest[] = []
		const value = await resolveOutOfBandValue(
			async (request) => {
				asked.push(request)
				return request.attempt >= 2 ? "tok" : null
			},
			"a@x.test",
			{ kind: "otp", label: "x", outOfBand: quick, scope: { s: "1" }, since: 5 },
		)
		expect(value).toBe("tok")
		expect(asked).toEqual([
			{ address: "a@x.test", attempt: 1, kind: "otp", scope: { s: "1" }, since: 5 },
			{ address: "a@x.test", attempt: 2, kind: "otp", scope: { s: "1" }, since: 5 },
		])
	})

	it("asks with an empty scope, and no send time, when given none", async () => {
		const asked: OutOfBandRequest[] = []
		const hook = async (request: OutOfBandRequest) => {
			asked.push(request)
			return "tok"
		}
		await resolveOutOfBandValue(hook, "a@x.test", { kind: "otp", label: "x" })
		expect(asked).toEqual([{ address: "a@x.test", attempt: 1, kind: "otp", scope: {} }])
	})

	it("gives up after the last attempt with the worst-case wait", async () => {
		await expect(
			resolveOutOfBandValue(async () => "", "a@x.test", { kind: "otp", label: "x", outOfBand: quick }),
		).rejects.toThrow('oat: no "otp" value arrived for a@x.test after 2 attempts (~2ms worst-case wait).')
	})
})
