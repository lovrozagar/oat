import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { createMemoryServer } from "../../src/reference/http/engines.ts"
import { latestJournal, oat, referenceConfig, tempDirs } from "../support/cli-run.ts"

/*
 * The run's last calls are evidence like any other: the minted keys' revokes, the accounts its
 * sign-ups made being removed, and the principals' own sessions ended all reach exchanges.jsonl.
 */

const dirs = tempDirs("oat-last-calls-")
afterAll(dirs.removeAll)

describe("the run's closing calls", () => {
	it("are journaled: key revokes, account teardown and session revokes", async () => {
		const dir = await dirs.make()
		const server = await createMemoryServer({ defects: [] })
		try {
			const config = await referenceConfig(dir, server.url)
			const runs = join(dir, "runs")
			await oat(["run", "--config", config, "--out", runs, "--ops", "table.list,auth.register", "--quiet"])
			const journaled = new Set((await latestJournal(runs)).map((line) => line.operationId))
			const closing = ["apiKey.revoke", "auth.logout", "profile.delete"]
			expect([...journaled].filter((id) => closing.includes(id ?? "")).toSorted()).toEqual(closing)
		} finally {
			await server.close()
		}
	}, 60_000)
})
