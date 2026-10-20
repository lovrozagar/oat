import { describe, expect, it } from "vitest"
import type { OperationModel } from "../../spec/graph/types.ts"
import { exchange } from "../checks/__fixtures__/harness.ts"
import type { Answer } from "../checks/__fixtures__/harness.ts"
import { type Accounts, accounts, accountsApi, accountsDoc, sessionHolding, stageOf } from "./__fixtures__/accounts.ts"
import { afterCall } from "./after.ts"
import type { DisposableInput, Session } from "./types.ts"

const CHECK = "auth.destructive-spares-the-caller"
const called = exchange("POST", "/v1/x", { status: 200 })

/** `afterCall` for `operationId`, accepted, as the second user `t1` — who logged in before it ran. */
async function after(
	state: Accounts,
	call: {
		operationId: string
		ends?: boolean
		/* `nothing`: a refresh is declared, and sends no request (fenced, or missing a value). */
		renew?: Answer | "nothing"
		values?: Record<string, string>
		read?: Partial<OperationModel>
	},
): Promise<DisposableInput> {
	state.tokens.add("t1")
	const staged = await stageOf(accountsDoc(), accountsApi(state))
	const { input } = staged
	const op = input.model.byOperationId.get(call.operationId) as OperationModel
	const read = { ...(input.model.byOperationId.get("profile.read") as OperationModel), ...call.read }
	const renew = call.renew
	const session: Session = await sessionHolding(
		staged,
		"t1",
		renew === undefined
			? {}
			: { renew: async () => (renew === "nothing" ? undefined : exchange("POST", "/v1/refresh", renew)) },
	)
	if (call.operationId === "auth.logout") {
		accountsApi(state)("POST", "/v1/logout", { headers: { authorization: "Bearer t1" } })
	}
	await afterCall(input, {
		blame: { collector: input.findings.attributed([op.operationId]).ownedBy(CHECK), entity: "profile" },
		called,
		ends: call.ends ?? false,
		op,
		read,
		session,
		values: call.values ?? {},
	})
	return input
}

const summaries = (input: DisposableInput) =>
	input.findings.findings.map((finding) => `${finding.entity}: ${finding.summary}`)

describe("afterCall: the suite caller", () => {
	it("fails a call that logged the suite caller out", async () => {
		const input = await after(accounts({ killCaller: true }), { operationId: "auth.logout" })
		expect(summaries(input)).toEqual(["profile: the suite caller was logged out"])
		const anonymous = await after(accounts({ killCaller: true }), {
			operationId: "auth.logout",
			read: { entity: null },
		})
		expect(summaries(anonymous)).toEqual(["caller: the suite caller was logged out"])
	})
})

describe("afterCall: a deleted record", () => {
	it("proves a delete by the list that no longer holds it", async () => {
		const state = accounts({ keys: [] })
		const input = await after(state, { operationId: "keys.delete", values: { key_id: "k1" } })
		expect(input.grades.evidence.get("keys.delete")).toMatchObject({
			call: called.seq,
			observation: { absent: true, path: "$", value: "k1" },
		})
	})

	it("fails a delete whose record is still listed", async () => {
		const input = await after(accounts(), { operationId: "keys.delete", values: { key_id: "k1" } })
		expect(summaries(input)).toEqual(["profile: the credential was still listed"])
		expect(input.grades.evidence.has("keys.delete")).toBe(false)
	})

	it("proves only the call when the list is refused", async () => {
		const state = accounts({ answers: { "GET /v1/keys": { status: 403 } } })
		const input = await after(state, { operationId: "keys.delete", values: { key_id: "k1" } })
		expect(input.grades.evidence.get("keys.delete")).toEqual({ call: called.seq })
	})
})

describe("afterCall: an ended session", () => {
	it("proves it by the refused read, sent as the ended session and never renewed", async () => {
		const input = await after(accounts(), { ends: true, operationId: "auth.logout" })
		expect(input.grades.evidence.get("auth.logout")?.observation).toMatchObject({ status: 401 })
		const reads = input.client.transcript.filter((sent) => sent.operationId === "profile.read")
		expect(reads.map((sent) => [sent.principal, sent.status])).toEqual([
			["alpha", 200],
			["disposable-t1", 401],
		])
		const refusedRenew = await after(accounts(), { ends: true, operationId: "auth.logout", renew: { status: 401 } })
		expect(refusedRenew.findings.findings).toEqual([])
	})

	it("fails a session still accepted, and a refresh that still renews", async () => {
		const kept = await after(accounts({ keepSession: true }), {
			ends: true,
			operationId: "auth.logout",
			renew: { status: 200 },
		})
		expect(summaries(kept)).toEqual(["profile: the disposable session was still accepted"])
		expect(kept.findings.findings[0]?.evidence).toHaveLength(3)
		const renewing = await after(accounts(), { ends: true, operationId: "auth.logout", renew: { status: 200 } })
		expect(summaries(renewing)).toEqual(["profile: the refresh token still renews after the session ended"])
		const redirected = await after(accounts(), { ends: true, operationId: "auth.logout", renew: { status: 302 } })
		expect(summaries(redirected)).toEqual(["profile: the refresh token still renews after the session ended"])
	})

	it("takes a refused refresh as the proof when the read still answers", async () => {
		const input = await after(accounts({ keepSession: true }), {
			ends: true,
			operationId: "auth.logout",
			renew: { status: 401 },
		})
		expect(input.findings.findings).toEqual([])
		expect(input.grades.evidence.get("auth.logout")?.observation).toMatchObject({ status: 401 })
	})

	it("fails a session still accepted when no refresh refused it, declared or not", async () => {
		const unrenewable = await after(accounts({ keepSession: true }), { ends: true, operationId: "auth.logout" })
		expect(summaries(unrenewable)).toEqual(["profile: the disposable session was still accepted"])
		expect(unrenewable.findings.findings[0]?.evidence).toHaveLength(2)
		expect(unrenewable.grades.evidence.has("auth.logout")).toBe(false)
		const silent = await after(accounts({ keepSession: true }), {
			ends: true,
			operationId: "auth.logout",
			renew: "nothing",
		})
		expect(summaries(silent)).toEqual(["profile: the disposable session was still accepted"])
	})

	it("proves an ended session by the refused read when its refresh sent nothing", async () => {
		const input = await after(accounts(), { ends: true, operationId: "auth.logout", renew: "nothing" })
		expect(input.findings.findings).toEqual([])
		expect(input.grades.evidence.get("auth.logout")?.observation).toMatchObject({ status: 401 })
	})
})
