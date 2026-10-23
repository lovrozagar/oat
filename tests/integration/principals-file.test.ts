import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { createMemoryServer } from "../../src/reference/http/engines.ts"
import { EXIT } from "../../src/runtime/exit.ts"
import { loadPersistedPrincipals } from "../../src/runtime/principals.ts"
import { oat, referenceConfig, type SavedRunReport, tempDirs } from "../support/cli-run.ts"

/*
 * `principals.json` lands in every run folder, often a CI artifact: a principal that signs in with a
 * password from its config leaves the password out of it, and out of every other file of the run.
 * Any identity value a sign-in sends is held the same way, whatever its key is called: the
 * reference's `key`. A second run reuses the file with the config's own entry laid over it, and
 * signs in again.
 */

const dirs = tempDirs("oat-principals-file-")
afterAll(dirs.removeAll)

const PASSWORD = "alpha-password"
const ALPHA = { email: "alpha@reference.test", password: PASSWORD }
const SECURITY = {
	jwt: {
		login: {
			from: "$.access_token",
			steps: [{ body: { email: "{principal.email}", password: "{principal.password}" }, operationId: "auth.login" }],
		},
	},
}

/* Every file under `dir`, at any depth. */
async function filesUnder(dir: string): Promise<string[]> {
	const entries = await readdir(dir, { recursive: true, withFileTypes: true })
	return entries.filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name))
}

/* The files of the run folder `dir` whose text holds `value`. */
async function holding(dir: string, value: string): Promise<string[]> {
	const files = await filesUnder(dir)
	const texts = await Promise.all(files.map((path) => readFile(path, "utf8")))
	return files.filter((_, i) => texts[i]?.includes(value))
}

describe("principals.json", () => {
	it("omits a password the login recipe read from config, and a second run signs in from config", async () => {
		const server = await createMemoryServer()
		try {
			const dir = await dirs.make()
			const runs = join(dir, "runs")
			const signIn = async (principals: unknown, name: string) => {
				const config = await referenceConfig(join(dir, name), server.url, { principals, security: SECURITY })
				return oat(["run", "--config", config, "--out", runs, "--quiet", "--ops", "profile.get"])
			}

			const first = await signIn({ alpha: ALPHA }, "first")
			expect(first.code).toBe(EXIT.clean)
			const file = join(runs, "latest", "principals.json")
			const written = JSON.parse(await readFile(file, "utf8")) as {
				principals: { id: string; identity: Record<string, unknown>; blocked?: string }[]
			}
			/* The email is a value the sign-in sends, so it is held as a secret too. */
			expect(written.principals).toEqual([expect.objectContaining({ id: "alpha", identity: {} })])
			expect(await holding(join(runs, "latest"), PASSWORD)).toEqual([])
			expect(await holding(join(runs, "latest"), ALPHA.email)).toEqual([])
			/* Redaction is what the run writes down: the check that compares the caller still read the raw answers. */
			const report = JSON.parse(await readFile(join(runs, "latest", "oat-report.json"), "utf8")) as SavedRunReport
			expect(report.scope.operations.find((op) => op.operationId === "profile.get")?.checks.passed).toContain(
				"auth.self-is-the-caller",
			)

			const persisted = loadPersistedPrincipals(file)
			expect(persisted["alpha"]).not.toHaveProperty("password")
			const second = await signIn({ alpha: { ...persisted["alpha"], ...ALPHA } }, "second")
			expect(second.code).toBe(EXIT.clean)
			const again = JSON.parse(await readFile(file, "utf8")) as typeof written
			expect(again.principals[0]).not.toHaveProperty("blocked")
			expect(again.principals[0]).toMatchObject({ credentials: [{ scheme: "jwt" }], id: "alpha" })
		} finally {
			await server.close()
		}
	}, 60_000)

	it("holds a key the reference's login sends from identity out of principals.json and every file of the run", async () => {
		const server = await createMemoryServer()
		try {
			const dir = await dirs.make()
			const runs = join(dir, "runs")
			const config = await referenceConfig(dir, server.url)
			const run = await oat(["run", "--config", config, "--out", runs, "--quiet", "--ops", "profile.get"])
			expect(run.code).toBe(EXIT.clean)
			const written = JSON.parse(await readFile(join(runs, "latest", "principals.json"), "utf8")) as {
				principals: { id: string; identity: Record<string, unknown> }[]
			}
			expect(written.principals.find((principal) => principal.id === "alpha")?.identity).toEqual({})
			expect(await holding(join(runs, "latest"), "key_alpha")).toEqual([])
		} finally {
			await server.close()
		}
	}, 60_000)
})
