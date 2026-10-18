/**
 * Declared N-fixture fan-out: expand `uploads.each`, cap, warn, never invent files.
 */

import { readFile } from "node:fs/promises"
import { basename } from "node:path"
import { expandPattern, type UploadContext, warnOnce } from "./upload.ts"

export interface FixtureSlot {
	path: string
	filename: string
	index: number
	total: number
}

/** `null` = op is not in `each`. `[]` = declared but no usable files (caller stays pick-one). */
export async function resolveEachInvocations(
	operationId: string,
	context: UploadContext,
): Promise<FixtureSlot[] | null> {
	const patterns = context.uploads?.each?.[operationId]
	if (patterns === undefined) return null

	const readable = await readableFiles(patterns, context.configDir ?? process.cwd(), context)
	if (readable.length === 0) {
		context.warn?.(`uploads.each matched 0 files for ${operationId}`)
		return []
	}

	const limited = capped(readable, context.uploads?.eachMax)
	if (limited.length < readable.length) {
		context.warn?.(`uploads.each capped ${operationId} at ${limited.length} of ${readable.length}`)
	}

	return limited.map((path, index) => ({
		filename: basename(path),
		index,
		path,
		total: limited.length,
	}))
}

/** Every distinct file the patterns match that can be read, sorted. */
async function readableFiles(patterns: string[], root: string, context: UploadContext): Promise<string[]> {
	const seen = new Set<string>()
	const readable: string[] = []
	const warnMissing = warnOnce(context)
	for (const pattern of patterns) {
		const matches = await expandPattern(pattern, root, { label: "uploads.each", warn: warnMissing })
		for (const path of matches) {
			if (seen.has(path)) continue
			seen.add(path)
			if (await eachFileReadable(path, context.warn)) readable.push(path)
		}
	}
	return readable.sort()
}

/** The first `cap` files when `cap` is a usable limit below their count; otherwise all of them. */
function capped(files: string[], cap: number | undefined): string[] {
	return typeof cap === "number" && cap >= 0 && cap < files.length ? files.slice(0, cap) : files
}

export async function forEachInvocation<T>(
	operationId: string,
	uploads: UploadContext,
	fn: (next: UploadContext, slot: FixtureSlot | undefined) => Promise<T>,
): Promise<T[]> {
	const slots = await resolveEachInvocations(operationId, uploads)
	if (slots === null || slots.length === 0) return [await fn(uploads, undefined)]
	const out: T[] = []
	for (const slot of slots) {
		out.push(await fn({ ...uploads, fixture: slot }, slot))
	}
	return out
}

async function eachFileReadable(path: string, warn?: (message: string) => void): Promise<boolean> {
	try {
		await readFile(path)
		return true
	} catch {
		warn?.(`uploads.each could not read ${path}`)
		return false
	}
}
