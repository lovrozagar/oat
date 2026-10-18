import { run } from "../../runtime/run/index.ts"
import type { ParserResult } from "../harness/result.ts"
import { PRINCIPALS } from "../matrix/principals.ts"
import { servePublicCatalogue } from "./public-catalogue.ts"
import { messageOf } from "../../errors/message.ts"

/**
 * A public catalogue is unscoped. Two principals, create as A, GET or filter as B → 200 is
 * the contract, and the isolation checks must not apply. The workspace-scoped widget fixture
 * is unchanged: tag → SECURITY, heuristic → AMBIGUITY. Same split for item GET and for
 * `filter=id.eq.<other tenant>`.
 */
export async function runTenantScopeSuite(): Promise<ParserResult[]> {
	const results: ParserResult[] = []

	try {
		const server = await servePublicCatalogue()
		try {
			const result = await run({
				baseUrl: server.url,
				principals: [
					{ headers: { authorization: "Bearer tok_alpha" }, id: "alpha", roots: { workspace_id: "ws_a" } },
					{ headers: { authorization: "Bearer tok_beta" }, id: "beta", roots: { workspace_id: "ws_b" } },
				],
				seed: 42,
				spec: `${server.url}/v1/openapi/spec`,
			})
			const tenantFindings = result.findings.filter(
				(f) =>
					f.check === "tenant.item-not-readable-cross-tenant" || f.check === "tenant.denial-does-not-reveal-existence",
			)
			const skipped = result.checksSkipped.some((s) => s.check === "tenant.item-not-readable-cross-tenant")
			const ran = result.checksRun.includes("tenant.item-not-readable-cross-tenant")
			const ok = tenantFindings.length === 0 && skipped && !ran
			results.push({
				detail: ok
					? "check did not apply; no finding"
					: `findings=${tenantFindings.map((f) => `${f.verdict}:${f.check}`).join(",") || "none"}; ` +
						`ran=${String(ran)}; skipped=${String(skipped)}`,
				name: "public catalogue 200 is not a finding",
				ok,
				why: "no x-tenant and template_id is not a tenant name, so isolation does not apply",
			})
		} finally {
			await server.close()
		}
	} catch (error) {
		results.push({
			detail: messageOf(error),
			name: "public catalogue 200 is not a finding",
			ok: false,
			why: "no x-tenant and template_id is not a tenant name, so isolation does not apply",
		})
	}

	try {
		const tagged = await leak(false)
		const ok = tagged.verdict === "SECURITY"
		results.push({
			detail: ok ? "SECURITY" : `expected SECURITY, got ${tagged.verdict ?? "no finding"}`,
			name: "tagged tenant leak is SECURITY",
			ok,
			why: "x-tenant + 200 from the other principal is a stated-boundary breach",
		})
	} catch (error) {
		results.push({
			detail: messageOf(error),
			name: "tagged tenant leak is SECURITY",
			ok: false,
			why: "x-tenant + 200 from the other principal is a stated-boundary breach",
		})
	}

	try {
		const inferred = await leak(true)
		const ok = inferred.verdict === "AMBIGUITY"
		results.push({
			detail: ok ? "AMBIGUITY" : `expected AMBIGUITY, got ${inferred.verdict ?? "no finding"}`,
			name: "inferred tenant leak is AMBIGUITY",
			ok,
			why: "workspace_id / project_id still infers a tenant when x-tenant is stripped",
		})
	} catch (error) {
		results.push({
			detail: messageOf(error),
			name: "inferred tenant leak is AMBIGUITY",
			ok: false,
			why: "workspace_id / project_id still infers a tenant when x-tenant is stripped",
		})
	}

	try {
		const server = await servePublicCatalogue()
		try {
			const result = await run({
				baseUrl: server.url,
				principals: [
					{ headers: { authorization: "Bearer tok_alpha" }, id: "alpha", roots: { workspace_id: "ws_a" } },
					{ headers: { authorization: "Bearer tok_beta" }, id: "beta", roots: { workspace_id: "ws_b" } },
				],
				seed: 42,
				spec: `${server.url}/v1/openapi/spec`,
			})
			const hits = result.findings.filter((f) => f.check === "tenant.filter-does-not-bypass-scope")
			const skipped = result.checksSkipped.some((s) => s.check === "tenant.filter-does-not-bypass-scope")
			const ran = result.checksRun.includes("tenant.filter-does-not-bypass-scope")
			const ok = hits.length === 0 && skipped && !ran
			results.push({
				detail: ok
					? "check did not apply; no finding"
					: `findings=${hits.map((f) => `${f.verdict}:${f.check}`).join(",") || "none"}; ` +
						`ran=${String(ran)}; skipped=${String(skipped)}`,
				name: "public catalogue filter 200 is not a finding",
				ok,
				why: "no x-tenant and no tenant-named path param, so a 200 on id.eq.<other row> is the contract",
			})
		} finally {
			await server.close()
		}
	} catch (error) {
		results.push({
			detail: messageOf(error),
			name: "public catalogue filter 200 is not a finding",
			ok: false,
			why: "no x-tenant and no tenant-named path param, so a 200 on id.eq.<other row> is the contract",
		})
	}

	try {
		const tagged = await leakFilter(false)
		const ok = tagged.verdict === "SECURITY"
		results.push({
			detail: ok ? "SECURITY" : `expected SECURITY, got ${tagged.verdict ?? "no finding"}`,
			name: "tagged tenant filter leak is SECURITY",
			ok,
			why: "x-tenant + filter 200 of the other tenant's row is a stated-boundary breach",
		})
	} catch (error) {
		results.push({
			detail: messageOf(error),
			name: "tagged tenant filter leak is SECURITY",
			ok: false,
			why: "x-tenant + filter 200 of the other tenant's row is a stated-boundary breach",
		})
	}

	try {
		const inferred = await leakFilter(true)
		const ok = inferred.verdict === "AMBIGUITY"
		results.push({
			detail: ok ? "AMBIGUITY" : `expected AMBIGUITY, got ${inferred.verdict ?? "no finding"}`,
			name: "inferred tenant filter leak is AMBIGUITY",
			ok,
			why: "workspace_id / project_id still infers a tenant when x-tenant is stripped",
		})
	} catch (error) {
		results.push({
			detail: messageOf(error),
			name: "inferred tenant filter leak is AMBIGUITY",
			ok: false,
			why: "workspace_id / project_id still infers a tenant when x-tenant is stripped",
		})
	}

	return results
}

