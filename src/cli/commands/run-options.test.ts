import { describe, expect, it } from "vitest"
import type { OatConfig } from "../../config/types/config.ts"
import type { BaselineFile } from "../../runtime/baseline.ts"
import { overridesOf, type RunSetting, runOptionsOf } from "./run-options.ts"

/* The run's options: the config as written, the flags over it, and what the command set up. */

const config = {
	baseUrl: "http://api.test",
	principals: [{ id: "alpha" }],
	spec: "openapi.json",
} as OatConfig

const setting = (extra: Partial<RunSetting> = {}): RunSetting => ({
	baseline: undefined,
	configPath: "/cfg/oat.config.ts",
	exchangeDir: undefined,
	onProgress: () => undefined,
	signal: new AbortController().signal,
	warn: () => undefined,
	...extra,
})

describe("runOptionsOf", () => {
	it("takes the config's defaults when nothing overrides them", () => {
		const options = runOptionsOf(config, {}, setting())
		expect(options).toMatchObject({
			baseUrl: "http://api.test",
			configDir: "/cfg",
			keepFixtures: false,
			maxInFlight: 4,
			seed: 1,
			spec: "openapi.json",
		})
		for (const key of ["baseline", "only", "ops", "profile", "exchangeDir", "hooks", "network"])
			expect(options).not.toHaveProperty(key)
	})

	it("passes the config's own fields as written, and its seed, fixtures and in-flight cap", () => {
		const hooks = {}
		const written = {
			...config,
			cohortSize: 3,
			hooks,
			keepFixtures: true,
			maxInFlight: 9,
			network: { retries: 1 },
			seed: 5,
		} as OatConfig
		expect(runOptionsOf(written, {}, setting())).toMatchObject({
			cohortSize: 3,
			hooks,
			keepFixtures: true,
			maxInFlight: 9,
			network: { retries: 1 },
			seed: 5,
		})
	})
})

describe("runOptionsOf overrides", () => {
	it("lets the flags override the config, and carries what the command set up", () => {
		const baseline: BaselineFile = { entries: [], version: 1 }
		const options = runOptionsOf(
			{ ...config, only: ["x"], ops: ["y"], profile: "full" },
			{
				"base-url": "http://other.test",
				"keep-fixtures": true,
				"max-in-flight": "2",
				only: "note",
				ops: "notes.list",
				profile: "cheap",
				seed: "7",
			},
			setting({ baseline, exchangeDir: "/runs/1" }),
		)
		expect(options).toMatchObject({
			baseline,
			baseUrl: "http://other.test",
			exchangeDir: "/runs/1",
			keepFixtures: true,
			maxInFlight: 2,
			only: ["note"],
			ops: ["notes.list"],
			profile: "cheap",
			seed: 7,
		})
	})
})

describe("runOptionsOf edge cases", () => {
	it("has no principals for a config that names none", () => {
		const { principals: _none, ...bare } = config
		expect(runOptionsOf(bare as OatConfig, {}, setting()).principals).toEqual([])
	})

	it("drops target lists that name nothing", () => {
		const options = runOptionsOf({ ...config, only: [" "], ops: [""] }, {}, setting())
		expect(options).not.toHaveProperty("only")
		expect(options).not.toHaveProperty("ops")
	})
})

describe("overridesOf", () => {
	it("reads the flags over the config", () => {
		expect(overridesOf(config, { ops: "a,b" })).toEqual({
			baseUrl: "http://api.test",
			only: undefined,
			ops: ["a", "b"],
			profile: undefined,
		})
	})
})
