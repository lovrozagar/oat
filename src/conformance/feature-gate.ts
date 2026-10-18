/**
 * `x-feature-gate` is a declared fact. These cases prove a matching 403 is coverage, and that
 * the two ways to be wrong — no tag, or a tag that disagrees with `vars.feature` — stay failures.
 */

import { messageOf } from "../errors/message.ts"
import { report } from "../report/console/report.ts"
import type { Finding } from "../runtime/finding.ts"
import { run } from "../runtime/run/index.ts"
import { buildModel } from "../spec/graph/build.ts"
import type { SpecModel } from "../spec/graph/types.ts"
import { dereference } from "../spec/load/dereference.ts"
import type { OpenApiDocument } from "../spec/types.ts"
import { featureGateHarness, type HarnessOptions } from "./feature-gate/harness.ts"
import { webhookSpec } from "./feature-gate/spec.ts"
import { listening, reach, type Via } from "./harness/launch.ts"
import type { ParserResult } from "./harness/result.ts"

/** How one result came out. */
type Outcome = Pick<ParserResult, "ok" | "detail">

/** A run against one harness, judged into the results it names, in order. */
interface GateCase {
	harness: HarnessOptions
	only: string[]
	/** Name and why of each result, the first of which carries the error when the run throws. */
	names: Array<Pick<ParserResult, "name" | "why">>
	judge: (findings: Finding[]) => Outcome[]
}

const PRINCIPALS = [{ headers: { authorization: "Bearer tok_alpha" }, id: "alpha", roots: { org_id: "org_1" } }]

const TAG = "x-feature-gate: webhooks"

function defects(findings: Finding[]): Finding[] {
	return findings.filter((f) => f.verdict !== "COVERAGE_GAP" && f.verdict !== "BLOCKED")
}

function seedOf(findings: Finding[], entity: string): Finding | undefined {
	return findings.find((f) => f.check === "world.seed" && f.entity === entity)
}

/** `items` joined by commas, or "none". */
function listed(items: string[]): string {
	return items.join(",") || "none"
}

const verdicts = (findings: Finding[]): string => listed(findings.map((f) => `${f.verdict}:${f.check}`))

/** A seed that must stay an error: BLOCKED, not excused as a gate. */
function blockedSeed(findings: Finding[]): Outcome[] {
	const seed = seedOf(findings, "webhook")
	return [{ detail: `seed=${seed?.verdict ?? "none"} ${seed?.detail ?? ""}`, ok: seed?.verdict === "BLOCKED" }]
}

const CASES: readonly GateCase[] = [
	{
		harness: { create: "gate-match", specTag: "webhooks" },
		judge: (findings) => {
			const seed = seedOf(findings, "webhook")
			const invite = seedOf(findings, "invite")
			const real = defects(findings)
			const namesTag = seed?.detail.includes(TAG) === true
			return [
				{
					detail: `seed=${seed?.verdict ?? "none"} detail=${seed?.detail ?? "—"} defects=${listed(real.map((f) => f.check))}`,
					ok: seed?.verdict === "COVERAGE_GAP" && namesTag && real.length === 0,
				},
				{
					detail: invite === undefined ? "invite has no world.seed finding" : `${invite.verdict}: ${invite.detail}`,
					ok: invite === undefined && real.length === 0,
				},
			]
		},
		names: [
			{ name: "matching gate 403 is a coverage gap", why: "the backend matched the document" },
			{ name: "untagged invite still seeds", why: "CRUD without the tag is unchanged" },
		],
		only: ["webhook", "invite"],
	},
	{
		harness: { create: "gate-mismatch", specTag: "webhooks" },
		judge: blockedSeed,
		names: [{ name: "mismatched vars.feature stays a seed error", why: "backend/tag drift must not look documented" }],
		only: ["webhook"],
	},
	{
		harness: { create: "plain-403", specTag: null },
		judge: blockedSeed,
		names: [{ name: "untagged 403 stays a seed error", why: "do not treat every 403 as a feature gate" }],
		only: ["webhook"],
	},
	{
		harness: { create: "created", specTag: "webhooks", update: "gate-match" },
		judge: (findings) => {
			const seed = seedOf(findings, "webhook")
			const writeGaps = findings.filter(
				(f) => f.verdict === "COVERAGE_GAP" && f.detail.includes(TAG) && f.check !== "world.seed",
			)
			const real = defects(findings)
			return [
				{
					detail: `seed=${seed?.verdict ?? "none"} writeGaps=${listed(writeGaps.map((f) => f.check))} defects=${verdicts(real)}`,
					ok: seed === undefined && writeGaps.length > 0 && real.length === 0,
				},
			]
		},
		names: [
			{
				name: "gated update after a 201 create is a coverage gap",
				why: "the gate is off for create; a later write still cites the tag",
			},
		],
		only: ["webhook"],
	},
	{
		harness: { create: "gate-match", listSeeded: true, specTag: "webhooks" },
		judge: (findings) => {
			const seed = seedOf(findings, "webhook")
			const real = defects(findings)
			return [
				{
					detail: `seed=${seed?.verdict ?? "none"} defects=${verdicts(real)}`,
					ok: seed?.verdict === "COVERAGE_GAP" && real.length === 0,
				},
			]
		},
		names: [
			{
				name: "gated create with existing rows is not a defect",
				why: "read-only checks may still run against the list, same as excluded create",
			},
		],
		only: ["webhook"],
	},
]

