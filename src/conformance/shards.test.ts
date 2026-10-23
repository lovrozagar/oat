import { describe, expect, it } from "vitest"
import { SHAPE_NAMES } from "./shapes.ts"
import { conformanceShards, SHARD_DIALECTS } from "./shards.ts"

/* The self-test as shards: together they run every leg, backend, dialect and shape, each once. */

const flag = (flags: readonly string[], name: string): string | undefined => {
	const at = flags.indexOf(name)
	return at === -1 ? undefined : flags[at + 1]
}

describe("conformanceShards", () => {
	it("puts every shape behind exactly one recall shard, a few at a time", () => {
		const shapes = conformanceShards().flatMap((shard) => flag(shard.flags, "--shapes")?.split(",") ?? [])
		expect(shapes.toSorted()).toEqual([...SHAPE_NAMES].toSorted())
		const sized = conformanceShards(["a", "b", "c", "d", "e", "f"]).filter((shard) => shard.name.startsWith("shapes-"))
		expect(sized.map((shard) => flag(shard.flags, "--shapes"))).toEqual(["a,b,c,d,e", "f"])
	})

	it("runs the passes behind every dialect in memory, and on each engine that stores rows", () => {
		const passes = conformanceShards().filter((shard) => flag(shard.flags, "--legs")?.split(",").includes("passes"))
		const memory = passes.filter((shard) => flag(shard.flags, "--backend") === "memory")
		expect(memory.map((shard) => flag(shard.flags, "--dialect")).toSorted()).toEqual([...SHARD_DIALECTS].toSorted())
		expect(passes.map((shard) => flag(shard.flags, "--backend")).filter((backend) => backend !== "memory")).toEqual([
			"sqlite",
			"postgres",
		])
	})

	it("names each shard once, needs Postgres only for the Postgres pass, and gives each a time", () => {
		const shards = conformanceShards()
		expect(new Set(shards.map((shard) => shard.name)).size).toBe(shards.length)
		expect(shards.filter((shard) => shard.needs === "postgres").map((shard) => shard.name)).toEqual([
			"postgres-postgrest",
		])
		expect(shards.every((shard) => shard.minutes > 0)).toBe(true)
	})
})
