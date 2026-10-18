/**
 * Resolves a file part: hook, then pool, then a dummy. Missing pool paths warn once
 * and fall through — a bad glob must not crash a run.
 */

import { readdir, readFile, stat } from "node:fs/promises"
import { basename, join, relative, resolve, sep } from "node:path"
import type { Hooks, UploadFile, UploadRequest, UploadResolution, Uploads } from "../config/types/hooks.ts"
import { dummyFile, mediaTypesCompatible, sniffMediaType } from "./dummy.ts"
import { mulberry32 } from "./fixture.ts"

export interface UploadContext {
	seed: number
	uploads?: Uploads
	configDir?: string
	resolveUpload?: Hooks["resolveUpload"]
	resolveInput?: Hooks["resolveInput"]
	warn?: (message: string) => void
	/** Active `uploads.each` slot for this invocation. */
	fixture?: {
		path: string
		filename: string
		index: number
		total: number
	}
	/** What the run remembers across parts; absent, each call starts fresh. */
	memory?: UploadMemory
}

interface PoolEntry {
	path: string
	bytes: Uint8Array
	filename: string
	mediaType: string
}

/**
 * What one run remembers about its uploads: the pool it read, so every part picks from one read,
 * and the warnings it gave, so a bad path is reported once rather than once per part. It rides on
 * the run's `UploadContext`, which every copy shares by reference.
 */
export interface UploadMemory {
	pool?: PoolEntry[]
	readonly warned: Set<string>
}

export function uploadMemory(): UploadMemory {
	return { warned: new Set() }
}

/** The context's `warn`, saying each message once per run. */
export function warnOnce(context: Pick<UploadContext, "memory" | "warn">): (message: string) => void {
	const warned = context.memory?.warned ?? new Set<string>()
	return (message) => {
		if (warned.has(message)) return
		warned.add(message)
		context.warn?.(message)
	}
}

/**
 * The file a part is sent when the `resolveUpload` hook gave none: the `uploads.each` slot, the
 * pool, or a dummy of the declared type. The body encoder asks the hook, once per part, first.
 */
export async function resolveUploadFile(request: UploadRequest, context: UploadContext): Promise<UploadFile> {
	const fromEach = await fileFromFixtureSlot(request, context)
	if (fromEach !== undefined) return fromEach

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

async function fileFromFixtureSlot(request: UploadRequest, context: UploadContext): Promise<UploadFile | undefined> {
	const slot = request.fixture ?? context.fixture
	if (slot === undefined) return undefined
	try {
		const bytes = new Uint8Array(await readFile(slot.path))
		return { bytes, filename: slot.filename, mediaType: sniffMediaType(bytes, slot.filename) ?? OCTET }
	} catch {
		warnOnce(context)(`uploads.each could not read ${slot.path}`)
		return undefined
	}
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

/*
 * What a file is sent as when neither its bytes nor its name say. The sniffer already falls back to
 * the name, so its answer is the only one to ask.
 */
const OCTET = "application/octet-stream"

async function pickFromPool(request: UploadRequest, context: UploadContext): Promise<UploadFile | undefined> {
	const patterns = context.uploads?.pool
	if (patterns === undefined || patterns.length === 0) return undefined

	const memory = context.memory ?? uploadMemory()
	memory.pool ??= await loadPool(patterns, context.configDir ?? process.cwd(), warnOnce(context))
	const matching = memory.pool.filter((entry) => matchesPart(entry, request))
	if (matching.length === 0) return undefined

	const picked = stablePick(matching, { field: request.field, index: request.index, seed: context.seed })
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

/** What a stable pick is keyed by: the run's seed, the field, and the record's position. */
interface PickKey {
	seed: number
	field: string
	index: number
}

/** One of `items` (never empty), the same one for the same seed, field and index. */
function stablePick<T>(items: T[], { seed, field, index }: PickKey): T {
	const rand = mulberry32(hash32(`${seed}\0${field}\0${index}`))
	/* Fisher–Yates with the seeded RNG so the same seed always picks the same file. */
	const copy = [...items]
	for (let i = copy.length - 1; i > 0; i--) {
		const j = Math.floor(rand() * (i + 1))
		/* Both indices are in range: j <= i < copy.length. */
		const a = copy[i] as T
		copy[i] = copy[j] as T
		copy[j] = a
	}
	return copy[0] as T
}

async function loadPool(patterns: string[], root: string, warn: (message: string) => void): Promise<PoolEntry[]> {
	const paths = new Set<string>()
	for (const pattern of patterns) {
		const matches = await expandPattern(pattern, root, { warn })
		for (const path of matches) paths.add(path)
	}

	const entries: PoolEntry[] = []
	for (const path of [...paths].sort()) {
		try {
			const bytes = new Uint8Array(await readFile(path))
			const filename = basename(path)
			entries.push({ bytes, filename, mediaType: sniffMediaType(bytes, filename) ?? OCTET, path })
		} catch {
			warn(`uploads.pool could not read ${path}`)
		}
	}
	return entries
}

/** How a pattern that matches nothing is reported: through `warn`, naming the `label` setting. */
export interface PatternWarnings {
	warn?: (message: string) => void
	label?: string
}

export async function expandPattern(
	pattern: string,
	root: string,
	{ warn, label = "uploads.pool" }: PatternWarnings = {},
): Promise<string[]> {
	const absolute = resolve(root, pattern)
	try {
		const info = await stat(absolute)
		if (info.isFile()) return [absolute]
		if (info.isDirectory()) return walkFiles(absolute)
	} catch {
		/* Not a literal path — try it as a glob. */
	}

	if (!/[?*]/.test(pattern)) {
		warn?.(`${label} path not found: ${pattern}`)
		return []
	}

	const { dir, glob } = splitGlob(pattern)
	const base = resolve(root, dir)
	try {
		const info = await stat(base)
		if (!info.isDirectory()) {
			warn?.(`${label} path not found: ${pattern}`)
			return []
		}
	} catch {
		warn?.(`${label} path not found: ${pattern}`)
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

/** A glob's literal directory and the pattern under it; `pattern` has a wildcard. */
function splitGlob(pattern: string): { dir: string; glob: string } {
	const normalised = pattern.replace(/\\/g, "/")
	const slash = normalised.lastIndexOf("/", normalised.search(/[*?]/))
	if (slash < 0) return { dir: ".", glob: normalised }
	return { dir: normalised.slice(0, slash), glob: normalised.slice(slash + 1) }
}

function globToRegExp(glob: string): RegExp {
	let source = "^"
	for (let i = 0; i < glob.length; i++) {
		const ch = glob.charAt(i)
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
		source += /[.+^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch
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
