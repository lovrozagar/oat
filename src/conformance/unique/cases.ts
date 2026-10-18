/** The unique suite's runs: each case is a harness, and what oat should have made of it. */

import { messageOf } from "../../errors/message.ts"
import type { Via } from "../harness/launch.ts"
import type { ParserResult } from "../harness/result.ts"
import { against, type HarnessOptions, type Outcome } from "./backend.ts"
import * as judge from "./judges.ts"

/** One result a run is judged for. */
interface Judged {
	name: string
	why: string
	judge: (outcome: Outcome) => judge.Verdict
}

/** One run, and every result it is judged for. */
export interface UniqueCase {
	options: HarnessOptions
	judged: readonly Judged[]
}

/** Every run, in the order the suite reports them. */
export const UNIQUE_CASES: readonly UniqueCase[] = [
	{
		judged: [
			{
				judge: judge.untaggedNotProbed,
				name: "missing tag does not run unique checks",
				why: "do not infer uniqueness",
			},
		],
		options: { spec: { omitTag: true } },
	},
	{
		judged: [
			{
				judge: judge.duplicateRefused,
				name: "409 duplicate create is not BACKEND_BUG",
				why: "the backend matched the document",
			},
		],
		options: { duplicate: "409", spec: {}, updateDuplicate: "409" },
	},
	{
		judged: [
			{
				judge: judge.duplicateInserted,
				name: "201 duplicate create is BACKEND_BUG",
				why: "a unique constraint that inserts is a backend bug",
			},
		],
		options: { duplicate: "201", spec: {}, updateDuplicate: "ok" },
	},
	{
		judged: [
			{ judge: judge.listKept, name: "list does not grow on 409", why: "cardinality is part of the unique pass" },
		],
		options: { duplicate: "409", spec: {} },
	},
	{
		judged: [
			{ judge: judge.oneSetInserted, name: "one 2xx set fails the check (not OR'd)", why: "probe each set separately" },
		],
		options: { duplicate: "per-set", spec: { tag: [["name"], ["slug"]] }, updateDuplicate: "ok" },
	},
	{
		judged: [
			{
				judge: judge.createNotProbed,
				name: "generated-only unique set is skipped",
				why: "a set with no body columns is not a fail",
			},
		],
		options: { spec: { generated: ["id"], omitTag: false, tag: [["id"]] } },
	},
	{
		judged: [
			{
				judge: judge.updateNotProbed,
				name: "all-x-immutable update set is skipped",
				why: "immutable unique columns are not a unique PATCH probe",
			},
		],
		options: {
			spec: {
				generated: ["id", "workspace_id"],
				immutable: ["workspace_id"],
				tag: [["workspace_id"]],
				updateBody: ["workspace_id", "name"],
			},
			updateDuplicate: "ok",
		},
	},
	{
		judged: [{ judge: judge.updateRefused, name: "colliding PATCH 409 passes", why: "same scoring as create" }],
		options: { duplicate: "409", spec: {}, updateDuplicate: "409" },
	},
	{
		judged: [
			{
				judge: judge.updateApplied,
				name: "colliding PATCH 2xx is BACKEND_BUG",
				why: "update unique is the same class as create",
			},
		],
		options: { duplicate: "409", spec: {}, updateDuplicate: "201" },
	},
	{
		judged: [
			{ judge: judge.freshKey, name: "unique probe does not reuse Idempotency-Key", why: "omit or send a fresh key" },
		],
		options: { duplicate: "409", spec: { idempotencyRequired: true } },
	},
	{
		judged: [
			{
				judge: judge.driftReported,
				name: "409 schema drift still reports",
				why: "coverage is not a free pass for an undeclared body",
			},
		],
		options: { duplicate: "409-drift", spec: {}, updateDuplicate: "ok" },
	},
	{
		judged: [
			{
				judge: judge.coverageNotPass,
				name: "feature-gate 403 on the probe is coverage, not a unique pass",
				why: "do not score a documented 403 as 409",
			},
		],
		options: { duplicate: "gate-403", spec: { featureGate: "widgets" }, updateDuplicate: "ok" },
	},
	{
		judged: [
			{
				judge: judge.coverageNotPass,
				name: "402 on the probe is coverage, not a unique pass",
				why: "plan limit is not a unique 409",
			},
		],
		options: { duplicate: "402", spec: {}, updateDuplicate: "ok" },
	},
	{
		judged: [
			{
				judge: judge.seedAdopted,
				name: "tagged seed 409 + nonempty list adopts",
				why: "world.seed is COVERAGE_GAP naming x-unique, not BLOCKED",
			},
			{
				judge: judge.probedAfterAdopt,
				name: "unique check still runs after unique-409 adopt",
				why: "do not stand unique probes down with write-path skips",
			},
			{
				judge: judge.seedNotEvidence,
				name: "seed 409 is not the unique check passing",
				why: "that check is the explicit second POST",
			},
		],
		options: { duplicate: "409", listSeeded: true, seedConflict: true, spec: {}, updateDuplicate: "ok" },
	},
	{
		judged: [{ judge: judge.seedBlocked, name: "tagged seed 409 + empty list is BLOCKED", why: "could not seed" }],
		options: { seedConflict: true, spec: {} },
	},
	{
		judged: [
			{
				judge: judge.seedBlocked,
				name: "untagged seed 409 is still a seed failure",
				why: "do not treat every 409 as unique",
			},
			{
				judge: judge.untaggedNotAdopted,
				name: "untagged 409 does not adopt as x-unique",
				why: "no tag, no unique adopt",
			},
		],
		options: { seedConflict: true, spec: { omitTag: true } },
	},
	{
		judged: [
			{
				judge: judge.distinctInserted,
				name: "409 duplicate and 201 distinct passes",
				why: "the cohort still inserts distinct unique values",
			},
		],
		options: { duplicate: "409", spec: {} },
	},
	{
		judged: [
			{
				judge: judge.noneProbed,
				name: "explicit empty x-unique does not run the check",
				why: "[] after filter is none",
			},
		],
		options: { spec: { tag: [] } },
	},
]

/** One case run through `via`, judged; a run that fails fails every result it was judged for. */
export async function runCase(via: Via, { judged, options }: UniqueCase): Promise<ParserResult[]> {
	try {
		const outcome = await against(via, options)
		return judged.map((one) => {
			const { detail, ok } = one.judge(outcome)
			return { detail, name: one.name, ok, why: one.why }
		})
	} catch (error) {
		const detail = messageOf(error)
		return judged.map(({ name, why }) => ({ detail, name, ok: false, why }))
	}
}
