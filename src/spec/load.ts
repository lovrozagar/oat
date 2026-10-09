import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { DEFAULT_NETWORK_RETRIES, type NetworkFetchOptions, fetchWithNetworkRetry } from "../runtime/network.ts"
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
export async function loadSpec(
	source: string,
	baseUrl?: string,
	network?: NetworkFetchOptions,
): Promise<OpenApiDocument> {
	/* A byte-order mark is not part of the document; JSON.parse rejects it outright. */
	const text = (await readSpecSource(source, baseUrl, network)).replace(/^\uFEFF/, "")

	if (text.trim() === "") {
		throw new Error(`oat: ${source} is empty`)
	}

	let parsed: unknown
	if (looksLikeJson(text)) {
		try {
			parsed = JSON.parse(text)
		} catch (error) {
			throw new Error(
				`oat: ${source} starts as JSON but does not parse: ${
					error instanceof Error ? error.message : String(error)
				}. ${diagnoseJson(text)}`,
				{ cause: error },
			)
		}
	} else {
		try {
			const { parse } = await import("yaml")
			parsed = parse(text)
		} catch (error) {
			throw new Error(
				`oat: could not parse ${source} as JSON or YAML: ${error instanceof Error ? error.message : String(error)}`,
				{ cause: error },
			)
		}
	}
	return assertOpenApi(parsed, source)
}

/**
 * Accepts an OpenAPI 3.x document and nothing else.
 *
 * YAML parses almost any text — a `Not Found` page is a valid YAML string — so "it parsed" says
 * nothing about whether this is a document oat can test. Accepting it produced a run that graded
 * zero operations and reported success.
 */
export function assertOpenApi(parsed: unknown, source: string): OpenApiDocument {
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		const shown = typeof parsed === "string" ? JSON.stringify(parsed.slice(0, 60)) : String(parsed)
		throw new Error(`oat: ${source} is not an OpenAPI document — it parsed as ${shown}`)
	}
	const doc = parsed as Record<string, unknown>
	if (typeof doc.swagger === "string") {
		throw new Error(`oat: ${source} is Swagger ${doc.swagger}; oat reads OpenAPI 3.x — convert it first`)
	}
	if (typeof doc.openapi !== "string" || !/^3\.\d+(\.\d+)?/.test(doc.openapi)) {
		throw new Error(`oat: ${source} has no "openapi: 3.x" version field, so it is not an OpenAPI 3 document`)
	}
	if (doc.paths === null || typeof doc.paths !== "object" || Array.isArray(doc.paths)) {
		throw new Error(`oat: ${source} has no "paths" object, so there is nothing to test`)
	}
	return doc as OpenApiDocument
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

async function readSpecSource(source: string, baseUrl?: string, network?: NetworkFetchOptions): Promise<string> {
	if (/^https?:\/\//.test(source)) return fetchText(source, network)
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
		return fetchText(resolved, network)
	}

	throw new Error(
		`oat: could not find a specification at "${source}". Tried:\n` +
			attempted.map((a) => `  ${a}`).join("\n") +
			(baseUrl === undefined ? "\nPass --base-url (or set baseUrl in the config) to resolve it as a route." : ""),
	)
}

async function fetchText(url: string, network?: NetworkFetchOptions): Promise<string> {
	const res = await fetchWithNetworkRetry(
		url,
		{ headers: { accept: "application/json" } },
		{ retries: DEFAULT_NETWORK_RETRIES, waitMs: 0, ...network },
	)
	if (!res.ok) throw new Error(`oat: fetching ${url} returned ${res.status} ${res.statusText}`)
	return res.text()
}

/** Where recursive schemas live after dereferencing: `$ref: "oat-defs#/$defs/<name>"`. */
export const DEFS_ID = "oat-defs"
export const DEFS_KEY = "x-oat-defs"

/** The recursive schemas a dereferenced document refers to, by name. Empty when there are none. */
export function documentDefs(doc: OpenApiDocument): Record<string, Record<string, unknown>> {
	const defs = (doc as Record<string, unknown>)[DEFS_KEY]
	return defs !== null && typeof defs === "object" ? (defs as Record<string, Record<string, unknown>>) : {}
}

