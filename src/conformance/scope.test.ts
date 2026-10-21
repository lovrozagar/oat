import { describe, expect, it } from "vitest"
import { inProcess, type Via } from "./harness/launch.ts"
import { runScopeSuite } from "./scope.ts"

/* Every defect runs in the conformance suite, reusing the defect matrix's full runs; these keep
 * the two ways in — finding the operations itself, and being handed them — under unit test. */
describe("--ops recall", () => {
	it("a run targeted at a defect's operation still reports it", async () => {
		const results = await runScopeSuite(inProcess, ["STALE_LIST", "CROSS_TENANT_READ"])
		expect(results.filter((r) => !r.ok).map((r) => `${r.name}: ${r.detail}`)).toEqual([])
		expect(results).toHaveLength(2)
	}, 600_000)

	it("sends only the targeted run when the full run's operations are known", async () => {
		const results = await runScopeSuite(inProcess, ["PATCH_REPLACES"], { PATCH_REPLACES: ["table.update"] })
		expect(results.map((r) => r.ok)).toEqual([true])
	}, 600_000)

	it("switches on a defect's opt-in, in the reference and in oat, for the targeted run", async () => {
		const results = await runScopeSuite(inProcess, ["LOGIN_NOT_THROTTLED"], { LOGIN_NOT_THROTTLED: ["auth.token"] })
		expect(results.map((r) => [r.ok, r.detail])).toEqual([[true, "--ops auth.token: reported, status failed"]])
	}, 600_000)

	it("fails a defect whose finding names no operation, or is not reported where it points", async () => {
		const results = await runScopeSuite(inProcess, ["STALE_LIST", "PATCH_REPLACES"], {
			PATCH_REPLACES: ["job.list"],
			STALE_LIST: [],
		})
		expect(results.map((r) => [r.ok, r.detail])).toEqual([
			[false, "list.read-after-write finding carries no operation"],
			[false, expect.stringMatching(/^--ops job\.list: MISSED, status /)],
		])
	}, 600_000)

	it("fails a defect the full run did not report, and names a selector no operation answers to by name", async () => {
		/* The reference launches without the defect it was asked for: there is nothing to find. */
		const unbroken: Via = {
			...inProcess,
			launch: (backend, options) => inProcess.launch(backend, { ...options, defects: [] }),
		}
		const results = await runScopeSuite(unbroken, ["STALE_LIST", "PATCH_REPLACES"], { PATCH_REPLACES: ["table.*"] })
		expect(results.map((r) => [r.ok, r.detail])).toEqual([
			[false, "the full run did not report it either"],
			[false, "--ops table.*: MISSED, status absent"],
		])
	}, 600_000)

	it("reports a run that could not start", async () => {
		const nowhere = {
			host: () => Promise.reject(new Error("no host")),
			launch: () => Promise.reject(new Error("down")),
		}
		expect(await runScopeSuite(nowhere, ["STALE_LIST"])).toMatchObject([{ detail: "down", ok: false }])
	})
})
