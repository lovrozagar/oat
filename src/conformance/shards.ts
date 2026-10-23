/**
 * The self-test as shards: short legs, each its own process, so no one job runs for an hour and a
 * machine short of memory never holds the whole matrix at once. Each shard writes the checks its
 * defects proved; `conformance --aggregate` judges their union, the same verdict one full run gives.
 * `bun run conformance:sharded` runs them in turn, and CI runs each as a job of its own.
 */

import { SHAPE_NAMES } from "./shapes.ts"

/** One shard: its name, the conformance flags that run it, and what it needs. */
export interface Shard {
	name: string
	flags: string[]
	/** The backend it needs a server for, beyond the in-process ones. */
	needs?: "postgres"
	/** About how long it takes on a CI runner, in minutes: its job's timeout is twice this. */
	minutes: number
}

/** The dialects every pass runs behind, postgrest first: it alone also runs the scope leg. */
export const SHARD_DIALECTS: readonly string[] = ["postgrest", "classic", "linked", "jsonapi", "plain", "template"]

/** Shapes per recall shard: every defect again behind each, about a minute a shape. */
const SHAPES_PER_SHARD = 5

/** Every shard of the self-test, in the order a sequential run takes them. */
export function conformanceShards(shapes: readonly string[] = SHAPE_NAMES): Shard[] {
	const recall = Array.from({ length: Math.ceil(shapes.length / SHAPES_PER_SHARD) }, (_, index): Shard => ({
		flags: [
			"--legs",
			"shapes,recall",
			"--shapes",
			shapes.slice(index * SHAPES_PER_SHARD, (index + 1) * SHAPES_PER_SHARD).join(","),
		],
		minutes: 8,
		name: `shapes-recall-${index + 1}`,
	}))
	const [first, ...others] = SHARD_DIALECTS
	return [
		{ flags: ["--legs", "suites"], minutes: 4, name: "suites" },
		{
			flags: ["--backend", "memory", "--dialect", first as string, "--legs", "passes,scope"],
			minutes: 8,
			name: `memory-${first}`,
		},
		{ flags: ["--backend", "sqlite", "--legs", "passes"], minutes: 6, name: "sqlite-postgrest" },
		{ flags: ["--backend", "postgres", "--legs", "passes"], minutes: 8, name: "postgres-postgrest", needs: "postgres" },
		...others.map((dialect): Shard => ({
			flags: ["--backend", "memory", "--dialect", dialect, "--legs", "passes"],
			minutes: 5,
			name: `memory-${dialect}`,
		})),
		...recall,
		{ flags: ["--legs", "fuzz"], minutes: 6, name: "combinations" },
	]
}
