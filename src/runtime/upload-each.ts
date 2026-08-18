/**
 * Declared N-fixture fan-out: expand `uploads.each`, cap, warn, never invent files.
 */

import { readFile } from "node:fs/promises"
import { basename } from "node:path"
import { expandPattern, type UploadContext } from "./upload.ts"

export interface FixtureSlot {
	path: string
	filename: string
	index: number
	total: number
}

function warnEach(message: string, warn?: (message: string) => void): void {
	;(warn ?? defaultWarn)(message)
}

function defaultWarn(message: string): void {
	console.warn(`oat: ${message}`)
}

/** `null` = op is not in `each`. `[]` = declared but no usable files (caller stays pick-one). */
export async function resolveEachInvocations(
	operationId: string,
	context: UploadContext,
): Promise<FixtureSlot[] | null> {
	const patterns = context.uploads?.each?.[operationId]
	if (patterns === undefined) return null

	const root = context.configDir ?? process.cwd()
	const seen = new Set<string>()
	const readable: string[] = []
	for (const pattern of patterns) {
		const matches = await expandPattern(pattern, root, context.warn, "uploads.each")
		for (const path of matches) {
			if (seen.has(path)) continue
			seen.add(path)
			if (await eachFileReadable(path, context.warn)) readable.push(path)
		}
	}

	readable.sort()
	if (readable.length === 0) {
		warnEach(`uploads.each matched 0 files for ${operationId}`, context.warn)
		return []
	}

	const cap = context.uploads?.eachMax
	const limited = typeof cap === "number" && cap >= 0 && cap < readable.length ? readable.slice(0, cap) : readable
	if (limited.length < readable.length) {
		warnEach(`uploads.each capped ${operationId} at ${limited.length} of ${readable.length}`, context.warn)
	}

	return limited.map((path, index) => ({
		filename: basename(path),
		index,
		path,
		total: limited.length,
	}))
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
		warnEach(`uploads.each could not read ${path}`, warn)
		return false
	}
}
