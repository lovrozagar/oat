import { describe, expect, it } from "vitest"
import { inProcess, type Via } from "../harness/launch.ts"
import { runCase, UNIQUE_CASES } from "./cases.ts"

const refusing: Via = { host: () => Promise.reject("refused"), launch: () => Promise.reject("refused") }

describe("UNIQUE_CASES", () => {
	it("names every result once", () => {
		const names = UNIQUE_CASES.flatMap((c) => c.judged.map((j) => j.name))
		expect(new Set(names).size).toBe(names.length)
	})
})

describe("runCase", () => {
	it("judges one run for each result it carries", async () => {
		const adopts = UNIQUE_CASES.find((c) => c.judged.length === 3)
		expect(adopts).toBeDefined()
		const results = await runCase(inProcess, adopts ?? { judged: [], options: { spec: {} } })
		expect(results.map((r) => [r.name, r.ok])).toEqual([
			["tagged seed 409 + nonempty list adopts", true],
			["unique check still runs after unique-409 adopt", true],
			["seed 409 is not the unique check passing", true],
		])
		expect(Object.keys(results[0] ?? {})).toEqual(["detail", "name", "ok", "why"])
	}, 60_000)

	it("fails every result of a run that could not happen, with why", async () => {
		const untagged = UNIQUE_CASES.find((c) => c.judged.length === 2) ?? { judged: [], options: { spec: {} } }
		expect(await runCase(refusing, untagged)).toEqual([
			{
				detail: "refused",
				name: "untagged seed 409 is still a seed failure",
				ok: false,
				why: "do not treat every 409 as unique",
			},
			{ detail: "refused", name: "untagged 409 does not adopt as x-unique", ok: false, why: "no tag, no unique adopt" },
		])
	})
})
