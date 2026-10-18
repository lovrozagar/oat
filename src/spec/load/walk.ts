/**
 * The walk `dereference` runs: every source node maps to exactly one output node, internal refs
 * are inlined, and a ref that would recurse becomes a ref into the definitions.
 */

import type { OpenApiDocument } from "../types.ts"
import { DEFS_ID } from "./defs.ts"
import { decodeSegment, resolvePointer } from "./pointer.ts"

/** One dereference in progress. */
export interface Dereferencing {
	doc: OpenApiDocument
	/** External refs met, reported by the caller as a coverage gap. */
	externalRefs: Set<string>
	/** source object → its resolved output, so a node is resolved once wherever it is reached */
	memo: Map<object, unknown>
	/** source nodes whose output is still being built: reaching one again is a cycle, whether it
	 * was entered through a $ref or walked directly as part of `components` */
	building: Set<object>
	/** Each recursive ref, by the definition name it is stored under. */
	defNames: Map<string, string>
}

/**
 * `mode` says what the node is: ordinary document structure, or an Example Object, whose `value`
 * is data. Data (an `example`, a schema's `examples` array) is copied, never walked.
 */
type Mode = "node" | "example"

export function walk(ctx: Dereferencing, node: unknown, mode: Mode = "node"): unknown {
	if (node === null || typeof node !== "object") return node
	const cached = mode === "node" ? ctx.memo.get(node) : undefined
	if (cached !== undefined) return cached
	if (Array.isArray(node)) return walkArray(ctx, node)
	const obj = node as Record<string, unknown>
	/* Not memoized by node: whether a ref recurses depends on the path that reached it. */
	if (typeof obj.$ref === "string") return walkRef(ctx, obj, obj.$ref)
	return walkObject(ctx, obj, mode)
}

function walkArray(ctx: Dereferencing, node: unknown[]): unknown[] {
	const out: unknown[] = []
	ctx.memo.set(node, out)
	ctx.building.add(node)
	for (const item of node) out.push(walk(ctx, item))
	ctx.building.delete(node)
	return out
}

function walkObject(ctx: Dereferencing, obj: Record<string, unknown>, mode: Mode): Record<string, unknown> {
	const out: Record<string, unknown> = {}
	if (mode === "node") ctx.memo.set(obj, out)
	ctx.building.add(obj)
	for (const [key, value] of Object.entries(obj)) out[key] = walkEntry(ctx, key, value, mode)
	ctx.building.delete(obj)
	return out
}

function walkEntry(ctx: Dereferencing, key: string, value: unknown, mode: Mode): unknown {
	if (key === "example" || (mode === "example" && key === "value")) return value
	if (key === "examples" && Array.isArray(value)) return value
	if (key === "examples" && value !== null && typeof value === "object") {
		/* A map of Example Objects: each may be a $ref, and each one's `value` is data. */
		const examples: Record<string, unknown> = {}
		for (const [name, example] of Object.entries(value)) examples[name] = walk(ctx, example, "example")
		return examples
	}
	return walk(ctx, value)
}

function walkRef(ctx: Dereferencing, obj: Record<string, unknown>, ref: string): unknown {
	if (ref !== "#" && !ref.startsWith("#/")) {
		ctx.externalRefs.add(ref)
		return obj
	}
	const target = resolvePointer(ctx.doc, ref)
	if (target === undefined) throw new Error(`oat: unresolvable $ref ${ref}`)
	if (target !== null && typeof target === "object" && ctx.building.has(target)) {
		return { $ref: `${DEFS_ID}#/$defs/${defName(ctx, ref)}` }
	}
	const resolved = walk(ctx, target)
	const siblings = Object.entries(obj).filter(([key]) => key !== "$ref")
	if (siblings.length === 0) return resolved
	const base = resolved !== null && typeof resolved === "object" && !Array.isArray(resolved) ? resolved : {}
	const out: Record<string, unknown> = { ...(base as Record<string, unknown>) }
	for (const [key, value] of siblings) out[key] = walk(ctx, value)
	return out
}

function defName(ctx: Dereferencing, ref: string): string {
	const existing = ctx.defNames.get(ref)
	if (existing !== undefined) return existing
	/* `split` always yields at least one segment. */
	const base = (decodeSegment(ref.split("/").at(-1) as string) || "schema").replace(/[^\w.-]/g, "_")
	const taken = new Set(ctx.defNames.values())
	let name = base
	for (let n = 2; taken.has(name); n++) name = `${base}_${n}`
	ctx.defNames.set(ref, name)
	return name
}
