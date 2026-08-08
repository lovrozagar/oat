import { readFile } from "node:fs/promises"
import type { OpenApiDocument } from "./types.ts"

/** Loads a spec from an http(s) URL or a filesystem path. */
export async function loadSpec(source: string): Promise<OpenApiDocument> {
	const text = /^https?:\/\//.test(source)
		? await fetchText(source)
		: await readFile(source, "utf8")
	try {
		return JSON.parse(text) as OpenApiDocument
	} catch {
		throw new Error(
			`oat: could not parse ${source} as JSON. YAML specs must be converted first ` +
				"(oat keeps its dependency surface minimal on purpose).",
		)
	}
}

async function fetchText(url: string): Promise<string> {
	const res = await fetch(url, { headers: { accept: "application/json" } })
	if (!res.ok) throw new Error(`oat: fetching ${url} returned ${res.status} ${res.statusText}`)
	return res.text()
}

/**
 * Resolves internal `$ref`s in place, sharing object identity for repeated refs so the result
 * stays compact. Cycles are preserved as shared references rather than expanded — AJV handles
 * recursive schemas natively, and expanding them would not terminate.
 *
 * External refs are left untouched and reported by the caller as a coverage gap: resolving them
 * would mean fetching arbitrary URLs, which a test tool should not do implicitly.
 */
export function dereference(doc: OpenApiDocument): {
	doc: OpenApiDocument
	externalRefs: string[]
} {
	const externalRefs = new Set<string>()
	const resolving = new Map<string, unknown>()

	function resolvePointer(ref: string): unknown {
		const path = ref.slice(2).split("/").map(decodeSegment)
		let node: unknown = doc
		for (const seg of path) {
			if (node === null || typeof node !== "object") return undefined
			node = (node as Record<string, unknown>)[seg]
		}
		return node
	}

	function walk(node: unknown): unknown {
		if (Array.isArray(node)) return node.map(walk)
		if (node === null || typeof node !== "object") return node

		const obj = node as Record<string, unknown>
		const ref = obj.$ref
		if (typeof ref === "string") {
			if (!ref.startsWith("#/")) {
				externalRefs.add(ref)
				return node
			}
			const cached = resolving.get(ref)
			if (cached !== undefined) return cached
			const target = resolvePointer(ref)
			if (target === undefined) {
				throw new Error(`oat: unresolvable $ref ${ref}`)
			}
			/* Placeholder registered before recursing so a cycle lands on this same object
			 * instead of recursing forever. */
			const placeholder: Record<string, unknown> = {}
			resolving.set(ref, placeholder)
			const resolved = walk(target)
			Object.assign(placeholder, resolved as Record<string, unknown>)
			/* Sibling keys alongside $ref (OpenAPI 3.1 allows this) override the target. */
			for (const [k, v] of Object.entries(obj)) {
				if (k !== "$ref") placeholder[k] = walk(v)
			}
			return placeholder
		}

		const out: Record<string, unknown> = {}
		for (const [k, v] of Object.entries(obj)) out[k] = walk(v)
		return out
	}

	return { doc: walk(doc) as OpenApiDocument, externalRefs: [...externalRefs] }
}

function decodeSegment(seg: string): string {
	return seg.replace(/~1/g, "/").replace(/~0/g, "~")
}

/** Normalises `/things/:id` to `/things/{id}` so both path syntaxes compare equal. */
export function normalisePath(path: string): string {
	return path.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, "{$1}")
}

/** `"GET /things/:id"` → `{ method: "GET", path: "/things/{id}" }` */
export function parseRouteRef(ref: string): { method: string; path: string } | null {
	const match = /^\s*([A-Za-z]+)\s+(\S+)\s*$/.exec(ref)
	if (!match?.[1] || !match[2]) return null
	return { method: match[1].toUpperCase(), path: normalisePath(match[2]) }
}
