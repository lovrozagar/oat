import { describe, expect, it } from "vitest"
import { TAG_UNLOCKS } from "../../report/console/tags.ts"
import { inProcess } from "../harness/launch.ts"
import { runTagUnlockSuite } from "./tag-unlock.ts"

const promised = [...new Set(Object.values(TAG_UNLOCKS).flat())]

/* Given the baselines the defect matrix already ran, the suite runs nothing itself. */
describe("runTagUnlockSuite", () => {
	it("holds when stripping the tags loses exactly the promised checks", async () => {
		const [result] = await runTagUnlockSuite(inProcess, {
			tagged: ["list.read-after-write", ...promised],
			untagged: ["list.read-after-write"],
		})
		expect(result).toMatchObject({
			detail: `${promised.length} check(s) unlocked by tags, exactly as documented`,
			ok: true,
		})
	})

	it("names a promise that did not hold and a loss nobody claimed", async () => {
		const [kept, ...rest] = promised
		const [result] = await runTagUnlockSuite(inProcess, { tagged: [...rest, "x.unclaimed"], untagged: [] })
		expect(result).toMatchObject({
			detail: `promised-but-not-lost: [${kept}]; lost-but-unclaimed: [x.unclaimed]`,
			ok: false,
		})
	})

	it("runs both baselines itself when not given them, and the claims hold", async () => {
		const [result] = await runTagUnlockSuite(inProcess)
		expect(result).toMatchObject({ ok: true })
	}, 120_000)
})
