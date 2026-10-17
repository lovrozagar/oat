import { describe, expect, it } from "vitest"
import { CHECKS } from "../../src/runtime/checks.ts"

describe("check registry golden", () => {
	/* Order is behavior: a check runs after the ones it depends on, and mutating checks run alone
	 * in registry order. The split of checks.ts must keep every row as it is. */
	it("ids, order, dependencies, mutation and transcript judging", async () => {
		const rows = CHECKS.map((check) => ({
			id: check.id,
			dependsOn: check.dependsOn ?? [],
			mutates: check.mutates === true,
			judgesTranscript: check.judgesTranscript === true,
			...(check.needs === undefined ? {} : { needs: check.needs }),
		}))
		await expect(`${JSON.stringify(rows, null, 2)}\n`).toMatchFileSnapshot("__snapshots__/registry.snap")
	})
})
