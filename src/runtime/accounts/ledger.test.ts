import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type { Exchange } from "../exchange.ts"
import { AccountLedger, names } from "./ledger.ts"

/* Every account the run asked for, on disk before the request goes, by its names and never its password. */

const answer = (status: number) => ({ responseBody: {}, status }) as Exchange

let folder: string | undefined
afterEach(() => {
	if (folder !== undefined) rmSync(folder, { force: true, recursive: true })
	folder = undefined
})

describe("AccountLedger", () => {
	it("writes each sign-up to its file before the answer, then the answer, then teardown's verdict", () => {
		folder = mkdtempSync(join(tmpdir(), "oat-ledger-"))
		const file = join(folder, "accounts.json")
		const ledger = new AccountLedger(file)
		const entry = ledger.sending("auth.signup", { email: "a@x.test", password: "secret" })
		const read = () => readFileSync(file, "utf8")
		expect(JSON.parse(read())).toEqual({
			accounts: [{ identity: { email: "a@x.test" }, n: 1, operationId: "auth.signup", status: "sending" }],
		})
		ledger.answered(entry, answer(201), "m-1")
		expect(JSON.parse(read()).accounts[0]).toMatchObject({ id: "m-1", status: "created" })
		ledger.settle(entry, { note: "deleted itself", principal: "p", status: "removed" })
		expect(JSON.parse(read()).accounts[0]).toMatchObject({ note: "deleted itself", principal: "p", status: "removed" })
		expect(read()).not.toMatch(/secret/)
		expect(ledger.signUpOf(entry)).toEqual({ answer: answer(201), body: { email: "a@x.test", password: "secret" } })
	})

	it("owes what was made or never answered, and nothing a refusal or teardown settled", () => {
		const ledger = new AccountLedger()
		const refused = ledger.sending("auth.signup", {})
		ledger.answered(refused, answer(400), "ignored")
		const pending = ledger.sending("auth.signup", { email: "b@x.test" })
		const made = ledger.made("alpha", { email: "c@x.test", password: "pw" })
		const left = ledger.sending("auth.signup", {})
		ledger.answered(left, answer(201), "")
		ledger.settle(left, { note: "no way", status: "left" })
		expect(refused).toMatchObject({ status: "refused" })
		expect(refused.id).toBeUndefined()
		expect(left.id).toBeUndefined()
		expect(ledger.owed()).toEqual([pending, made])
		expect(made).toMatchObject({
			identity: { email: "c@x.test" },
			operationId: "(declared created)",
			principal: "alpha",
		})
		expect(ledger.signUpOf(made)).toBeUndefined()
		expect(ledger.entries()).toHaveLength(4)
	})
})

describe("names", () => {
	it("is the same account when every name it was made with is the identity's, and never an unnamed one", () => {
		const entry = { identity: { email: "a@x.test" }, n: 1, operationId: "o", status: "created" as const }
		expect(names(entry, { email: "a@x.test", password: "pw" })).toBe(true)
		expect(names(entry, { email: "b@x.test" })).toBe(false)
		expect(names({ ...entry, identity: {} }, {})).toBe(false)
	})
})
