import { buildModel } from "../../spec/graph.ts"
import { dereference, loadSpec } from "../../spec/load.ts"
import type { ParserResult } from "../harness/result.ts"
import { messageOf } from "../../errors/message.ts"

/**
 * The annotated example document must resolve to what its comments claim.
 *
 * `labs/annotated-openapi.yaml` is the only place that shows a reader where each tag goes in a
 * real document, and documentation that drifts from the implementation is worse than none — it
 * teaches a shape that no longer works. Asserting the derived model here means the example cannot
 * rot: rename a tag or change how a role resolves, and this fails.
 *
 * It also proved its worth immediately. The first version was invalid YAML (`{workspace_id}` inside
 * a flow sequence) and named an `x-invalidate` route that did not exist in the document.
 */
export async function runExampleSpecSuite(): Promise<ParserResult[]> {
	const path = new URL("../../../labs/annotated-openapi.yaml", import.meta.url).pathname
	const results: ParserResult[] = []
	const fail = (name: string, why: string, detail: string): void => {
		results.push({ detail, name, ok: false, why })
	}

	let model: ReturnType<typeof buildModel>
	try {
		const { doc } = dereference(await loadSpec(path))
		model = buildModel(doc)
	} catch (error) {
		fail("annotated-openapi.yaml", "the documented example must be a parseable OpenAPI document", messageOf(error))
		return results
	}

	const list = model.byOperationId.get("widget.list")
	const create = model.byOperationId.get("widget.create")
	const update = model.byOperationId.get("widget.update")
	const start = model.byOperationId.get("export.start")
	const widgetRead = model.byOperationId.get("widget.read")
	const templateRead = model.byOperationId.get("template.read")

	const expectations: Array<[string, string, unknown, unknown]> = [
		["x-query resolves the filter grammar", "the comment claims postgrest", list?.conventions.grammar, "postgrest"],
		["x-query declares filterable fields", "not guessed from the schema", list?.query?.source, "tag"],
		[
			"x-query accepts structured filterable rows",
			"declared-or-skip catalog",
			list?.query?.filterFields?.[0]?.field,
			"id",
		],
		["x-query sets maxLimit", "used to bound page-size probes", list?.query?.maxLimit, 100],
		["limit resolves as page size", "distinguished by maximum + default", list?.conventions.limit, "limit"],
		["cursor role resolves", "declared alongside page", list?.conventions.cursor, "cursor"],
		["x-tenant is declared, not inferred", "decides SECURITY vs AMBIGUITY", list?.tenantSource, "tag"],
		["workspace widget read is tagged", "SECURITY vs AMBIGUITY is unchanged", widgetRead?.tenantSource, "tag"],
		[
			"public catalogue is unscoped",
			"no x-tenant and template_id is not a tenant name",
			templateRead?.tenantSource,
			null,
		],
		["public catalogue has no tenant param", 'omit is not the string "null"', templateRead?.tenantParam, null],
		["x-invalidate names two routes", "one of them cross-entity", create?.invalidates.length, 2],
		["idempotency header is modelled", "a promise oat replays", create?.idempotencyHeader, "Idempotency-Key"],
		["x-immutable is read", "probed for rejection", update?.immutable.includes("workspace_id"), true],
		["x-async is read", "oat follows the job", start?.async?.poll, "export.read"],
		["x-feature-gate is read", "a matching 403 is coverage, not a seed defect", create?.featureGate, "widgets"],
		["x-unique is read", "a 409 duplicate is a pass, 2xx is BACKEND_BUG", create?.unique, [["name"]]],
	]

	for (const [name, why, actual, expected] of expectations) {
		const ok = JSON.stringify(actual) === JSON.stringify(expected)
		results.push({
			detail: ok ? `${JSON.stringify(actual)}` : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
			name,
			ok,
			why,
		})
	}
	return results
}
