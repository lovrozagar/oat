import { describe, expect, it } from "vitest"
import { checkMemo } from "../core/context.ts"
import { recordUpdateDrops, updateDrops } from "./update-drops.ts"

describe("updateDrops", () => {
	it("is empty until the update check records what the update drops, then holds exactly that", () => {
		const ctx = { memo: checkMemo() }
		expect([...updateDrops(ctx)]).toEqual([])
		recordUpdateDrops(ctx, ["billing_model", "plan"])
		expect([...updateDrops(ctx)]).toEqual(["billing_model", "plan"])
	})

	it("is one entity's: another entity's memo does not see it", () => {
		const run = new Map<string, unknown>()
		const org = { memo: checkMemo(run) }
		recordUpdateDrops(org, ["plan"])
		expect([...updateDrops({ memo: checkMemo(run) })]).toEqual([])
	})
})
