import { run } from "../../runtime/run/index.ts"
import type { ParserResult } from "../harness/result.ts"
import { PRINCIPALS } from "../matrix/principals.ts"

/**
 * `doctor` claims each tag unlocks specific checks. This proves it.
 *
 * The reference backend is run twice — with its tags and with them stripped — and the checks that
 * disappear must be exactly the set `TAG_UNLOCKS` promises. Without this the claim is a hand-
 * maintained list that drifts the moment a check's applicability changes, and a coverage promise
 * nobody verified is worse than no promise.
 */
/**
 * `baselines`, when given, are the checks the defect matrix's two clean baselines ran — the same
 * two runs this would otherwise make again.
 */
export async function runTagUnlockSuite(baselines?: {
	tagged: readonly string[]
	untagged: readonly string[]
}): Promise<ParserResult[]> {
	const { createMemoryServer } = await import("../../reference/http.ts")
	const { TAG_UNLOCKS } = await import("../../report/console.ts")

	const ran = async (untagged: boolean): Promise<Set<string>> => {
		const server = await createMemoryServer({ untagged })
		try {
			const result = await run({
				baseUrl: server.url,
				principals: PRINCIPALS,
				seed: 42,
				spec: `${server.url}/v1/openapi/spec`,
			})
			return new Set(result.checksRun)
		} finally {
			await server.close()
		}
	}

	const tagged = baselines === undefined ? await ran(false) : new Set(baselines.tagged)
	const untagged = baselines === undefined ? await ran(true) : new Set(baselines.untagged)
	const lost = [...tagged].filter((id) => !untagged.has(id)).sort()
	const promised = Object.values(TAG_UNLOCKS).flat().sort()

	const missing = promised.filter((id) => !lost.includes(id))
	const unclaimed = lost.filter((id) => !promised.includes(id))
	const ok = missing.length === 0 && unclaimed.length === 0

	return [
		{
			detail: ok
				? `${lost.length} check(s) unlocked by tags, exactly as documented`
				: `promised-but-not-lost: [${missing.join(", ")}]; lost-but-unclaimed: [${unclaimed.join(", ")}]`,
			name: "doctor's tag-unlock claims are true",
			ok,
			why: "a coverage promise nobody verified is worse than no promise",
		},
	]
}
