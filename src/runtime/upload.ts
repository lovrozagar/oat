/**
 * Resolves a file part: hook, then pool, then a dummy. Missing pool paths warn once
 * and fall through — a bad glob must not crash a run.
 */

import { readdir, readFile, stat } from "node:fs/promises"
import { basename, dirname, join, relative, resolve, sep } from "node:path"
import type { Hooks, UploadFile, UploadRequest, UploadResolution, Uploads } from "../config/define-config.ts"
import { dummyFile, mediaTypeOfExtension, mediaTypesCompatible, sniffMediaType } from "./dummy.ts"
import { mulberry32 } from "./fixture.ts"

export interface UploadContext {
	seed: number
	uploads?: Uploads
	configDir?: string
	resolveUpload?: Hooks["resolveUpload"]
	resolveInput?: Hooks["resolveInput"]
	warn?: (message: string) => void
}

const warned = new Set<string>()

export async function resolveUploadFile(request: UploadRequest, context: UploadContext): Promise<UploadFile> {
	const hook = context.resolveUpload
	if (hook !== undefined) {
		const resolved = await hook(request)
		if (isUploadFile(resolved)) return resolved
		/* `{ fields }` is handled by the body encoder, which calls the hook first. */
	}

	const fromPool = await pickFromPool(request, context)
	if (fromPool !== undefined) return fromPool

	const dummy: Parameters<typeof dummyFile>[0] = {
		field: request.field,
		index: request.index,
		seed: context.seed,
		variant: request.variant,
	}
	if (request.contentMediaType !== undefined) dummy.contentMediaType = request.contentMediaType
	if (request.filename !== undefined) dummy.filename = request.filename
	return dummyFile(dummy)
}

export async function resolveUploadOverride(request: UploadRequest, context: UploadContext): Promise<UploadResolution> {
	if (context.resolveUpload === undefined) return null
	return context.resolveUpload(request)
}

export function isUploadFile(value: unknown): value is UploadFile {
	if (value === null || typeof value !== "object") return false
	const record = value as Record<string, unknown>
	return (
		record.bytes instanceof Uint8Array && typeof record.filename === "string" && typeof record.mediaType === "string"
	)
}

export function isFieldOverride(value: unknown): value is { fields: Record<string, string | UploadFile> } {
	if (value === null || typeof value !== "object") return false
	return (
		"fields" in value &&
		(value as { fields: unknown }).fields !== null &&
		typeof (value as { fields: unknown }).fields === "object"
	)
}

interface PoolEntry {
	path: string
	bytes: Uint8Array
	filename: string
	mediaType: string
}

let poolCache: { key: string; entries: PoolEntry[] } | undefined

async function pickFromPool(request: UploadRequest, context: UploadContext): Promise<UploadFile | undefined> {
	const patterns = context.uploads?.pool
	if (patterns === undefined || patterns.length === 0) return undefined

	const root = context.configDir ?? process.cwd()
	const entries = await loadPool(patterns, root, context.warn)
	const matching = entries.filter((entry) => matchesPart(entry, request))
	if (matching.length === 0) return undefined

	const picked = stablePick(matching, context.seed, request.field, request.index)
	if (picked === undefined) return undefined
	return { bytes: picked.bytes, filename: picked.filename, mediaType: picked.mediaType }
}

function matchesPart(entry: PoolEntry, request: UploadRequest): boolean {
	const declared = request.contentMediaType
	if (mediaTypesCompatible(declared, entry.mediaType)) {
		if (declared !== undefined && declared !== "" && declared !== "application/octet-stream") return true
	}
	if (request.filename !== undefined) {
		const want = extOf(request.filename)
		if (want !== "" && want === extOf(entry.filename)) return true
	}
	if (declared === undefined || declared === "" || declared === "application/octet-stream") return true
	return false
}

function stablePick<T>(items: T[], seed: number, field: string, index: number): T | undefined {
	if (items.length === 0) return undefined
	const rand = mulberry32(hash32(`${seed}\0${field}\0${index}`))
	/* Fisher–Yates with the seeded RNG so the same seed always picks the same file. */
	const copy = [...items]
	for (let i = copy.length - 1; i > 0; i--) {
		const j = Math.floor(rand() * (i + 1))
		const a = copy[i]
		const b = copy[j]
		if (a === undefined || b === undefined) continue
		copy[i] = b
		copy[j] = a
	}
	return copy[0]
}

