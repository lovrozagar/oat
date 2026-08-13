import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import type { OpenApiDocument } from "./types.ts"

/**
 * Loads a specification from wherever it lives, in JSON or YAML.
 *
 * Three forms are accepted, resolved in a fixed order so the outcome never depends on a guess
 * about what the string "looks like":
 *
 *   1. an absolute `http(s)://` or `file://` URL — used as given
 *   2. a path that exists on disk — read as a file, relative to the working directory
 *   3. anything else, when a base URL is known — resolved against it, so `/v1/openapi/spec`
 *      and `openapi.json` both work next to `baseUrl`
 *
 * When none apply the error names every location that was tried, rather than reporting the last
 * failure as though it were the only attempt.
 */
export async function loadSpec(source: string, baseUrl?: string): Promise<OpenApiDocument> {
	const text = await readSpecSource(source, baseUrl)

	if (text.trim() === "") {
		throw new Error(`oat: ${source} is empty`)
	}

	if (looksLikeJson(text)) {
		try {
			return JSON.parse(text) as OpenApiDocument
		} catch (error) {
			throw new Error(
				`oat: ${source} starts as JSON but does not parse: ${
					error instanceof Error ? error.message : String(error)
				}. ${diagnoseJson(text)}`,
			)
		}
	}

	try {
		const { parse } = await import("yaml")
		return parse(text) as OpenApiDocument
	} catch (error) {
		throw new Error(
			`oat: could not parse ${source} as JSON or YAML: ${
				error instanceof Error ? error.message : String(error)
			}`,
		)
	}
}

function looksLikeJson(text: string): boolean {
	const first = text.trimStart()[0]
	return first === "{" || first === "["
}

/**
 * Distinguishes a malformed document from a truncated one. A spec cut short by a proxy or a
 * download limit is by far the most common cause, and reporting it as invalid syntax sends
 * people looking for a bug in a file that is actually fine.
 */
function diagnoseJson(text: string): string {
	const opens = (text.match(/[[{]/g) ?? []).length
	const closes = (text.match(/[\]}]/g) ?? []).length
	if (opens > closes) {
		return (
			`The document has ${opens - closes} more opening than closing brackets, so it is most ` +
			`likely truncated — it ends after ${text.length} bytes. Check for a download or proxy ` +
			"size limit."
		)
	}
	return "The document appears complete, so this is a syntax error rather than truncation."
}

async function readSpecSource(source: string, baseUrl?: string): Promise<string> {
	if (/^https?:\/\//.test(source)) return fetchText(source)
	if (source.startsWith("file://")) return readFile(fileURLToPath(source), "utf8")

	const attempted: string[] = []

	/* A real file wins over a route: a spec checked into the repository is the more specific
	 * intent, and silently fetching instead would hide a typo in the path. */
	const asPath = resolve(process.cwd(), source)
	attempted.push(asPath)
	try {
		return await readFile(asPath, "utf8")
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
	}

	if (baseUrl !== undefined && baseUrl !== "") {
		const resolved = new URL(source, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`).toString()
		attempted.push(resolved)
		return fetchText(resolved)
	}

	throw new Error(
		`oat: could not find a specification at "${source}". Tried:\n` +
			attempted.map((a) => `  ${a}`).join("\n") +
			(baseUrl === undefined
				? "\nPass --base-url (or set baseUrl in the config) to resolve it as a route."
				: ""),
	)
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
