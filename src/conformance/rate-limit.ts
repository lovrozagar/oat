/**
 * Reactive 429 backoff and plan-limit adopt. Tags stay the proactive path; these cases prove
 * the first 429 is not a seed failure and that a 402 does not invent a table.
 */

import { Client } from "../client/client.ts"
import { messageOf } from "../errors/message.ts"
import type { Handle } from "../reference/http/node.ts"
import { parseRetryAfter, retryWaitMs, RETRY_BACKOFF_CAP_MS } from "../runtime/rate-limit/retry-after.ts"
import { run, type RunOptions } from "../runtime/run/index.ts"
import { transportOpt } from "../runtime/run/network.ts"
import { isPlanLimitResponse } from "../runtime/world/plan-limit.ts"
import { Redactor } from "../security/redact.ts"
import { type Hosted, listening, reach, type Via } from "./harness/launch.ts"
import type { ParserResult } from "./harness/result.ts"
import { planLimitedTables, untaggedThings } from "./rate-limit/backend.ts"

type Push = (result: ParserResult) => void

/**
 * Cases run against one backend. A case that throws is reported once under the group's first
 * name, after whatever its earlier cases already pushed.
 */
interface HostedCases {
	name: string
	why: string
	backend: () => Handle
	probe: (hosted: Hosted, push: Push) => Promise<void>
}

/** A run of oat against `hosted`, on its entities `only`. */
function runOptions(hosted: Hosted, only: string[]): RunOptions {
	return {
		baseUrl: hosted.url,
		keepFixtures: true,
		only,
		principals: [{ headers: { authorization: "Bearer t" }, id: "alpha" }],
		seed: 1,
		spec: `${hosted.url}/v1/openapi/spec`,
		...reach(hosted),
	}
}

function pureCases(): ParserResult[] {
	return [
		{
			detail: `delta=${String(parseRetryAfter("1"))} cap=${String(retryWaitMs(undefined, 8))}`,
			name: "Retry-After delta-seconds and exponential cap",
			ok: parseRetryAfter("1") === 1000 && retryWaitMs(undefined, 8) === RETRY_BACKOFF_CAP_MS,
			why: "pure wait math must not hang a tester",
		},
		{
			detail: "ok",
			name: "402 and table_plan_limit are plan limits; 429 is not",
			ok:
				isPlanLimitResponse(402, {}) &&
				isPlanLimitResponse(400, { error_key: "table_plan_limit" }) &&
				!isPlanLimitResponse(429, { error_key: "table_plan_limit" }),
			why: "reuse is 402-only",
		},
	]
}

const RETRIES = "Client.request retries a 429 with Retry-After and returns 201"
const ADOPTS = "row seeds after table.create 402 when a same-tenant table already exists"

const HOSTED: readonly HostedCases[] = [
	{
		backend: untaggedThings,
		name: RETRIES,
		probe: async (hosted, push) => {
			const options = runOptions(hosted, ["thing"])
			/* No network retries, as with no network options at all: only the 429 is retried. */
			const network = { ...transportOpt(options), retries: 0 }
			const client = new Client({ baseUrl: hosted.url, network, redactor: new Redactor() })
			const first = await client.request("POST", "/v1/things", { body: { name: "n" } })
			const statuses = client.transcript.map((e) => e.status).join(",")
			push({
				detail: `status=${first.status} seq=${statuses}`,
				name: RETRIES,
				ok: first.status === 201 && statuses === "429,201",
				why: "first 429 is not the result",
			})
			const result = await run(options)
			const blocked = result.findings.filter((f) => f.verdict === "BLOCKED" && f.check === "world.seed")
			push({
				detail: `blocked=${blocked.length} entities=${result.entitiesTested.join(",")}`,
				name: "seed is not failed by the first 429 on an untagged create",
				ok: blocked.length === 0 && result.entitiesTested.includes("thing"),
				why: "no x-rate-limit required",
			})
		},
		why: "first 429 is not the result",
	},
	{
		backend: planLimitedTables,
		name: ADOPTS,
		probe: async (hosted, push) => {
			const result = await run(runOptions(hosted, ["table", "row"]))
			const rowBlocked = result.findings.some((f) => f.verdict === "BLOCKED" && f.entity === "row")
			const invented = result.client.transcript.some(
				(e) => e.method === "POST" && new URL(e.url).pathname === "/v1/tables" && e.status < 300,
			)
			const backend402 = result.findings.some((f) => f.verdict === "BACKEND_BUG" && f.detail.includes("402"))
			push({
				detail: `blocked=${rowBlocked} invented=${invented} backend402=${backend402} tested=${result.entitiesTested.join(",")}`,
				name: ADOPTS,
				ok: !rowBlocked && !invented && !backend402 && result.entitiesTested.includes("row"),
				why: "do not invent tables; do not treat documented plan limit as a defect",
			})
		},
		why: "do not invent tables; do not treat documented plan limit as a defect",
	},
]

export async function runRateLimitSuite(via: Via = listening): Promise<ParserResult[]> {
	const results = pureCases()
	const push: Push = (result) => results.push(result)
	for (const { backend, name, probe, why } of HOSTED) {
		try {
			const hosted = await via.host(backend())
			try {
				await probe(hosted, push)
			} finally {
				await hosted.close()
			}
		} catch (error) {
			push({ detail: messageOf(error), name, ok: false, why })
		}
	}
	return results
}
