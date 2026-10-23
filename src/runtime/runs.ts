/**
 * Each `oat run` writes into a fresh timestamped folder so a later run does not
 * overwrite the last report.
 *
 * Default root is `.oat/runs`. `--out` / `outDir` replace that root; the leaf is
 * always `<root>/<datetime>/`. `latest` is a relative symlink at the root.
 */

import { mkdir, readlink, rm, symlink } from "node:fs/promises"
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
	/**
	 * Undoes the allocation for a run that refused to start: removes `runDir`, and points `latest`
	 * back where it was, or removes it if there was none, when this run had moved it.
	 */
	rollback: () => Promise<void>
}

export async function allocateRunDir(
	root: string = DEFAULT_RUNS_ROOT,
	at: Date = new Date(),
): Promise<AllocatedRunDir> {
	const resolvedRoot = resolve(root)
	await mkdir(resolvedRoot, { recursive: true })
	const { dir: runDir, stamp } = await mkdirUnique(resolvedRoot, formatRunStamp(at))
	const latest = join(resolvedRoot, LATEST_LINK)
	const previous = await linkTarget(latest)
	const rollback = async (): Promise<void> => {
		await rm(runDir, { force: true, recursive: true })
		const now = await linkTarget(latest)
		/* A junction reads back absolute on Windows; resolving compares either form. */
		if (now === undefined || resolve(resolvedRoot, now) !== runDir) return
		if (previous === undefined) await rm(latest, { force: true })
		else await pointLatest(resolvedRoot, previous)
	}
	return { latest, rollback, root: resolvedRoot, runDir, stamp }
}

/** Where the `latest` link points; undefined when there is none, or it is not a link. */
async function linkTarget(path: string): Promise<string | undefined> {
	try {
		return await readlink(path)
	} catch {
		return undefined
	}
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

/**
 * Moves `latest` to this run. Called once its reports are written: a run that crashed half-way
 * must not become what `latest` shows.
 */
export async function publishLatest(run: Pick<AllocatedRunDir, "root" | "stamp">): Promise<void> {
	await pointLatest(run.root, run.stamp)
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
