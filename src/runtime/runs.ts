/**
 * Each `oat run` writes into a fresh timestamped folder so a later run does not
 * overwrite the last report.
 *
 * Default root is `.oat/runs`. `--out` / `outDir` replace that root; the leaf is
 * always `<root>/<datetime>/`. `latest` is a relative symlink at the root.
 */

import { mkdir, rm, symlink } from "node:fs/promises"
import { join, resolve } from "node:path"

export const DEFAULT_RUNS_ROOT = ".oat/runs"
export const LATEST_LINK = "latest"

/** UTC, filesystem-safe. `2026-08-18T14:30:05.123Z` → `2026-08-18T14-30-05Z`. */
export function formatRunStamp(at: Date): string {
	return at
		.toISOString()
		.replaceAll(":", "-")
		.replace(/\.\d{3}Z$/, "Z")
}

export interface AllocatedRunDir {
	/** Resolved history root (`--out` / `outDir` / default). */
	root: string
	/** Fresh directory for this invocation's artifacts. */
	runDir: string
	/** Folder name under `root` — the stamp, plus `-2` / `-3` on collision. */
	stamp: string
	/** Path of the `latest` symlink (always `<root>/latest`). */
	latest: string
}

export async function allocateRunDir(root = DEFAULT_RUNS_ROOT, at = new Date()): Promise<AllocatedRunDir> {
	const resolvedRoot = resolve(root)
	await mkdir(resolvedRoot, { recursive: true })
	const { dir: runDir, stamp } = await mkdirUnique(resolvedRoot, formatRunStamp(at))
	const latest = join(resolvedRoot, LATEST_LINK)
	await pointLatest(resolvedRoot, stamp)
	return { latest, root: resolvedRoot, runDir, stamp }
}

async function mkdirUnique(root: string, base: string): Promise<{ dir: string; stamp: string }> {
	let stamp = base
	let n = 2
	for (;;) {
		const dir = join(root, stamp)
		try {
			await mkdir(dir)
			return { dir, stamp }
		} catch (error) {
			if (!isAlreadyExists(error)) throw error
			stamp = `${base}-${n}`
			n += 1
		}
	}
}

async function pointLatest(root: string, stamp: string): Promise<void> {
	const latest = join(root, LATEST_LINK)
	await rm(latest, { force: true, recursive: true })
	/* Junctions work without admin on Windows; `dir` is the Unix equivalent. */
	await symlink(stamp, latest, process.platform === "win32" ? "junction" : "dir")
}

function isAlreadyExists(error: unknown): boolean {
	return (
		typeof error === "object" && error !== null && "code" in error && (error as { code: unknown }).code === "EEXIST"
	)
}
