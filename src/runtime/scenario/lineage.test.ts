import { describe, expect, it } from "vitest"
import type { ScenarioRequestStep } from "../../config/types/steps.ts"
import type { AccountEntry } from "../accounts/ledger.ts"
import { exchange } from "../checks/__fixtures__/harness.ts"
import type { Exchange } from "../exchange.ts"
import { keep, type Lineage, referenced, type ScenarioAccounts, selfDeleted, tagOf } from "./lineage.ts"

const entry = (n: number): AccountEntry => ({ identity: {}, n, operationId: "auth.register", status: "created" })
const [one, two] = [entry(1), entry(2)]

/* A step whose body sends each of `names` as `{name}`. */
const sending = (...names: string[]): ScenarioRequestStep => ({
	body: Object.fromEntries(names.map((name) => [name, `{${name}}`])),
	operationId: "op",
})

/* A self delete's answer, as the client records it. */
const answered = (status: number, operationId = "auth.deleteAccount"): Exchange => ({
	...exchange("DELETE", "/account", { status }),
	operationId,
})

describe("referenced", () => {
	it("lists every {name} the request sends: path, body, headers, query and bound parameters", () => {
		const step = {
			bind: { id: "{noteId}" },
			body: { nested: ["{a}"], text: "{b}" },
			headers: { authorization: "Bearer {session}", other: "{principal.email}" },
			method: "GET",
			path: "/orgs/{org}/notes",
			query: { q: "{c}" },
		} as ScenarioRequestStep
		expect([...referenced(step)].sort()).toEqual(["a", "b", "c", "noteId", "org", "session"])
	})
})

describe("tagOf", () => {
	const lineage: Lineage = new Map([
		["first", one],
		["second", two],
		["alsoFirst", one],
	])

	it("is the entry a step's own sign-up made, whatever it sent", () => {
		expect(tagOf(lineage, sending("second"), one)).toBe(one)
	})

	it("is the one entry every tagged name the step sent descends from", () => {
		expect(tagOf(lineage, sending("first", "alsoFirst", "untagged"), undefined)).toBe(one)
	})

	it("is none for names of two entries, or none tagged", () => {
		expect(tagOf(lineage, sending("first", "second"), undefined)).toBeUndefined()
		expect(tagOf(lineage, sending("untagged"), undefined)).toBeUndefined()
	})
})

describe("keep", () => {
	it("tags every name the step saved, its claims included, and untags a name rebound with none", () => {
		const lineage: Lineage = new Map([["kept", two]])
		const saving: ScenarioRequestStep = {
			operationId: "op",
			saveAs: { kept: "$.a", token: "$.b" },
			saveClaimsFrom: { bind: { sub: "sub" }, token: "token" },
		}
		keep(lineage, saving, one)
		expect(Object.fromEntries(lineage)).toEqual({ kept: one, sub: one, token: one })
		keep(lineage, { operationId: "op", saveAs: { kept: "$.c" } }, undefined)
		expect([...lineage.keys()].sort()).toEqual(["sub", "token"])
	})
})

describe("selfDeleted", () => {
	const lineage: Lineage = new Map([["session", one]])
	const deleting: ScenarioRequestStep = {
		anonymous: true,
		headers: { authorization: "Bearer {session}" },
		operationId: "auth.deleteAccount",
	}
	const settled = (step: ScenarioRequestStep, sent: Exchange) => {
		const deleted: AccountEntry[] = []
		const port: ScenarioAccounts = {
			deleteSelf: "auth.deleteAccount",
			deletedItself: (gone) => deleted.push(gone),
			madeBy: () => undefined,
		}
		selfDeleted(lineage, { accounts: port, exchange: sent, step })
		return deleted
	}

	it("settles the entry an accepted self delete sent with no principal descends from", () => {
		expect(settled(deleting, answered(204))).toEqual([one])
	})

	it("settles nothing for a refusal, another operation, or a step sent as a principal", () => {
		expect(settled(deleting, answered(403))).toEqual([])
		expect(settled(deleting, answered(302))).toEqual([])
		expect(settled({ ...deleting, operationId: "notes.delete" }, answered(204, "notes.delete"))).toEqual([])
		expect(settled({ ...deleting, anonymous: false }, answered(204))).toEqual([])
	})

	it("settles nothing when the run has no account ledger to settle", () => {
		expect(() => selfDeleted(lineage, { accounts: undefined, exchange: answered(204), step: deleting })).not.toThrow()
	})
})
