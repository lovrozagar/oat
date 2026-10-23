import { describe, expect, it } from "vitest"
import { run } from "../../src/conformance/harness/counting.ts"
import { inProcess, launch, reach } from "../../src/conformance/harness/launch.ts"
import { PRINCIPALS, SECURITY } from "../../src/conformance/matrix/principals.ts"
import type { DefectName } from "../../src/reference/defects/table.ts"
import { NEEDS_LIST } from "../../src/runtime/checks/core/run.ts"
import { STILL_READS } from "../../src/runtime/teardown/verify-gone.ts"

/*
 * The reference's webhook has a create, an item read, an update and a delete, and no list. oat
 * tests it through the records its creates return: the checks that need only those run, those
 * that read a listing are skipped as needing one, and teardown reads each record back to show it
 * gone. Clean, it finds nothing; a defect on its create or delete is still found on it.
 */

async function webhookRun(defects: DefectName[] = []) {
	const server = await launch({ backend: "memory", dialect: "postgrest", via: inProcess }, { defects })
	try {
		return await run({
			baseUrl: server.url,
			only: ["webhook"],
			principals: PRINCIPALS,
			security: SECURITY,
			seed: 42,
			spec: `${server.url}/v1/openapi/spec`,
			...reach(server),
		})
	} finally {
		await server.close()
	}
}

const onWebhook = (findings: Array<{ check: string; entity: string; verdict: string }>) =>
	findings.filter((finding) => finding.entity === "webhook").map((finding) => `${finding.verdict} ${finding.check}`)

describe("an entity with no list", () => {
	it("is tested clean through its creates, its listing checks skipped and its records shown gone", async () => {
		const result = await webhookRun()
		expect(result.entitiesTested).toEqual(["webhook"])
		expect(result.findings).toEqual([])
		expect(result.checksRun).toEqual(
			expect.arrayContaining(["create.persists-submitted-fields", "delete.absent-record-returns-404"]),
		)
		expect(result.checksRun).not.toContain("list.read-after-write")
		expect(result.checksSkipped).toContainEqual({
			check: "list.read-after-write",
			entity: "webhook",
			needs: NEEDS_LIST,
		})
		expect(result.teardown?.failed).toEqual([])
		expect(result.teardown?.removed).toBeGreaterThan(0)
	})

	it("still finds a create that drops a submitted field", async () => {
		expect(onWebhook((await webhookRun(["CREATE_DROPS_FIELD"])).findings)).toEqual([
			"BACKEND_BUG create.persists-submitted-fields",
		])
	})

	it("still finds a delete that keeps its record, and teardown shows each one still there", async () => {
		const result = await webhookRun(["DELETE_KEEPS_ROW"])
		expect(onWebhook(result.findings)).toEqual(["BACKEND_BUG delete.absent-record-returns-404"])
		const failed = result.teardown?.failed ?? []
		expect(failed.length).toBeGreaterThan(0)
		expect(failed.every((leftover) => leftover.entity === "webhook" && leftover.reason === STILL_READS)).toBe(true)
	})
})
