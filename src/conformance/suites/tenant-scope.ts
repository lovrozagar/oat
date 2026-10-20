import type { PrincipalsConfig } from "../../config/types/security.ts"
import { messageOf } from "../../errors/message.ts"
import type { RunResult } from "../../runtime/run/index.ts"
import { run } from "../../runtime/run/index.ts"
import { launch, reach, type Via } from "../harness/launch.ts"
import type { ParserResult } from "../harness/result.ts"
import { PRINCIPALS, SECURITY } from "../matrix/principals.ts"
import { publicCatalogue } from "./public-catalogue.ts"

/** One case: what it is called, why it matters, and what it found. */
interface TenantCase {
	name: string
	why: string
	probe: (via: Via) => Promise<{ ok: boolean; detail: string }>
}

/** One principal per workspace, each with the token the catalogue knows it by. */
const CATALOGUE_PRINCIPALS: PrincipalsConfig = {
	alpha: { scope: { workspace_id: "ws_a" }, tenant: "ws_a", token: "tok_alpha" },
	beta: { scope: { workspace_id: "ws_b" }, tenant: "ws_b", token: "tok_beta" },
}

/** oat run once against a fresh public catalogue. */
async function catalogueRun(via: Via): Promise<RunResult> {
	const hosted = await via.host(publicCatalogue())
	try {
		return await run({
			baseUrl: hosted.url,
			principals: CATALOGUE_PRINCIPALS,
			security: { bearer: { static: "{principal.token}" } },
			seed: 42,
			spec: `${hosted.url}/v1/openapi/spec`,
			...reach(hosted),
		})
	} finally {
		await hosted.close()
	}
}

/* A check that must not apply to the catalogue: skipped, not run, and no finding from any of `checks`. */
function standsDown(result: RunResult, check: string, checks: readonly string[]): { ok: boolean; detail: string } {
	const hits = result.findings.filter((f) => checks.includes(f.check))
	const skipped = result.checksSkipped.some((s) => s.check === check)
	const ran = result.checksRun.includes(check)
	const ok = hits.length === 0 && skipped && !ran
	return {
		detail: ok
			? "check did not apply; no finding"
			: `findings=${hits.map((f) => `${f.verdict}:${f.check}`).join(",") || "none"}; ` +
				`ran=${String(ran)}; skipped=${String(skipped)}`,
		ok,
	}
}

/** The verdict `check` reaches against the reference with `defect` injected, tagged or not. */
async function leakVerdict(
	via: Via,
	leak: { defect: string; check: string; untagged: boolean },
): Promise<string | null> {
	const backend = await launch(
		{ backend: "memory", dialect: "postgrest", via },
		{ defects: [leak.defect], untagged: leak.untagged },
	)
	try {
		const result = await run({
			baseUrl: backend.url,
			only: ["table"],
			principals: PRINCIPALS,
			security: SECURITY,
			seed: 42,
			spec: `${backend.url}/v1/openapi/spec`,
			...reach(backend),
		})
		return result.findings.find((f) => f.check === leak.check)?.verdict ?? null
	} finally {
		await backend.close()
	}
}

function leakCase(name: string, why: string, leak: { defect: string; check: string; untagged: boolean }): TenantCase {
	const want = leak.untagged ? "AMBIGUITY" : "SECURITY"
	return {
		name,
		probe: async (via) => {
			const verdict = await leakVerdict(via, leak)
			return {
				detail: verdict === want ? want : `expected ${want}, got ${verdict ?? "no finding"}`,
				ok: verdict === want,
			}
		},
		why,
	}
}

const ITEM = "tenant.item-not-readable-cross-tenant"
const FILTER = "tenant.filter-does-not-bypass-scope"
const STATED = "x-tenant + 200 from the other principal is a stated-boundary breach"
const INFERRED = "workspace_id / project_id still infers a tenant when x-tenant is stripped"

/**
 * A public catalogue is unscoped. Two principals, create as A, GET or filter as B → 200 is the
 * contract, and the isolation checks must not apply. The workspace-scoped widget fixture is
 * unchanged: tag → SECURITY, heuristic → AMBIGUITY. Same split for item GET and for
 * `filter=id.eq.<other tenant>`.
 */
const CASES: readonly TenantCase[] = [
	{
		name: "public catalogue 200 is not a finding",
		probe: async (via) => standsDown(await catalogueRun(via), ITEM, [ITEM, "tenant.denial-does-not-reveal-existence"]),
		why: "no x-tenant and template_id is not a tenant name, so isolation does not apply",
	},
	/* @__PURE__ */ leakCase("tagged tenant leak is SECURITY", STATED, {
		check: ITEM,
		defect: "CROSS_TENANT_READ",
		untagged: false,
	}),
	/* @__PURE__ */ leakCase("inferred tenant leak is AMBIGUITY", INFERRED, {
		check: ITEM,
		defect: "CROSS_TENANT_READ",
		untagged: true,
	}),
	{
		name: "public catalogue filter 200 is not a finding",
		probe: async (via) => standsDown(await catalogueRun(via), FILTER, [FILTER]),
		why: "no x-tenant and no tenant-named path param, so a 200 on id.eq.<other row> is the contract",
	},
	/* @__PURE__ */ leakCase(
		"tagged tenant filter leak is SECURITY",
		"x-tenant + filter 200 of the other tenant's row is a stated-boundary breach",
		{ check: FILTER, defect: "TENANT_LEAK_VIA_FILTER", untagged: false },
	),
	/* @__PURE__ */ leakCase("inferred tenant filter leak is AMBIGUITY", INFERRED, {
		check: FILTER,
		defect: "TENANT_LEAK_VIA_FILTER",
		untagged: true,
	}),
]

export async function runTenantScopeSuite(via: Via): Promise<ParserResult[]> {
	const results: ParserResult[] = []
	for (const { name, why, probe } of CASES) {
		try {
			results.push({ ...(await probe(via)), name, why })
		} catch (error) {
			results.push({ detail: messageOf(error), name, ok: false, why })
		}
	}
	return results
}
