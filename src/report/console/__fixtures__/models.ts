import { createMemoryReference } from "../../../reference/http/engines.ts"
import type { ReferenceOptions } from "../../../reference/http/state.ts"
import { probeCreateFixtures } from "../../../runtime/world/probe-fixtures.ts"
import { applyGrammarOverrides, type GrammarConfig } from "../../../spec/grammar-overrides.ts"
import { buildModel } from "../../../spec/graph/build.ts"
import type { SpecModel } from "../../../spec/graph/types.ts"
import { dereference } from "../../../spec/load/dereference.ts"
import { prepareDocument } from "../../../spec/prepare.ts"
import type { OpenApiDocument } from "../../../spec/types.ts"

/* Documents as `oat doctor` and `oat plan` model them: the reference's own, served in process, and small hand-built ones. */

export interface Modeled {
	model: SpecModel
	externalRefs: string[]
}

/** A document modeled the way the CLI models it. */
export function modelOf(doc: unknown, grammars?: GrammarConfig): Modeled {
	const { doc: resolved, externalRefs } = dereference(prepareDocument(doc as OpenApiDocument, {}, () => {}))
	const model = buildModel(resolved)
	if (grammars !== undefined) applyGrammarOverrides(model, grammars)
	probeCreateFixtures(model)
	return { externalRefs, model }
}

/** The reference backend's document for these options, read over its in-process transport. */
export async function referenceModel(options: ReferenceOptions = {}): Promise<Modeled> {
	const ref = await createMemoryReference(options)
	try {
		const get = ref.fetch
		const raw: unknown = await (await get(`${ref.url}/v1/openapi/spec`)).json()
		return modelOf(raw)
	} finally {
		await ref.close()
	}
}

/** A document holding `paths`, with anything else `extra` adds at its root. */
export function documentOf(paths: Record<string, unknown>, extra: Record<string, unknown> = {}): unknown {
	return { info: { title: "t", version: "1" }, openapi: "3.1.0", paths, ...extra }
}

const ok = (schema?: unknown) => ({
	"200": { content: { "application/json": { schema: schema ?? { type: "object" } } }, description: "ok" },
})

/** A list operation for `entity` at `path`, with what `extra` declares on it. */
export function listOp(entity: string, operationId: string, extra: Record<string, unknown> = {}): unknown {
	return {
		operationId,
		parameters: [{ in: "query", name: "filter", schema: { type: "string" } }],
		responses: ok({ items: { properties: { id: { type: "string" } }, type: "object" }, type: "array" }),
		"x-entity": { action: "list", name: entity },
		...extra,
	}
}

/** A read of one `entity` by id, with what `extra` declares on it. */
export function readOp(entity: string, operationId: string, extra: Record<string, unknown> = {}): unknown {
	return {
		operationId,
		parameters: [{ in: "path", name: "id", required: true, schema: { type: "string" } }],
		responses: ok({ properties: { id: { type: "string" } }, type: "object" }),
		"x-entity": { action: "read", identity: "id", name: entity },
		...extra,
	}
}

/** A filter grammar written as a template, and a sort grammar likewise. */
export const FILTER_TEMPLATE = {
	conj: { and: "and" },
	ops: { eq: "eq", neq: "ne" },
	term: "{conj}_{field}_{op}_{value}",
}
export const SORT_TEMPLATE = { asc: "ascending", desc: "descending", join: ",", term: "{field}_{direction}" }
