import { createHash } from "node:crypto"
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { ensureVendored, type Vendored } from "../support/vendored.ts"

/*
 * A third-party file a test needs but the repository must not hold — a published test key, a
 * document carrying a sample token — is fetched from a pinned URL and kept only when its bytes hash
 * to the pinned sha256.
 */

const BYTES = "the pinned bytes\n"
const SHA = createHash("sha256").update(BYTES).digest("hex")
const FILE: Vendored = { path: "keys/jwks.json", sha256: SHA, url: "https://pinned.test/jwks.json" }

/** A fetch that answers `body` with `status`, counting its calls. */
function fetcher(body: string, status = 200) {
	const calls: string[] = []
	const fetch = async (url: string | URL | Request): Promise<Response> => {
		calls.push(String(url))
		return new Response(body, { status })
	}
	return { calls, fetch: fetch as typeof globalThis.fetch }
}

const dir = () => mkdtempSync(join(tmpdir(), "oat-vendored-"))

describe("ensureVendored", () => {
	it("fetches a missing file and keeps it when its bytes hash to the pinned sha256", async () => {
		const root = dir()
		const { calls, fetch } = fetcher(BYTES)
		await ensureVendored(root, [FILE], fetch)
		expect(readFileSync(join(root, FILE.path), "utf8")).toBe(BYTES)
		expect(calls).toEqual([FILE.url])
	})

	it("leaves a file that already hashes right alone, and fetches one that does not again", async () => {
		const root = dir()
		await ensureVendored(root, [FILE], fetcher(BYTES).fetch)
		const unchanged = fetcher(BYTES)
		await ensureVendored(root, [FILE], unchanged.fetch)
		expect(unchanged.calls).toEqual([])
		writeFileSync(join(root, FILE.path), "edited\n")
		const again = fetcher(BYTES)
		await ensureVendored(root, [FILE], again.fetch)
		expect(again.calls).toEqual([FILE.url])
		expect(readFileSync(join(root, FILE.path), "utf8")).toBe(BYTES)
	})

	it("refuses bytes that do not hash to the pin, or a failed fetch, and writes nothing", async () => {
		const root = dir()
		await expect(ensureVendored(root, [FILE], fetcher("other bytes\n").fetch)).rejects.toThrow(
			`${FILE.url} has sha256 `,
		)
		await expect(ensureVendored(root, [FILE], fetcher("", 404).fetch)).rejects.toThrow(`${FILE.url} answered 404`)
		expect(existsSync(join(root, FILE.path))).toBe(false)
	})
})