/**
 * Resolves internal `$ref`s, producing a document with no references left in it except the ones
 * that must stay: external refs, reported by the caller as a coverage gap, and refs that would
 * otherwise recurse forever.
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
} {
	const externalRefs = new Set<string>()
	/* source object → its resolved output, so a node is resolved once wherever it is reached */
	const memo = new Map<object, unknown>()
	/* source nodes whose output is still being built: reaching one again is a cycle, whether it
	 * was entered through a $ref or walked directly as part of `components` */
	const building = new Set<object>()
	const defNames = new Map<string, string>()
	const defs: Record<string, unknown> = {}

	function resolvePointer(ref: string): unknown {
		if (ref === "#" || ref === "#/") return doc
		const path = ref.slice(2).split("/").map(decodeSegment)
		let node: unknown = doc
		for (const seg of path) {
			if (node === null || typeof node !== "object") return undefined
			if (!Object.hasOwn(node, seg)) return undefined
			node = (node as Record<string, unknown>)[seg]
		}
		return node
	}

	function defName(ref: string): string {
		const existing = defNames.get(ref)
		if (existing !== undefined) return existing
		const base = (decodeSegment(ref.split("/").at(-1) ?? "") || "schema").replace(/[^\w.-]/g, "_")
		let name = base
		for (let n = 2; Object.values(Object.fromEntries(defNames)).includes(name); n++) name = `${base}_${n}`
		defNames.set(ref, name)
		return name
	}

	function walkRef(obj: Record<string, unknown>, ref: string): unknown {
		const internal = ref === "#" || ref === "#/" || ref.startsWith("#/")
		if (!internal) {
			externalRefs.add(ref)
			return obj
		}
		const target = resolvePointer(ref)
		if (target === undefined) throw new Error(`oat: unresolvable $ref ${ref}`)
		if (target !== null && typeof target === "object" && building.has(target)) {
			return { $ref: `${DEFS_ID}#/$defs/${defName(ref)}` }
		}
		const resolved = walk(target)
		const siblings = Object.entries(obj).filter(([key]) => key !== "$ref")
		if (siblings.length === 0) return resolved
		const base = resolved !== null && typeof resolved === "object" && !Array.isArray(resolved) ? resolved : {}
		const out: Record<string, unknown> = { ...(base as Record<string, unknown>) }
		for (const [key, value] of siblings) out[key] = walk(value)
		return out
	}

	/**
	 * `mode` says what the node is: ordinary document structure, data that is never resolved
	 * (an `example`, a schema's `examples` array), or an Example Object, whose `value` is data.
	 */
	function walk(node: unknown, mode: "node" | "data" | "example" = "node"): unknown {
		if (node === null || typeof node !== "object" || mode === "data") return node
		const cached = mode === "node" ? memo.get(node) : undefined
		if (cached !== undefined) return cached
		if (Array.isArray(node)) {
			const out: unknown[] = []
			memo.set(node, out)
			building.add(node)
			for (const item of node) out.push(walk(item))
			building.delete(node)
			return out
		}
		const obj = node as Record<string, unknown>
		if (typeof obj.$ref === "string") {
			/* Not memoized by node: whether a ref recurses depends on the path that reached it. */
			return walkRef(obj, obj.$ref)
		}
		const out: Record<string, unknown> = {}
		if (mode === "node") memo.set(node, out)
		building.add(node)
		for (const [key, value] of Object.entries(obj)) {
			if (key === "example" || (mode === "example" && key === "value")) out[key] = value
			else if (key === "examples" && Array.isArray(value)) out[key] = value
			else if (key === "examples" && value !== null && typeof value === "object") {
				/* A map of Example Objects: each may be a $ref, and each one's `value` is data. */
				const examples: Record<string, unknown> = {}
				for (const [name, example] of Object.entries(value as Record<string, unknown>)) {
					examples[name] = walk(example, "example")
				}
				out[key] = examples
			} else out[key] = walk(value)
		}
		building.delete(node)
		return out
	}

	const out = walk(doc) as OpenApiDocument
	/* Each recursive schema, stored once by name. Its body is the completed output for the
	 * target node, whose own self-references are already `$ref`s into these definitions. */
	for (const [ref, name] of defNames) {
		const target = resolvePointer(ref)
		const body = target !== null && typeof target === "object" ? (memo.get(target) ?? walk(target)) : target
		/* `$ref: "#"` names the document itself, which is about to carry these definitions: store a
		 * copy without them, or the definitions would contain themselves. */
		defs[name] = body === out ? { ...out } : body
	}
	if (Object.keys(defs).length > 0) (out as Record<string, unknown>)[DEFS_KEY] = defs
	return { doc: out, externalRefs: [...externalRefs] }
}

/** A JSON pointer segment: `~1` and `~0` escapes, then percent-encoding (`%7Bid%7D`). */
function decodeSegment(seg: string): string {
	const unescaped = seg.replace(/~1/g, "/").replace(/~0/g, "~")
	try {
		return decodeURIComponent(unescaped)
	} catch {
		return unescaped
	}
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

/** `{param}` and `:param` segments match one path component. */
export function pathTemplateMatches(template: string, pathname: string): boolean {
	const compiled = normalisePath(template)
		.split("/")
		.map((segment) => {
			if (segment.startsWith("{") && segment.endsWith("}")) return "[^/]+"
			return segment.replace(/[.+^${}()|[\]\\]/g, "\\$&")
		})
		.join("/")
	return new RegExp(`^${compiled}$`).test(pathname)
}
