/**
 * Fixture walk, cheap-profile effects, and invite/register-as-create contracts.
 *
 * These are the cases a real document trips: `z.unknown()` / `z.record` after `$ref` inlining,
 * `--profile cheap` still POSTing `extract.once`, and `org.inviteMember` / `auth.registerWithEmail`
 * being treated as `POST /things`.
 */

import { messageOf } from "../errors/message.ts"
import type { Handle } from "../reference/http/node.ts"
import { run, type RunOptions, type RunResult } from "../runtime/run/index.ts"
import { buildModel } from "../spec/graph/build.ts"
import { dereference } from "../spec/load/dereference.ts"
import { listening, reach, type Via } from "./harness/launch.ts"
import type { ParserResult } from "./harness/result.ts"
import { runFixtureWalkCases } from "./seed-contract/fixture-walk.ts"
import { memberBackend, memberSpec } from "./seed-contract/members.ts"
import { projectBackend } from "./seed-contract/project.ts"
import { userBackend } from "./seed-contract/users.ts"

export { runFixtureWalkCases } from "./seed-contract/fixture-walk.ts"

/** One case: what it reports when it cannot run, and how it runs, adding what it found to `results`. */
interface ContractCase {
	name: string
	why: string
	probe: (via: Via, results: ParserResult[]) => Promise<void>
}

/** oat run once against `handle`, hosted through `via`, which serves its spec at `/v1/openapi/spec`. */
async function hostedRun(via: Via, handle: Handle, options: Omit<RunOptions, "baseUrl" | "spec">): Promise<RunResult> {
	const hosted = await via.host(handle)
	try {
		return await run({ baseUrl: hosted.url, ...options, spec: `${hosted.url}/v1/openapi/spec`, ...reach(hosted) })
	} finally {
		await hosted.close()
	}
}

const PROJECT_PRINCIPALS: RunOptions["principals"] = [
	{ headers: { authorization: "Bearer t" }, id: "alpha", roots: { project_id: "p_seed" } },
]

const CHEAP = "cheap profile does not POST extract.once"
const HONOURED = "effects must honour excludedByProfile"

async function profiles(via: Via, results: ParserResult[]): Promise<void> {
	const cheapBackend = projectBackend()
	const cheap = await hostedRun(via, cheapBackend.handle, {
		only: ["project"],
		principals: PROJECT_PRINCIPALS,
		profile: "cheap",
		seed: 1,
	})
	const cheapPosted = cheap.client.transcript.some((e) => e.url.includes("/extract"))
	const skip = cheap.findings.find((f) => f.check === "profile.skip" && f.detail.includes("x-cost: high"))
	results.push({
		detail: `hits=${cheapBackend.extractHits()} skip=${skip?.detail ?? "none"}`,
		name: CHEAP,
		ok: !cheapPosted && skip !== undefined && cheapBackend.extractHits() === 0,
		why: HONOURED,
	})

	const fullBackend = projectBackend()
	const full = await hostedRun(via, fullBackend.handle, {
		only: ["project"],
		principals: PROJECT_PRINCIPALS,
		profile: "full",
		seed: 1,
	})
	const fullPosted = full.client.transcript.some((e) => e.url.includes("/extract"))
	results.push({
		detail: `hits=${fullBackend.extractHits()} posted=${fullPosted}`,
		name: "full profile still invokes extract.once",
		ok: fullPosted && fullBackend.extractHits() > 0,
		why: "cheap is a restriction, not a deletion",
	})
}

const INVITE_PRINCIPALS: RunOptions["principals"] = [
	{ headers: { authorization: "Bearer a" }, id: "alpha", roots: { org_id: "org_1" } },
	{ headers: { authorization: "Bearer b" }, id: "beta", inviteAs: "beta@x.test", roots: { org_id: "org_2" } },
]

async function inviteOnly(via: Via, results: ParserResult[]): Promise<void> {
	const backend = memberBackend()
	const result = await hostedRun(via, backend.handle, { only: ["member"], principals: INVITE_PRINCIPALS, seed: 1 })
	const inviteWithPeer = backend.inviteBodies.some(
		(body) => (body as { invite_email?: unknown } | null | undefined)?.invite_email === "beta@x.test",
	)
	const generated = backend.seedBodies.length > 0
	const ran = result.checksRun.includes("auth.invite-grants-then-revokes")
	results.push({
		detail: `seedJunk=${generated} inviteAsSent=${inviteWithPeer} ran=${ran} bodies=${JSON.stringify(backend.inviteBodies)}`,
		name: "invite-only member is not seeded with a generated email",
		ok: !generated && inviteWithPeer && ran,
		why: "invite check sends inviteAs",
	})
}

const REGISTER_PRINCIPALS: RunOptions["principals"] = [
	{
		auth: {
			credentialFrom: "$.access_token",
			steps: [
				{
					body: { email: "alpha@x.test", password: "pw" },
					headers: { "x-via": "auth" },
					operationId: "auth.registerWithEmail",
				},
				{ body: { email: "alpha@x.test", password: "pw" }, operationId: "auth.login" },
			],
		},
		id: "alpha",
	},
]

async function registerNotSeeded(via: Via, results: ParserResult[]): Promise<void> {
	const backend = userBackend()
	await hostedRun(via, backend.handle, { only: ["user"], principals: REGISTER_PRINCIPALS, seed: 1 })
	results.push({
		detail: `register calls=${backend.registerFrom.join(",") || "none"}`,
		name: "auth.registerWithEmail is not seeded",
		ok: backend.registerFrom.length === 1 && backend.registerFrom[0] === "auth",
		why: "auth-flow creates are provisioned, not fixtures",
	})
}

const CASES: readonly ContractCase[] = [
	{ name: CHEAP, probe: profiles, why: HONOURED },
	{
		name: "invite-only member is not seeded with a generated email",
		probe: inviteOnly,
		why: "invite check sends inviteAs",
	},
	{
		name: "auth.registerWithEmail is not seeded",
		probe: registerNotSeeded,
		why: "auth-flow creates are provisioned, not fixtures",
	},
]

/* The invite operation is modelled as the entity's invite, never as its create. */
function inviteModel(): ParserResult {
	const member = buildModel(dereference(memberSpec()).doc).entities.get("member")
	return {
		detail: `create=${member?.create ?? "none"} invite=${String(member?.invite?.invite)}`,
		name: "invite op is not entity.create",
		ok: member?.create === undefined && member?.invite !== null,
		why: "x-invite stays on entity.invite",
	}
}

/** Every case; one that cannot run fails under its name with the error's message, and the rest still run. */
export async function runSeedContractSuite(via: Via = listening): Promise<ParserResult[]> {
	const results = [...runFixtureWalkCases(), inviteModel()]
	for (const { name, probe, why } of CASES) {
		try {
			await probe(via, results)
		} catch (error) {
			results.push({ detail: messageOf(error), name, ok: false, why })
		}
	}
	return results
}
