import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { main } from "../../src/cli/main.ts"
import { PRINCIPALS, SECURITY } from "../../src/conformance/matrix/principals.ts"
import { createMemoryServer } from "../../src/reference/http/engines.ts"
import type { ReferenceServer } from "../../src/reference/http/server.ts"

/*
 * Behind the totp-setup shape the caller's TOTP enrollment answers its secret, the otpauth URI that
 * carries it, and a QR image of that URI. A run saves exchanges, reports and repros; none of them may
 * show a secret the server issued, in any form, nor the image that draws it.
 */

let dir = ""
let server: ReferenceServer

beforeAll(async () => {
	dir = await mkdtemp(join(tmpdir(), "oat-totp-"))
	server = await createMemoryServer({ shape: "totp-setup" })
})

afterAll(async () => {
	await server.close()
	await rm(dir, { force: true, recursive: true })
})

/* Swallows the CLI's output. */
function quiet(): boolean {
	return true
}

async function cli(argv: string[]): Promise<number> {
	const saved = process.argv
	const out = vi.spyOn(process.stdout, "write").mockImplementation(quiet)
	const err = vi.spyOn(process.stderr, "write").mockImplementation(quiet)
	process.argv = ["node", "oat", ...argv]
	try {
		return await main()
	} finally {
		process.argv = saved
		out.mockRestore()
		err.mockRestore()
	}
}

/* Every file under `root`, as text. */
async function savedText(root: string): Promise<string> {
	const entries = await readdir(root, { recursive: true, withFileTypes: true })
	const files = entries.filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name))
	return (await Promise.all(files.map((file) => readFile(file, "utf8")))).join("\n")
}

describe("a run behind the totp-setup shape", () => {
	it("calls the enrollment and saves no issued secret, in any form, nor its QR image", async () => {
		const config = join(dir, "config.json")
		const body = {
			baseUrl: server.url,
			principals: PRINCIPALS,
			security: SECURITY,
			seed: 42,
			spec: `${server.url}/v1/openapi/spec`,
		}
		await writeFile(config, JSON.stringify(body))
		const out = join(dir, "run")
		await cli(["run", "--config", config, "--ops", "auth.setup2fa", "--save-exchanges", "--out", out, "--quiet"])
		const issued = server.issuedTotpSecrets()
		expect(issued.length).toBeGreaterThan(0)
		const text = await savedText(out)
		expect(text).toContain("auth.setup2fa")
		const forms = issued.flatMap((secret) => [secret, secret.toLowerCase(), encodeURIComponent(secret)])
		expect(forms.filter((form) => text.includes(form))).toEqual([])
		expect(text).not.toMatch(/data:image\//)
	}, 120_000)
})
