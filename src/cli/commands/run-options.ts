import { dirname, resolve } from "node:path"
import type { OatConfig } from "../../config/types/config.ts"
import type { BaselineFile } from "../../runtime/baseline.ts"
import type { ProgressHandler } from "../../runtime/progress.ts"
import type { RunOptions } from "../../runtime/run/index.ts"
import { type Args, list, str } from "../flags.ts"

/** Config fields a run takes as they are written. */
const AS_WRITTEN = [
	"globalHeaders",
	"hooks",
	"uploads",
	"roots",
	"cohortSize",
	"profiles",
	"rateLimits",
	"maxRps",
	"origins",
	"overlay",
	"allow",
	"fence",
	"teardown",
	"targetVersion",
	"scenarios",
	"outOfBand",
	"payloads",
	"query",
	"entities",
	"network",
] as const satisfies ReadonlyArray<keyof OatConfig & keyof RunOptions>

/** What the command decided around the config: where it writes, how it reports, how it stops. */
export interface RunSetting {
	configPath: string
	baseline: BaselineFile | undefined
	signal: AbortSignal
	onProgress: ProgressHandler
	warn: (message: string) => void
	/** The run folder, when its exchanges are journaled. */
	exchangeDir: string | undefined
}

/** The flags that override the config, as the run reads them. */
export interface Overrides {
	baseUrl: string
	only: string[] | undefined
	ops: string[] | undefined
	profile: string | undefined
}

/** The flags over the config: a flag says what the config would, for this run only. */
export function overridesOf(config: OatConfig, flags: Args["flags"]): Overrides {
	return {
		baseUrl: str(flags, "base-url") ?? config.baseUrl,
		only: list(flags, "only") ?? config.only?.filter((name) => name.trim() !== ""),
		ops: list(flags, "ops") ?? config.ops?.filter((name) => name.trim() !== ""),
		profile: str(flags, "profile") ?? config.profile,
	}
}

/** The run's options, from the config, the flags over it, and what the command set up. */
export function runOptionsOf(config: OatConfig, flags: Args["flags"], setting: RunSetting): RunOptions {
	const { baseUrl, only, ops, profile } = overridesOf(config, flags)
	const seed = str(flags, "seed")
	return {
		...asWritten(config),
		baseUrl,
		configDir: dirname(resolve(setting.configPath)),
		keepFixtures: flags["keep-fixtures"] === true || config.keepFixtures === true,
		maxInFlight: Number.parseInt(str(flags, "max-in-flight") ?? "", 10) || config.maxInFlight || 4,
		onProgress: setting.onProgress,
		principals: config.principals ?? [],
		seed: seed === undefined ? (config.seed ?? 1) : Number.parseInt(seed, 10),
		signal: setting.signal,
		spec: config.spec,
		warn: setting.warn,
		...(setting.baseline === undefined ? {} : { baseline: setting.baseline }),
		...(only === undefined || only.length === 0 ? {} : { only }),
		...(ops === undefined || ops.length === 0 ? {} : { ops }),
		...(profile === undefined ? {} : { profile }),
		...(setting.exchangeDir === undefined ? {} : { exchangeDir: setting.exchangeDir }),
	}
}

function asWritten(config: OatConfig): Partial<RunOptions> {
	const picked: Record<string, unknown> = {}
	for (const key of AS_WRITTEN) {
		if (config[key] !== undefined) picked[key] = config[key]
	}
	return picked as Partial<RunOptions>
}
