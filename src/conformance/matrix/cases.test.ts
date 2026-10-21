import { afterEach, describe, expect, it } from "vitest"
import { inProcess, type Target, type Via } from "../harness/launch.ts"
import { judgeDefect, missingValuesOf, portableResult, runBaselines, runSuite } from "./cases.ts"

const MEMORY: Target = { backend: "memory", dialect: "postgrest", via: inProcess }
/* D1 without credentials: the reference cannot even start, so every case reports why. */
const UNREACHABLE: Target = { backend: "d1", dialect: "postgrest", via: inProcess }
const D1 = ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_D1_DATABASE_ID", "CLOUDFLARE_API_TOKEN"] as const
const saved = { ...process.env }

/** The reference behind a transport that rewrites what it says: a backend that misbehaves one way. */
function rewriting(transport: (request: Request, inner: typeof fetch) => Promise<Response>): Target {
	const via: Via = {
		...inProcess,
		launch: async (backend, options) => {
			const launched = await inProcess.launch(backend, options)
			const inner = launched.fetch as typeof fetch
			return { ...launched, fetch: (input, init) => transport(new Request(input, init), inner) }
		},
	}
	return { ...MEMORY, via }
}

/* Every create answers 201 without the new record's id. */
const ANONYMOUS = rewriting(async (request, inner) => {
	const answer = await inner(request)
	if (answer.status !== 201) return answer
	const { id: _, ...rest } = (await answer.json()) as Record<string, unknown>
	return Response.json(rest, { status: 201 })
})

/* Every create is refused: nothing is made, so there is nothing to tear down. */
const READ_ONLY = rewriting(async (request, inner) =>
	request.method === "POST" && !request.url.includes("/auth/")
		? Response.json({ error: "read only" }, { status: 403 })
		: inner(request),
)

/* A reproducer checker that finds every generated script broken. */
async function unrunnable(): Promise<string[]> {
	return ["stale.sh: syntax error near unexpected token"]
}

afterEach(() => {
	process.env = { ...saved }
})

describe("runSuite", () => {
	it("runs the baselines, then each defect the filter names", async () => {
		const results = await runSuite(MEMORY, ["STALE_LIST"])
		expect(results.map((result) => [result.label, result.detected, result.spurious.length])).toEqual([
			["baseline (correct backend)", true, 0],
			["baseline (untagged spec)", true, 0],
			["STALE_LIST", true, 0],
		])
		const [tagged, untagged, defect] = results
		expect(tagged).toMatchObject({ bystanders: [], leaked: 0, strayLedger: [], unreported: [] })
		expect(untagged?.leaked).toBeUndefined()
		expect(defect).toMatchObject({
			acceptable: expect.arrayContaining(["list.read-after-write"]),
			expected: "list.read-after-write",
		})
	}, 180_000)
})

describe("judgeDefect", () => {
	it("leaves out the bystanders a defect damages by design", async () => {
		const result = await judgeDefect("PATCH_REPLACES", MEMORY, { label: "patch" })
		expect(result).toMatchObject({ bystanders: [], detected: true, label: "patch" })
	}, 120_000)

	it("reports why a case could not run", async () => {
		for (const name of D1) delete process.env[name]
		const result = await judgeDefect("STALE_LIST", UNREACHABLE)
		expect(result).toMatchObject({ checksRun: [], detected: false, error: expect.stringMatching(/D1 backend needs/) })
	})
})

describe("judgeDefect's judging", () => {
	it("fails a defect whose generated reproducer is not runnable", async () => {
		const result = await judgeDefect("STALE_LIST", MEMORY, { checkRepros: unrunnable, label: "stale" })
		expect(result).toMatchObject({
			detected: false,
			error: "generated reproducer is not runnable — stale.sh: syntax error near unexpected token",
			spurious: [],
		})
	}, 120_000)

	it("expects the caller a destructive call killed to be blocked, not a spurious finding", async () => {
		const result = await judgeDefect("DISPOSABLE_KILLS_CALLER", MEMORY, { checkRepros: async () => [] })
		expect(result).toMatchObject({ detected: true, spurious: [] })
	}, 120_000)

	it("holds no excused defect to the bystander rule", async () => {
		const result = await judgeDefect("STALE_LIST", MEMORY, { excused: new Set(["STALE_LIST"]), label: "stale" })
		expect(result).toMatchObject({ bystanders: [], detected: true })
	}, 120_000)
})

describe("runBaselines", () => {
	it("names each check a create without an id left undecided", async () => {
		const [tagged, untagged] = await runBaselines(ANONYMOUS)
		const reason = "a record for this check could not be made: the create answered 201 without an id oat could read"
		expect(tagged?.inconclusive).toContain(`patch.minimality@table: ${reason}`)
		expect(untagged?.inconclusive).toContain(`patch.minimality@table: ${reason}`)
	}, 180_000)

	it("ledgers nothing against a backend that makes nothing", async () => {
		const [tagged] = await runBaselines(READ_ONLY)
		expect(tagged).toMatchObject({ leaked: 0, strayLedger: [], unreported: [] })
	}, 180_000)

	it("reports why each baseline could not run", async () => {
		for (const name of D1) delete process.env[name]
		const results = await runBaselines(UNREACHABLE)
		expect(results.map((result) => [result.label, result.detected, result.error !== undefined])).toEqual([
			["baseline (correct backend)", false, true],
			["baseline (untagged spec)", false, true],
		])
	})
})

describe("missingValuesOf", () => {
	it("names each check that would have sent a value oat did not have, and nothing else", () => {
		const inconclusive = [
			{ check: "patch.minimality", entity: "table", reason: "oat had no value for PATCH /table/undefined" },
			{ check: "sort.order-is-applied", entity: "table", reason: "the listing has one row" },
		]
		expect(missingValuesOf(inconclusive)).toEqual(["patch.minimality@table"])
	})
})

describe("portableResult", () => {
	it("drops the exchanges findings cite, and keeps the rest", () => {
		const finding = {
			check: "c",
			detail: "d",
			entity: "e",
			evidence: [{ seq: 1 }],
			summary: "s",
			verdict: "BACKEND_BUG",
		}
		const result = {
			checksRun: ["c"],
			defect: null,
			detected: true,
			entitiesTested: ["e"],
			expected: null,
			findings: [finding],
			label: "l",
			spurious: [finding],
		} as never
		const portable = portableResult(result)
		expect(portable.findings[0]?.evidence).toEqual([])
		expect(portable.spurious[0]?.evidence).toEqual([])
		expect(portable.findings[0]?.summary).toBe("s")
	})
})