async function loadPool(patterns: string[], root: string, warn?: (message: string) => void): Promise<PoolEntry[]> {
	const key = `${root}\0${patterns.join("\0")}`
	if (poolCache?.key === key) return poolCache.entries

	const paths = new Set<string>()
	for (const pattern of patterns) {
		const matches = await expandPattern(pattern, root, warn)
		for (const path of matches) paths.add(path)
	}

	const entries: PoolEntry[] = []
	for (const path of [...paths].sort()) {
		try {
			const bytes = new Uint8Array(await readFile(path))
			const filename = basename(path)
			const sniffed = sniffMediaType(bytes, filename)
			const byExt = mediaTypeOfExtension(extOf(filename))
			entries.push({
				bytes,
				filename,
				mediaType: sniffed ?? byExt ?? "application/octet-stream",
				path,
			})
		} catch {
			warnOnce(`uploads.pool could not read ${path}`, warn)
		}
	}

	poolCache = { entries, key }
	return entries
}

/** Tests may clear the cache when they rewrite fixtures. */
export function resetUploadPool(): void {
	poolCache = undefined
	warned.clear()
}

async function expandPattern(pattern: string, root: string, warn?: (message: string) => void): Promise<string[]> {
	const absolute = resolve(root, pattern)
	try {
		const info = await stat(absolute)
		if (info.isFile()) return [absolute]
		if (info.isDirectory()) return walkFiles(absolute)
	} catch {
		/* Not a literal path — try it as a glob. */
	}

	if (!/[?*]/.test(pattern)) {
		warnOnce(`uploads.pool path not found: ${pattern}`, warn)
		return []
	}

	const { dir, glob } = splitGlob(pattern)
	const base = resolve(root, dir)
	try {
		const info = await stat(base)
		if (!info.isDirectory()) {
			warnOnce(`uploads.pool path not found: ${pattern}`, warn)
			return []
		}
	} catch {
		warnOnce(`uploads.pool path not found: ${pattern}`, warn)
		return []
	}

	const files = await walkFiles(base)
	const matcher = globToRegExp(glob)
	return files.filter((path) => matcher.test(toPosix(relative(base, path))))
}

async function walkFiles(dir: string): Promise<string[]> {
	const out: string[] = []
	const entries = await readdir(dir, { withFileTypes: true })
	for (const entry of entries) {
		const path = join(dir, entry.name)
		if (entry.isDirectory()) out.push(...(await walkFiles(path)))
		else if (entry.isFile()) out.push(path)
	}
	return out
}

function splitGlob(pattern: string): { dir: string; glob: string } {
	const normalised = pattern.replace(/\\/g, "/")
	const star = normalised.search(/[*?]/)
	if (star < 0) return { dir: dirname(pattern), glob: basename(pattern) }
	const slash = normalised.lastIndexOf("/", star)
	if (slash < 0) return { dir: ".", glob: normalised }
	return { dir: normalised.slice(0, slash), glob: normalised.slice(slash + 1) }
}

function globToRegExp(glob: string): RegExp {
	let source = "^"
	for (let i = 0; i < glob.length; i++) {
		const ch = glob[i]
		if (ch === "*" && glob[i + 1] === "*") {
			const next = glob[i + 2]
			if (next === "/") {
				source += "(?:.*/)?"
				i += 2
			} else {
				source += ".*"
				i += 1
			}
			continue
		}
		if (ch === "*") {
			source += "[^/]*"
			continue
		}
		if (ch === "?") {
			source += "[^/]"
			continue
		}
		if (ch !== undefined && /[.+^${}()|[\]\\]/.test(ch)) source += `\\${ch}`
		else if (ch !== undefined) source += ch
	}
	source += "$"
	return new RegExp(source, "i")
}

function toPosix(path: string): string {
	return path.split(sep).join("/")
}

function extOf(filename: string): string {
	const dot = filename.lastIndexOf(".")
	if (dot < 0 || dot === filename.length - 1) return ""
	return filename.slice(dot + 1).toLowerCase()
}

function hash32(text: string): number {
	let hash = 2166136261
	for (let i = 0; i < text.length; i++) {
		hash ^= text.charCodeAt(i)
		hash = Math.imul(hash, 16777619)
	}
	return hash >>> 0
}

function warnOnce(message: string, warn?: (message: string) => void): void {
	if (warned.has(message)) return
	warned.add(message)
	;(warn ?? defaultWarn)(message)
}

function defaultWarn(message: string): void {
	console.warn(`oat: ${message}`)
}
