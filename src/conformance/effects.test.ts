import { describe, expect, it } from "vitest"
import type { Handle } from "../reference/http/node.ts"
import { runEffectsSuite } from "./effects.ts"
import { extractBackend } from "./effects/backend.ts"
import { extractSpec } from "./effects/spec.ts"
import { inProcess, type Via } from "./harness/launch.ts"
import { answer } from "./harness/serve.ts"

/* Every case's backend, changed by `change` before it is hosted. */
const changed = (change: (backend: Handle) => Handle): Via => ({
	...inProcess,
	host: (backend) => inProcess.host(change(backend)),
})

/* Every case run against an extract that makes `rowCount` rows, whatever the case asked for. */
const always = (rowCount: number) => changed(() => extractBackend(rowCount))

const isRows = (path: string) => path.endsWith("/rows")

const DECLARED = 'x-effects declares append ≥ 1 on "row", but the collection went from'
const WAITED =
	/wait=x-wait polls row\.list until \$\.rows\.0 is non-empty and the path was still empty after \d+ poll\(s\) \/ \d+ms\./

describe("runEffectsSuite", () => {
	it("rejects count with min, fails an empty extract, and passes a full one", async () => {
		const results = await runEffectsSuite(inProcess)
		expect(results.filter((r) => !r.ok).map((r) => `${r.name}: ${r.detail}`)).toEqual([])
		expect(results.map((r) => r.name)).toEqual([
			"count and min together are rejected at load",
			"extract with an empty row list fails min: 1",
			"extract with 5 rows passes min: 1",
		])
		expect(results[1]?.detail).toContain(`${DECLARED} 0 to 0`)
		expect(results[2]?.detail).toBe("no effect/wait findings")
	}, 120_000)
})

describe("runEffectsSuite against the wrong extract", () => {
	it("names what each extract case found when the backend does the opposite", async () => {
		const full = await runEffectsSuite(always(5))
		const empty = await runEffectsSuite(always(0))
		expect([full[1]?.ok, full[1]?.detail]).toEqual([
			false,
			"no effect finding; findings=BACKEND_BUG:validation.required-enforced,COVERAGE_GAP:world.teardown",
		])
		expect(empty[2]?.ok).toBe(false)
		expect(empty[2]?.detail).toContain(`effects=${DECLARED} 0 to 0`)
		expect(empty[2]?.detail).toMatch(WAITED)
	}, 120_000)
})

describe("runEffectsSuite against a changed backend", () => {
	it("says there were no findings at all when a document leaves nothing to find", async () => {
		const tables = "/v1/projects/{project_id}/tables"
		const listOnly = { ...extractSpec(), paths: { [tables]: { get: extractSpec().paths?.[tables]?.get } } }
		const results = await runEffectsSuite(
			changed(
				(backend) => async (request) =>
					request.url.pathname === "/v1/openapi/spec" ? answer(200, listOnly) : backend(request),
			),
		)
		expect(results[1]?.detail).toBe("no effect finding; findings=none")
	}, 120_000)

	it("names the wait alone when rows arrive but never at the head of the list", async () => {
		const nullFirst = changed((backend) => async (request) => {
			const answered = await backend(request)
			if (!isRows(request.url.pathname) || answered.status !== 200) return answered
			return answer(200, { rows: [null, ...(JSON.parse(answered.body) as { rows: unknown[] }).rows] })
		})
		const detail = (await runEffectsSuite(nullFirst))[2]?.detail
		expect(detail).toMatch(/^effects=none; /)
		expect(detail).toMatch(WAITED)
	}, 120_000)

	it("names the effect alone when the row list never changes", async () => {
		const staticRow = changed(
			(backend) => async (request) =>
				isRows(request.url.pathname) ? answer(200, { rows: [{ id: "r_x", table_id: "t_1" }] }) : backend(request),
		)
		const detail = (await runEffectsSuite(staticRow))[2]?.detail
		expect(detail).toMatch(new RegExp(`^effects=${DECLARED} 1 to 1 .*; wait=none$`))
	}, 120_000)

	it("reports each case it could not run", async () => {
		const nowhere: Via = { ...inProcess, host: () => Promise.reject(new Error("no host")) }
		const results = await runEffectsSuite(nowhere)
		expect(results.slice(1).map((r) => [r.ok, r.detail])).toEqual([
			[false, "no host"],
			[false, "no host"],
		])
	})
})
