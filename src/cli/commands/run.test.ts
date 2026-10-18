import { EventEmitter } from "node:events"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { UsageError } from "../../errors/usage-error.ts"
import { EXIT } from "../../runtime/exit.ts"
import { FencedError } from "../../runtime/fence.ts"
import { notesApi, optionsFor } from "../../runtime/run/__fixtures__/api.ts"
import type { RunOptions } from "../../runtime/run/index.ts"
import { bufferWriter } from "../writer.ts"
import { folder, json, notesConfig } from "../__fixtures__/files.ts"
import { commandRun, type RunDeps, runPipeline } from "./run.ts"
import type { SignalSource } from "./run-signals.ts"

/*
 * `oat run`: a config read and checked, the run set up around it, the backend tested, the folder
 * written, and an exit code for what it found. The real pipeline runs here against an in-memory
 * API through a scripted transport.
 */

/** Signals from a stand-in, so a test can stop the run. */
function signals() {
	const emitter = new EventEmitter()
	const source: SignalSource = {
		exit: ((code: number) => {
			throw new Error(`exit ${code}`)
		}) as SignalSource["exit"],
		off: (signal, listener) => emitter.off(signal, listener),
		on: (signal, listener) => emitter.on(signal, listener),
	}
	return { emitter, source }
}

/** The real run, its requests through the notes API; `during` sees the options as it starts. */
function deps(during: (options: RunOptions) => void = () => undefined): RunDeps & { asked: RunOptions[] } {
	const asked: RunOptions[] = []
	const transport = optionsFor(notesApi()).network
	return {
		asked,
		run: async (options) => {
			asked.push(options)
			during(options)
			return runPipeline({
				...options,
				network: { ...options.network, ...transport },
				spec: "http://api.test/openapi.json",
			})
		},
		signals: signals().source,
	}
}

/** A run that is refused with `error` before it starts. */
function failing(error: Error): RunDeps {
	return { run: () => Promise.reject(error), signals: signals().source }
}

describe("commandRun", () => {
	it("tests the backend and writes the run folder, its latest link and the summary", async () => {
		const out = folder()
		const writer = bufferWriter()
		const run = deps()
		const code = await commandRun(writer, { config: notesConfig(), out, quiet: true }, run)
		expect({ code, output: writer.text() }).toEqual({ code: 0, output: expect.any(String) })
		expect(existsSync(join(out, "latest", "oat-report.json"))).toBe(true)
		expect(writer.text()).toContain(`  latest: ${join(out, "latest")}\n\n`)
		expect(readFileSync(join(out, "latest", "progress.log"), "utf8").length).toBeGreaterThan(0)
		run.asked[0]?.warn?.("an upload path matched no file")
		expect(writer.text()).toContain("oat: an upload path matched no file\n")
	})

	it("writes the run folder where the config says, else under ./.oat/runs", async () => {
		const configured = folder()
		await commandRun(bufferWriter(), { config: notesConfig(folder(), { outDir: configured }), quiet: true }, deps())
		expect(existsSync(join(configured, "latest", "oat-report.json"))).toBe(true)
		const cwd = process.cwd()
		const here = folder()
		process.chdir(here)
		try {
			await commandRun(bufferWriter(), { config: notesConfig(folder()), quiet: true }, deps())
		} finally {
			process.chdir(cwd)
		}
		expect(existsSync(join(here, ".oat", "runs", "latest", "oat-report.json"))).toBe(true)
	})
})

describe("commandRun journaling", () => {
	it("journals exchanges unless the flag, the config or a cheap profile says not to", async () => {
		const out = folder()
		const asked = async (flags: Record<string, string | true>, extra: Record<string, unknown> = {}) => {
			const run = deps()
			await commandRun(bufferWriter(), { config: notesConfig(folder(), extra), out, quiet: true, ...flags }, run)
			return run.asked[0]?.exchangeDir !== undefined
		}
		expect(await asked({})).toBe(true)
		expect(await asked({ "no-save-exchanges": true })).toBe(false)
		expect(await asked({ profile: "cheap" })).toBe(false)
		expect(await asked({ profile: "cheap", "save-exchanges": true })).toBe(true)
		expect(await asked({}, { saveExchanges: false })).toBe(false)
	})

	it("reads a baseline beside the config", async () => {
		const dir = folder()
		json(dir, "known.json", { entries: [], version: 1 })
		const run = deps()
		await commandRun(
			bufferWriter(),
			{ config: notesConfig(dir, { baseline: "known.json" }), out: folder(), quiet: true },
			run,
		)
		expect(run.asked[0]?.baseline).toEqual({ entries: [], version: 1 })
	})

	it("finishes the run a signal stopped, and exits as the shell expects", async () => {
		const { emitter, source } = signals()
		const run = { ...deps(() => emitter.emit("SIGINT", "SIGINT")), signals: source }
		const writer = bufferWriter()
		expect(await commandRun(writer, { config: notesConfig(), out: folder(), quiet: true }, run)).toBe(130)
		expect(writer.text()).toContain("oat: SIGINT — stopping")
	})
})

describe("commandRun refusals", () => {
	it("refuses without a config, a config it cannot use, and one with no principals", async () => {
		const none = bufferWriter()
		expect(await commandRun(none, {})).toBe(EXIT.usage)
		expect(none.text()).toMatch(/^oat: run requires --config\n\noat — OpenAPI Tester/)
		const missing = bufferWriter()
		expect(await commandRun(missing, { config: "nowhere.config.ts" }, deps())).toBe(EXIT.usage)
		expect(missing.text()).toBe("oat: config not found: nowhere.config.ts\n")
		const nobody = bufferWriter()
		expect(await commandRun(nobody, { config: notesConfig(folder(), { principals: [] }) }, deps())).toBe(EXIT.usage)
		expect(nobody.text()).toContain("config.principals is empty")
	})

	it("refuses a baseline that is not there, or not one", async () => {
		const dir = folder()
		const missing = bufferWriter()
		expect(await commandRun(missing, { config: notesConfig(dir, { baseline: "gone.json" }) }, deps())).toBe(EXIT.usage)
		expect(missing.text()).toMatch(/^oat: cannot read baseline .*gone\.json: /)
		json(dir, "bad.json", { version: 9 })
		const invalid = bufferWriter()
		expect(await commandRun(invalid, { config: notesConfig(dir, { baseline: "bad.json" }) }, deps())).toBe(EXIT.usage)
		expect(invalid.text()).toMatch(/^oat: .*bad\.json/)
	})

	it("refuses a run that was fenced or misconfigured before it started, and passes on anything else", async () => {
		const config = notesConfig()
		const fenced = bufferWriter()
		const refusal = new FencedError({ method: "GET", phase: "load", reason: "no", url: "u" })
		expect(await commandRun(fenced, { config, out: folder(), quiet: true }, failing(refusal))).toBe(EXIT.failed)
		expect(fenced.text()).toContain("oat: fenced: no")
		const usage = bufferWriter()
		expect(
			await commandRun(usage, { config, out: folder(), quiet: true }, failing(new UsageError("oat: bad target"))),
		).toBe(EXIT.usage)
		expect(usage.text()).toContain("oat: bad target\n")
		await expect(
			commandRun(bufferWriter(), { config, out: folder(), quiet: true }, failing(new Error("bug"))),
		).rejects.toThrow("bug")
	})
})
