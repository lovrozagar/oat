import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdtemp, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterAll, describe, expect, it } from "vitest"

/*
 * Installed from a local path, oat is a symlink in the consumer's node_modules. Node resolves the
 * main module's real path for `import.meta.url` while `process.argv[1]` keeps the link, so a
 * self-start check comparing the two never fired: the CLI exited 0 having done nothing.
 */

const ROOT = resolve(import.meta.dirname, "..", "..")
const COMPILED = join(ROOT, "dist", "cli.js")
const dirs: string[] = []
afterAll(async () => {
	await Promise.all(dirs.map((dir) => rm(dir, { force: true, recursive: true })))
})

describe("the CLI reached through a symlink", () => {
	it("starts and prints its usage", async () => {
		expect(existsSync(COMPILED), "compile the CLI first (bun run test does)").toBe(true)
		const dir = await mkdtemp(join(tmpdir(), "oat-link-"))
		dirs.push(dir)
		await symlink(ROOT, join(dir, "pkg"), "dir")
		const result = spawnSync(process.execPath, ["--experimental-sqlite", join(dir, "pkg", "dist", "cli.js"), "help"], {
			encoding: "utf8",
		})
		expect(result.status).toBe(0)
		expect(result.stdout).toContain("oat run")
	})
})
