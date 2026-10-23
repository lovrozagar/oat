import { describe, expect, it } from "vitest"
import type { OatConfig } from "../../config/types/config.ts"
import type { BaselineFile } from "../../runtime/baseline.ts"
import { overridesOf, type RunSetting, runOptionsOf } from "./run-options.ts"

/* The run's options: the config as written, the flags over it, and what the command set up. */

const config: OatConfig = {
	baseUrl: "http://api.test",
	principals: { alpha: { tenant: "t1" } },
	spec: "openapi.json",
}

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
		for (const key of ["baseline", "only", "ops", "profile", "exchangeDir", "hooks", "network", "keepCredentials"])
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

describe("runOptionsOf credentials", () => {
	it("passes the principals map, the recipes and the extra secret header names as written", () => {
		const security = { bearer: { static: "t" } }
		const redact = { headers: ["x-ia-tester-key"] }
		const options = runOptionsOf({ ...config, redact, security }, {}, setting())
		expect(options.principals).toBe(config.principals)
		expect(options.security).toBe(security)
		expect(options.redact).toBe(redact)
		expect(runOptionsOf(config, {}, setting())).not.toHaveProperty("security")
	})
})

describe("runOptionsOf overrides", () => {
	it("lets the flags override the config, and carries what the command set up", () => {
		const baseline: BaselineFile = { entries: [], version: 1 }
		const options = runOptionsOf(
			{ ...config, only: ["x"], ops: ["y"], profile: "full" },
			{
				"base-url": "http://other.test",
				"keep-credentials": true,
				"keep-fixtures": true,
				"max-in-flight": "2",
				only: "note",
				ops: "notes.list",
				profile: "cheap",
				seed: "7",
			},
			setting({ accountsFile: "/runs/1/accounts.json", baseline, exchangeDir: "/runs/1" }),
		)
		expect(options).toMatchObject({
			accountsFile: "/runs/1/accounts.json",
			baseline,
			baseUrl: "http://other.test",
			exchangeDir: "/runs/1",
			keepCredentials: true,
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
		expect(runOptionsOf(bare as OatConfig, {}, setting()).principals).toEqual({})
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
