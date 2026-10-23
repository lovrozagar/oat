/**
 * Local-file `$ref`s, read into the one document so `dereference` meets only internal refs. Each
 * file is stored once under `x-oat-external`, keyed by its path in the document's folder, and every
 * ref to it, its own `#/` refs included, becomes a pointer there.
 */

import { readFile, realpath } from "node:fs/promises"
import { dirname, isAbsolute, relative, resolve, sep } from "node:path"
import { UsageError } from "../../errors/usage-error.ts"
import type { JsonSchema, OpenApiDocument } from "../types.ts"
import { parseText } from "./parse.ts"

/** Where the files a document refers to are stored, by their path in its folder. */
export const EXTERNAL_KEY = "x-oat-external"

/** One bundling in progress. */
interface Bundling {
	/** The document's real path. */
	root: string
	/** Its real folder: no ref may resolve outside it, through `..` or a symlink alike. */
	folder: string
	/** Each file read, by real path, as its key under `EXTERNAL_KEY`. */
	keys: Map<string, string>
	files: Record<string, unknown>
}

/** Nodes met while collecting refs: a YAML alias reaches one node twice, or loops back. */
interface Collecting {
	seen: Set<object>
	holders: JsonSchema[]
}

/**
 * Reads every file `doc`, read from `sourcePath`, refers to by relative path, recursively. A URL
 * ref, an anchor and a ref in a fetched document stay as they are, reported as unresolved. A ref by
 * absolute path, one resolving outside the document's folder, or one naming a missing file is
 * the caller's to fix.
 */
export async function bundleLocalRefs(doc: OpenApiDocument, sourcePath: string): Promise<OpenApiDocument> {
	const root = await realpath(sourcePath)
	const ctx: Bundling = { files: {}, folder: dirname(root), keys: new Map(), root }
	await rewriteRefs(ctx, doc, root)
	if (ctx.keys.size > 0) (doc as Record<string, unknown>)[EXTERNAL_KEY] = ctx.files
	return doc
}

async function rewriteRefs(ctx: Bundling, node: unknown, file: string): Promise<void> {
	const found: Collecting = { holders: [], seen: new Set() }
	collect(found, node, "node")
	for (const holder of found.holders) holder.$ref = await rewrite(ctx, holder.$ref as string, file)
}

/* Mirrors `walk`: an `example`, a schema's `examples` array and an Example Object's `value` are data. */
function collect(ctx: Collecting, node: unknown, mode: "node" | "example"): void {
	if (node === null || typeof node !== "object" || ctx.seen.has(node)) return
	ctx.seen.add(node)
	if (Array.isArray(node)) {
		for (const item of node) collect(ctx, item, "node")
		return
	}
	const obj = node as JsonSchema
	if (typeof obj.$ref === "string") ctx.holders.push(obj)
	for (const [key, value] of Object.entries(obj)) collectEntry(ctx, key, value, mode)
}

function collectEntry(ctx: Collecting, key: string, value: unknown, mode: "node" | "example"): void {
	if (key === "example" || (mode === "example" && key === "value")) return
	if (key !== "examples") return collect(ctx, value, "node")
	/* A map of Example Objects: each may be a $ref, and each one's `value` is data. */
	if (value !== null && typeof value === "object" && !Array.isArray(value)) {
		for (const example of Object.values(value)) collect(ctx, example, "example")
	}
}

/** `ref`, met in `file`, as a pointer into the bundled document; read its file when first named. */
async function rewrite(ctx: Bundling, ref: string, file: string): Promise<string> {
	const hash = ref.indexOf("#")
	const path = hash === -1 ? ref : ref.slice(0, hash)
	const fragment = hash === -1 ? "" : ref.slice(hash + 1)
	if (fragment !== "" && !fragment.startsWith("/")) return ref
	if (path === "") return pointer(ctx, file, fragment)
	if (isAbsolute(path) || /^file:/i.test(path)) {
		throw new UsageError(
			`oat: ${file} refers to ${ref}, an absolute path; oat reads only paths relative to the document`,
		)
	}
	if (/^[a-z][a-z\d+.-]*:/i.test(path)) return ref
	const target = await realOf(resolve(dirname(file), decoded(path)), ref, file)
	const inFolder = relative(ctx.folder, target)
	if (inFolder.split(sep)[0] === ".." || isAbsolute(inFolder)) {
		throw new UsageError(
			`oat: ${file} refers to ${ref}, which resolves outside ${ctx.folder}; oat reads only files in the document's folder`,
		)
	}
	if (target !== ctx.root && !ctx.keys.has(target)) {
		ctx.keys.set(target, inFolder.split(sep).join("/"))
		const parsed = await parseText(await readFile(target, "utf8"), target)
		ctx.files[inFolder.split(sep).join("/")] = parsed
		await rewriteRefs(ctx, parsed, target)
	}
	return pointer(ctx, target, fragment)
}

/** The pointer to `fragment` inside `file`: the document itself, or its entry under `EXTERNAL_KEY`. */
function pointer(ctx: Bundling, file: string, fragment: string): string {
	if (file === ctx.root) return `#${fragment}`
	const key = (ctx.keys.get(file) as string).replace(/~/g, "~0").replace(/\//g, "~1").replace(/%/g, "%25")
	return `#/${EXTERNAL_KEY}/${key}${fragment}`
}

async function realOf(target: string, ref: string, file: string): Promise<string> {
	try {
		return await realpath(target)
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
		throw new UsageError(`oat: ${file} refers to ${ref}, but ${target} does not exist`)
	}
}

/* A ref is a URI reference: `my%20file.yaml` names "my file.yaml". A malformed escape is literal. */
function decoded(path: string): string {
	try {
		return decodeURIComponent(path)
	} catch {
		return path
	}
}
