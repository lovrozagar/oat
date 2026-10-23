import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { PRINCIPALS, SECURITY } from "../../src/conformance/matrix/principals.ts"
import { createMemoryServer } from "../../src/reference/http/engines.ts"
import type { ReferenceServer } from "../../src/reference/http/server.ts"
import { normalizeText, runCli } from "../support/golden.ts"

let server: ReferenceServer
let dir: string

beforeAll(async () => {
	server = await createMemoryServer()
	dir = await mkdtemp(join(tmpdir(), "oat-cli-golden-"))
	const valid = {
		baseUrl: server.url,
		principals: PRINCIPALS,
		security: SECURITY,
		seed: 42,
		spec: `${server.url}/v1/openapi/spec`,
	}
	const configs: Record<string, unknown> = {
		"valid.json": valid,
		"invalid.json": { principals: PRINCIPALS },
		"no-principals.json": { ...valid, principals: {} },
		"missing-baseline.json": { ...valid, baseline: "nowhere.json" },
		"allow-unknown.json": { ...valid, allow: ["nothing.here"] },
		"overlay-unknown.json": { ...valid, overlay: { operations: { "nothing.here": {} } } },
	}
	for (const [name, body] of Object.entries(configs)) await writeFile(join(dir, name), JSON.stringify(body))
	await mkdir(join(dir, "empty-run"))
	await writeFile(join(dir, "empty-run", "oat-report.json"), JSON.stringify({ outcome: {} }))
	await mkdir(join(dir, "good-run"))
	await writeFile(join(dir, "good-run", "oat-report.json"), JSON.stringify({ findings: [] }))
	await writeFile(join(dir, "existing.json"), "{}")
})
afterAll(async () => {
	await server.close()
	await rm(dir, { force: true, recursive: true })
})

/* Paths into this test's temp folder and the server's port change every run. */
function stable(text: string): string {
	return normalizeText(text.replaceAll(dir, "<dir>").replaceAll(process.cwd(), "<cwd>"))
}

const at = (name: string): string => join(dir, name)

/* `help` and every way the CLI refuses its input, with the exit code it refuses with. */
const CASES: ReadonlyArray<[string, () => string[]]> = [
	["help", () => ["help"]],
	["--help", () => ["run", "--help"]],
	["no arguments", () => []],
	["unknown flag", () => ["run", "--bogus"]],
	["flag needs a value", () => ["run", "--config"]],
	["boolean flag given a value", () => ["run", "--quiet=yes"]],
	["integer flag given text", () => ["run", "--seed", "abc"]],
	["positive flag given zero", () => ["conformance", "--jobs", "0"]],
	["run without --config", () => ["run"]],
	["run with a missing config", () => ["run", "--config", at("absent.json")]],
	["run with a missing TypeScript config", () => ["run", "--config", at("absent.config.ts")]],
	["run with an invalid config", () => ["run", "--config", at("invalid.json")]],
	["run with no principals", () => ["run", "--config", at("no-principals.json")]],
	["run with an unreadable baseline", () => ["run", "--config", at("missing-baseline.json"), "--out", at("out")]],
	["conformance with an unknown backend", () => ["conformance", "--backend", "oracle"]],
	["conformance with an unknown dialect", () => ["conformance", "--dialect", "graphql"]],
	["conformance --only with no list", () => ["conformance", "--only"]],
	["conformance --only with an unknown defect", () => ["conformance", "--only", "NOT_A_DEFECT"]],
	["plan without a spec", () => ["plan"]],
	["plan with an invalid config", () => ["plan", "--config", at("invalid.json")]],
	["plan with an unknown --ops target", () => ["plan", "--config", at("valid.json"), "--ops", "table.craete"]],
	["plan with allow naming no operation", () => ["plan", "--config", at("allow-unknown.json")]],
	["plan with an overlay naming no operation", () => ["plan", "--config", at("overlay-unknown.json")]],
	["unknown command", () => ["frobnicate", "--config", at("valid.json")]],
	["baseline without --from", () => ["baseline"]],
	["baseline from a missing run", () => ["baseline", "--from", at("no-run")]],
	["baseline from a report with no findings", () => ["baseline", "--from", at("empty-run")]],
	["baseline over an existing file", () => ["baseline", "--from", at("good-run"), "--out", at("existing.json")]],
	["diff with one run", () => ["diff", at("good-run")]],
	["diff with a missing run", () => ["diff", at("good-run"), at("no-run")]],
]

describe("CLI golden", () => {
	it.each(CASES)("%s", async (_name, argv) => {
		const { code, output } = await runCli(argv())
		expect({ code, output: stable(output) }).toMatchSnapshot()
	})
})

const NOTES = ["  no recipe — ", "  unsupported — ", "  undeclared — "]

/* Doctor's security block: from its heading through the requirements, and any notes on what a run cannot send. */
function securityBlock(text: string): string {
	const lines = text.split("\n")
	const start = lines.indexOf(lines.find((line) => line.startsWith("  security — ")) as string)
	let end = lines.indexOf(
		"",
		lines.findIndex((line) => line.startsWith("  requirements — ")),
	)
	if (NOTES.some((note) => lines[end + 1]?.startsWith(note))) end = lines.indexOf("", end + 1)
	return `${lines.slice(start, end + 1).join("\n")}\n`
}

describe("CLI golden: doctor's security block", () => {
	it("names each scheme's recipe and the principal that sends each requirement of the reference document", async () => {
		const { code, output } = await runCli(["doctor", "--config", at("valid.json")])
		expect(code).not.toBe(2)
		await expect(securityBlock(stable(output))).toMatchFileSnapshot("__snapshots__/doctor-security.snap")
	})
})
