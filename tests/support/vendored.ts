import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

/*
 * A third-party file a test needs but the repository must not hold: a published test key, or a
 * document carrying a sample token, either of which secret scanners rightly refuse. It is fetched
 * from a URL pinned to a commit and kept only when its bytes hash to the pinned sha256.
 */

/** A file fetched into place: where it goes, from where, and the hash its bytes must have. */
export interface Vendored {
	/** Relative to the directory it is fetched into. */
	path: string
	/** A URL pinned to one commit, never a branch. */
	url: string
	sha256: string
}

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex")

/** Puts each file under `dir`, fetching only one that is missing or does not hash to its pin; throws on any other hash. */
export async function ensureVendored(
	dir: string,
	files: readonly Vendored[],
	fetcher: typeof fetch = fetch,
): Promise<void> {
	for (const file of files) {
		const target = join(dir, file.path)
		if (existsSync(target) && sha256(readFileSync(target)) === file.sha256) continue
		const response = await fetcher(file.url)
		if (!response.ok) throw new Error(`${file.url} answered ${response.status}`)
		const bytes = new Uint8Array(await response.arrayBuffer())
		const got = sha256(bytes)
		if (got !== file.sha256) throw new Error(`${file.url} has sha256 ${got}, not the pinned ${file.sha256}`)
		mkdirSync(dirname(target), { recursive: true })
		writeFileSync(target, bytes)
	}
}