/** oat's findings against a fresh harness, reached through `via`. */
async function against(via: Via, gate: GateCase): Promise<Finding[]> {
	const hosted = await via.host(featureGateHarness(gate.harness))
	try {
		const result = await run({
			baseUrl: hosted.url,
			only: gate.only,
			principals: PRINCIPALS,
			seed: 1,
			spec: `${hosted.url}/v1/openapi/spec`,
			...reach(hosted),
		})
		return result.findings
	} finally {
		await hosted.close()
	}
}

/** One case's results; a run that throws fails the first with its message and the rest as "harness threw". */
async function judged(via: Via, gate: GateCase): Promise<ParserResult[]> {
	let outcomes: Outcome[]
	try {
		outcomes = gate.judge(await against(via, gate))
	} catch (error) {
		outcomes = gate.names.map((_, index) => ({
			detail: index === 0 ? messageOf(error) : "harness threw",
			ok: false,
		}))
	}
	return gate.names.map((named, index) => ({ ...named, ...(outcomes[index] as Outcome) }))
}

/** A non-string `x-feature-gate` reads as no gate. */
function defensiveCase(): ParserResult {
	const { doc } = dereference({
		info: { title: "defensive", version: "1" },
		openapi: "3.1.0",
		paths: {
			"/v1/things": {
				post: {
					operationId: "thing.create",
					responses: { "201": { description: "ok" } },
					"x-entity": { action: "create", identity: "id", name: "thing" },
					"x-feature-gate": { not: "a string" },
				},
			},
		},
	} as OpenApiDocument)
	const featureGate = buildModel(doc).byOperationId.get("thing.create")?.featureGate
	return {
		detail: `featureGate=${String(featureGate)}`,
		name: "non-string x-feature-gate is null",
		ok: featureGate === null,
		why: "same defensive read as x-cost / x-rate-limit",
	}
}

/** `plan` and `doctor` show the tag `tagged` declares on webhook create. */
export function shownCases(tagged: SpecModel): ParserResult[] {
	const plan = report.plan(tagged, false).includes(TAG)
	const doctor = report.doctor(tagged, [], false).text.includes(TAG)
	const why = "doctor / plan should show the tag"
	return [
		{
			detail: plan ? "shown" : "missing from plan",
			name: "plan lists x-feature-gate",
			ok: plan && tagged.byOperationId.get("webhook.create")?.featureGate === "webhooks",
			why,
		},
		{ detail: doctor ? "shown" : "missing from doctor", name: "doctor lists x-feature-gate", ok: doctor, why },
	]
}

export async function runFeatureGateSuite(via: Via = listening): Promise<ParserResult[]> {
	const results = [defensiveCase(), ...shownCases(buildModel(webhookSpec("webhooks")))]
	for (const gate of CASES) results.push(...(await judged(via, gate)))
	return results
}
