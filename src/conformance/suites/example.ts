import { buildModel } from "../../spec/graph/build.ts"
import { dereference } from "../../spec/load/dereference.ts"
import { loadSpec } from "../../spec/load/source.ts"
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

type Model = ReturnType<typeof buildModel>

/** A claim the document's comments make: its name, why it matters, what the model says, and what it must. */
type Expectation = [string, string, unknown, unknown]

/** What the comments claim about the widget listing. */
function listExpectations(model: Model): Expectation[] {
	const list = model.byOperationId.get("widget.list")
	const query = list?.query
	const conventions = list?.conventions
	return [
		["x-query resolves the filter grammar", "the comment claims postgrest", conventions?.grammar, "postgrest"],
		["x-query declares filterable fields", "not guessed from the schema", query?.source, "tag"],
		["x-query accepts structured filterable rows", "declared-or-skip catalog", query?.filterFields?.[0]?.field, "id"],
		["x-query sets maxLimit", "used to bound page-size probes", query?.maxLimit, 100],
		["limit resolves as page size", "distinguished by maximum + default", conventions?.limit, "limit"],
		["cursor role resolves", "declared alongside page", conventions?.cursor, "cursor"],
		["x-tenant is declared, not inferred", "decides SECURITY vs AMBIGUITY", list?.tenantSource, "tag"],
	]
}

/** What the comments claim about every other operation. */
function otherExpectations(model: Model): Expectation[] {
	const create = model.byOperationId.get("widget.create")
	const update = model.byOperationId.get("widget.update")
	const start = model.byOperationId.get("export.start")
	const widgetRead = model.byOperationId.get("widget.read")
	const templateRead = model.byOperationId.get("template.read")
	return [
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
}

function judged([name, why, actual, expected]: Expectation): ParserResult {
	const ok = JSON.stringify(actual) === JSON.stringify(expected)
	return {
		detail: ok ? `${JSON.stringify(actual)}` : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
		name,
		ok,
		why,
	}
}

/** Checks the document at `path`: the annotated example, unless a test brings another. */
export async function runExampleSpecSuite(
	path = new URL("../../../labs/annotated-openapi.yaml", import.meta.url).pathname,
): Promise<ParserResult[]> {
	let model: Model
	try {
		model = buildModel(dereference(await loadSpec(path)).doc)
	} catch (error) {
		const why = "the documented example must be a parseable OpenAPI document"
		return [{ detail: messageOf(error), name: "annotated-openapi.yaml", ok: false, why }]
	}
	return [...listExpectations(model), ...otherExpectations(model)].map(judged)
}
