import type { OpenApiDocument } from "../types.ts"
import { EXTERNAL_KEY } from "./bundle.ts"
import { DEFS_KEY } from "./defs.ts"
import { resolvePointer } from "./pointer.ts"
import { type Dereferencing, walk } from "./walk.ts"

/**
 * Resolves internal `$ref`s, producing a document with no references left in it except the ones
 * that must stay: external refs, reported by the caller as a coverage gap, and refs that would
 * otherwise recurse forever. A ref that points at nothing becomes a `DANGLING_KEY` node, also
 * reported, which the model reads operation by operation.
 *
 * Every source node maps to exactly one output node, so the result is the same whatever order the
 * document lists its keys in — `components` before `paths` or after. Sibling keys beside a `$ref`
 * (OpenAPI 3.1) apply to that use site only and never leak onto the shared target. Data is left
 * alone: a `$ref` inside an `example` is an example, not a reference.
 *
 * A schema that refers to itself, directly or through others, cannot be inlined: the result would
 * be a cyclic object that no serializer can print and no generator can bound. Such a reference
 * becomes `$ref: "oat-defs#/$defs/<name>"` and the schema is stored once under `x-oat-defs`, which
 * the validator registers with AJV and the generator follows to a bounded depth.
 */
export function dereference(doc: OpenApiDocument): {
	doc: OpenApiDocument
	externalRefs: string[]
	danglingRefs: string[]
} {
	const state: Dereferencing = {
		building: new Set(),
		danglingRefs: new Set(),
		defNames: new Map(),
		doc,
		externalRefs: new Set(),
		memo: new Map(),
	}
	const out = walk(state, doc) as OpenApiDocument
	const defs = recursiveSchemas(state, out)
	/* Every ref into the bundled files is inlined or stored in the definitions by now. */
	delete (out as Record<string, unknown>)[EXTERNAL_KEY]
	if (Object.keys(defs).length > 0) (out as Record<string, unknown>)[DEFS_KEY] = defs
	return { danglingRefs: [...state.danglingRefs], doc: out, externalRefs: [...state.externalRefs] }
}

/**
 * Each recursive schema, stored once by name. Its body is the completed output for the target
 * node, whose own self-references are already `$ref`s into these definitions.
 */
function recursiveSchemas(state: Dereferencing, out: OpenApiDocument): Record<string, unknown> {
	const defs: Record<string, unknown> = {}
	for (const [ref, name] of state.defNames) {
		/* A name is only given to a target that was being built, which is always an object. */
		const target = resolvePointer(state.doc, ref) as object
		/* An Example Object is walked without a memo entry, so a cycle through one walks it again. */
		const body = state.memo.get(target) ?? walk(state, target)
		/* `$ref: "#"` names the document itself, which is about to carry these definitions: store a
		 * copy without them, or the definitions would contain themselves. */
		defs[name] = body === out ? { ...out } : body
	}
	return defs
}