async function leak(untagged: boolean): Promise<{ verdict: string | null; check: string | null }> {
	const { createMemoryServer } = await import("../../reference/http.ts")
	const backend = await createMemoryServer({ defects: ["CROSS_TENANT_READ"], untagged })
	try {
		const result = await run({
			baseUrl: backend.url,
			only: ["table"],
			principals: PRINCIPALS,
			seed: 42,
			spec: `${backend.url}/v1/openapi/spec`,
		})
		const hit = result.findings.find((f) => f.check === "tenant.item-not-readable-cross-tenant")
		return { check: hit?.check ?? null, verdict: hit?.verdict ?? null }
	} finally {
		await backend.close()
	}
}

async function leakFilter(untagged: boolean): Promise<{ verdict: string | null; check: string | null }> {
	const { createMemoryServer } = await import("../../reference/http.ts")
	const backend = await createMemoryServer({ defects: ["TENANT_LEAK_VIA_FILTER"], untagged })
	try {
		const result = await run({
			baseUrl: backend.url,
			only: ["table"],
			principals: PRINCIPALS,
			seed: 42,
			spec: `${backend.url}/v1/openapi/spec`,
		})
		const hit = result.findings.find((f) => f.check === "tenant.filter-does-not-bypass-scope")
		return { check: hit?.check ?? null, verdict: hit?.verdict ?? null }
	} finally {
		await backend.close()
	}
}
