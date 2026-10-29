import { describe, expect, it } from "vitest"
import { UnsatisfiedSecurity } from "../../client/credential-source.ts"
import type { CheckId } from "../check-ids.ts"
import type { OperationCheck } from "../checks/core/check.ts"
import { defineCheck } from "../checks/core/define.ts"
import { targetPlan } from "../checks/core/operation.ts"
import type { OperationContext, OperationWriteContext } from "../checks/core/operation-context.ts"
import { cannot, ready } from "../checks/core/plan.ts"
import { FencedError } from "../fence.ts"
import { ASSERTED, asserted } from "../finding.ts"
import type { Record_ } from "../world/records.ts"
import { contextOf, ledgerNotes, LOGIN, notesApi, notesDoc, optionsFor, withLogin } from "./__fixtures__/api.ts"
import type { RunContext } from "./context.ts"
import { runReadSecurity, runWriteSecurity } from "./security.ts"
import { trackCreates } from "./teardown.ts"

/*
 * The stage schedules each probe, a check on one operation, by its placement: a collection read
 * before the lanes, concurrently; a read of one record after them, concurrently; a write, or any probe
 * of a check that changes a credential, after them alone and in order, on a record the run created.
 * The backend here applies every write.
 */

const AS_ALPHA = { as: { principal: "alpha" } }

/** A read-only stub operation check whose run hands its context to `run`. */
function reader(
	id: CheckId,
	run: (ctx: OperationContext) => unknown,
	more: { mutatesCredentials?: true } = {},
): OperationCheck {
	return defineCheck<string>({
		id,
		plan: (ctx) => ready(ctx.operation.operationId),
		run: async (ctx) => {
			await run(ctx)
			return ASSERTED
		},
		subject: "operation",
		...more,
	})
}

/** A stub operation check some of whose probes write. */
function writer(id: CheckId, run: (ctx: OperationWriteContext) => unknown): OperationCheck {
	return defineCheck<string>({
		id,
		mutates: true,
		plan: (ctx) => ready(ctx.operation.operationId),
		run: async (ctx) => {
			await run(ctx)
			return ASSERTED
		},
		subject: "operation",
	})
}

/** A run over a notes API that applies every write, with `count` run-created notes ledgered as alpha. */
async function running(rows: Record_[], count: number): Promise<RunContext> {
	const ctx = await contextOf(
		optionsFor(notesApi(notesDoc(), rows), { ops: ["notes.update", "notes.get", "notes.list"] }),
	)
	const ids = Array.from({ length: count }, (_, n) => `run-${n + 1}`)
	for (const [n, id] of ids.entries()) rows.push({ id, title: `t${n + 1}` })
	ledgerNotes(ctx, ids)
	return ctx
}

describe("the security stage: where each probe runs", () => {
	it("runs only the collection reads before the lanes, with no target, the run's nonce, and a read placement", async () => {
		const ctx = await running([{ id: "pre", title: "there before" }], 1)
		const seen: string[] = []
		await runReadSecurity(ctx, [
			reader("response.no-server-error", (c) => {
				seen.push(`${c.operation.operationId} ${c.placement} ${String(c.target)} ${c.nonce === ctx.nonce}`)
			}),
		])
		expect(seen).toEqual(["notes.list read undefined true"])
	})

	it("plans one check's collection GET before the lanes and its item read and write after, reads first", async () => {
		const ctx = await running([], 1)
		const order: string[] = []
		const check = writer("response.status-is-documented", (c) => {
			order.push(`${c.operation.operationId} ${c.placement} ${c.target?.id ?? "-"}`)
		})
		await runReadSecurity(ctx, [check])
		expect(order).toEqual(["notes.list read -"])
		await runWriteSecurity(ctx, [check])
		expect(order).toEqual(["notes.list read -", "notes.get item-read run-1", "notes.update write run-1"])
	})

	it("runs every probe of a check that changes a credential after the lanes, a collection read among them", async () => {
		const ctx = await running([], 1)
		const ran: string[] = []
		const revoking = reader("response.no-server-error", (c) => ran.push(`${c.operation.operationId} ${c.placement}`), {
			mutatesCredentials: true,
		})
		await runReadSecurity(ctx, [revoking])
		expect(ran).toEqual([])
		await runWriteSecurity(ctx, [revoking])
		expect(ran).toEqual(["notes.list write", "notes.get write", "notes.update write"])
	})
})

describe("the security stage: concurrency", () => {
	it("runs the reads of one record concurrently, and the writes one at a time", async () => {
		const ctx = await running([], 1)
		const events: string[] = []
		let release!: () => void
		const bothStarted = new Promise<void>((resolve) => {
			release = resolve
		})
		let started = 0
		const waiting = (id: CheckId): OperationCheck =>
			writer(id, async (c) => {
				events.push(`start ${c.operation.operationId}`)
				if (c.placement === "item-read" && ++started === 2) release()
				if (c.placement === "item-read") await bothStarted
				events.push(`end ${c.operation.operationId}`)
			})
		await runWriteSecurity(ctx, [waiting("response.no-server-error"), waiting("response.status-is-documented")])
		expect(events).toEqual([
			"start notes.get",
			"start notes.get",
			"end notes.get",
			"end notes.get",
			"start notes.update",
			"end notes.update",
			"start notes.update",
			"end notes.update",
		])
	})
})

describe("the security stage: targets", () => {
	it("gives a write probe only a record this run created, with its current state as the body", async () => {
		const rows: Record_[] = [{ id: "pre", title: "foreign" }]
		const ctx = await running(rows, 1)
		const targeted: Array<{ id: string; current: unknown }> = []
		await runWriteSecurity(ctx, [
			writer("response.status-is-documented", async (c) => {
				if (c.placement !== "write" || c.target === undefined) return
				targeted.push({ current: c.target.current, id: c.target.id })
				await c.client.request("PATCH", c.target.path, { ...AS_ALPHA, body: c.target.current })
			}),
		])
		expect(targeted).toEqual([{ current: { id: "run-1", title: "t1" }, id: "run-1" }])
		expect(rows).toEqual([
			{ id: "pre", title: "foreign" },
			{ id: "run-1", title: "t1" },
		])
	})

	it("stands an item read and a write down with the reason when the run created no record for them", async () => {
		const ctx = await running([], 0)
		const ran: string[] = []
		const targeted = defineCheck({
			id: "response.status-is-documented",
			mutates: true,
			plan: targetPlan,
			run: async (c) => {
				ran.push(c.subject)
				return ASSERTED
			},
			subject: "operation",
		})
		await runWriteSecurity(ctx, [targeted])
		expect(ran).toEqual([])
		expect(ctx.state.checksSkipped.map((skipped) => skipped.needs)).toEqual([
			"a record this run created that notes.get can be sent to",
			"a record this run created that notes.update can be sent to",
		])
	})
})

describe("the security stage: a target its creator's BLOCKED credential cannot read back", () => {
	it("reports each check behind it as stopped by the block, naming the check, never stood down", async () => {
		const ctx = await running([], 1)
		ctx.store.block({ principal: "alpha", scheme: "bearer" }, "the new credential is refused")
		const ran: string[] = []
		const targeted = defineCheck({
			id: "response.status-is-documented",
			mutates: true,
			plan: targetPlan,
			run: async (c) => {
				ran.push(c.subject)
				return ASSERTED
			},
			subject: "operation",
		})
		await runWriteSecurity(ctx, [targeted])
		expect(ran).toEqual([])
		expect(ctx.state.checksSkipped).toEqual([])
		expect(ctx.findings.findings.map((finding) => [finding.check, finding.verdict, finding.summary])).toEqual([
			["auth.blocked", "BLOCKED", "response.status-is-documented needed a credential that is BLOCKED"],
			["auth.blocked", "BLOCKED", "response.status-is-documented needed a credential that is BLOCKED"],
		])
		expect(ctx.findings.findings.map((finding) => finding.operations)).toEqual([["notes.get"], ["notes.update"]])
	})

	it("reports it by the cause the plan carries, not its words: a reworded stand-down is still stopped", async () => {
		const ctx = await running([], 1)
		ctx.store.block({ principal: "alpha", scheme: "bearer" }, "the new credential is refused")
		const reworded = defineCheck({
			id: "response.status-is-documented",
			mutates: true,
			plan: (c) => {
				const target = targetPlan(c)
				return target.ok ? target : { ...target, needs: "a record of my own to write to" }
			},
			run: async () => ASSERTED,
			subject: "operation",
		})
		await runWriteSecurity(ctx, [reworded])
		expect(ctx.state.checksSkipped).toEqual([])
		expect(ctx.findings.findings.map((finding) => finding.summary)).toEqual([
			"response.status-is-documented needed a credential that is BLOCKED",
			"response.status-is-documented needed a credential that is BLOCKED",
		])
	})
})

describe("the security stage: a DELETE probe's target", () => {
	it("sends a DELETE probe to a throwaway of its own, and stands it down with the reason when there is none", async () => {
		const rows: Record_[] = []
		const ctx = await contextOf(optionsFor(notesApi(notesDoc(), rows), { ops: ["notes.delete"] }))
		trackCreates(ctx)
		const targeted: string[] = []
		const deleting = defineCheck({
			id: "response.status-is-documented",
			mutates: true,
			plan: targetPlan,
			run: async (_c, target) => {
				targeted.push(target.id)
				return ASSERTED
			},
			subject: "operation",
		})
		await runWriteSecurity(ctx, [deleting])
		rows.push({ id: "run-1", title: "t1" })
		ledgerNotes(ctx, ["run-1"])
		await runWriteSecurity(ctx, [deleting])
		expect(ctx.state.checksSkipped.map((skipped) => skipped.needs)).toEqual([
			"a record this run created that notes.delete can be sent to",
		])
		expect(targeted).toEqual(["n1"])
	})
})

/** A check whose plan cannot run: its own reason on an item read, none elsewhere, and `reason` as its needs. */
const needing = (reason?: string) =>
	defineCheck({
		id: "response.no-server-error",
		...(reason === undefined ? {} : { needs: reason }),
		plan: (c) => (c.operation.operationId === "notes.get" ? cannot("its own reason") : cannot()),
		run: async () => ASSERTED,
		subject: "operation",
	})

describe("the security stage: planning and outcomes", () => {
	it("stands a check down with the reason its plan gives, else its own needs, else an unstated precondition", async () => {
		const ctx = await running([], 1)
		await runWriteSecurity(ctx, [needing("the fallback need")])
		await runWriteSecurity(ctx, [needing()])
		expect(ctx.state.checksSkipped.map((skipped) => `${skipped.entity}: ${skipped.needs}`)).toEqual([
			"notes.get: its own reason",
			"notes.update: the fallback need",
			"notes.get: its own reason",
			"notes.update: an unstated precondition",
		])
	})

	it("records an assertion's note, and maps an unsatisfied credential to untested and any other throw to a gap", async () => {
		const ctx = await running([], 1)
		const noted = defineCheck({
			id: "response.no-server-error",
			plan: () => ready(1),
			run: async () => asserted("the backend 404s cleanly"),
			subject: "operation",
		})
		await runReadSecurity(ctx, [noted])
		expect(ctx.state.checkNotes).toEqual([
			{ check: "response.no-server-error", entity: "notes.list", note: "the backend 404s cleanly" },
		])
		await runReadSecurity(ctx, [
			reader("response.contract-call", () => {
				throw new UnsatisfiedSecurity("unsatisfied", "no credential for jwt")
			}),
			reader("response.status-is-documented", () => {
				throw new Error("the probe blew up")
			}),
			reader("schema.error-response-matches-document", () => {
				throw "a bare string"
			}),
		])
		expect(ctx.findings.findings.map((finding) => `${finding.check} ${finding.verdict} ${finding.detail}`)).toEqual([
			"response.status-is-documented COVERAGE_GAP notes.list: the probe blew up",
			"schema.error-response-matches-document COVERAGE_GAP notes.list: a bare string",
		])
	})
})

describe("the security stage: grades and stops", () => {
	it("grades each operation as probed, so the contract floor still calls it", async () => {
		const ctx = await running([], 1)
		await runReadSecurity(ctx, [reader("response.no-server-error", () => undefined)])
		expect([...(ctx.grades.ran.get("notes.list") ?? [])]).toEqual(["response.no-server-error"])
		expect(ctx.grades.judged("notes.list")).toBe(false)
	})

	it("reports a fenced probe under the fence, attributed to its operation, and leaves it unresolved", async () => {
		const ctx = await running([], 1)
		await runReadSecurity(ctx, [
			reader("response.no-server-error", () => {
				throw new FencedError({ method: "GET", phase: "assertion", reason: "no reads", url: "/notes" })
			}),
		])
		expect(ctx.findings.findings.map((finding) => [finding.check, finding.verdict, finding.operations])).toEqual([
			["fence", "BLOCKED", ["notes.list"]],
		])
		expect(ctx.state.checksSkipped).toEqual([])
	})
})

describe("the security stage: principals and attribution", () => {
	it("gives a check the peer principal when a second tenant is configured", async () => {
		const principals = { alpha: { tenant: "t1" }, beta: { readOnly: true, tenant: "t2" } } as const
		const ctx = await contextOf(optionsFor(withLogin(), { ops: ["notes.list"], principals, security: LOGIN }))
		const peers: Array<string | undefined> = []
		await runReadSecurity(ctx, [
			reader("response.no-server-error", (c) =>
				peers.push(`${c.peer?.id} ${c.principals.map((p) => p.readOnly === true)}`),
			),
		])
		expect(peers).toEqual(["beta false,true"])
	})

	it("attributes a finding to the operation the probe judges", async () => {
		const ctx = await running([], 1)
		await runReadSecurity(ctx, [
			reader("response.no-server-error", (c) =>
				c.findings.security("response.no-server-error", c.subject, { detail: "d", evidence: [], summary: "accepted" }),
			),
		])
		expect(ctx.findings.findings.map((finding) => finding.operations)).toEqual([["notes.list"]])
	})
})

/** A read-only stub that runs only when the config switches it on. */
const optedIn = (ran: string[]): OperationCheck =>
	defineCheck<string>({
		id: "auth.login-throttled",
		optIn: true,
		plan: (ctx) => ready(ctx.subject),
		run: async (ctx) => {
			ran.push(ctx.subject)
			return ASSERTED
		},
		subject: "operation",
	})

describe("the security stage: opt-in checks", () => {
	it("skips an opt-in check as untested, saying how to opt in, when the config does not switch it on", async () => {
		const ctx = await running([], 1)
		const ran: string[] = []
		await runReadSecurity(ctx, [optedIn(ran)])
		expect(ran).toEqual([])
		expect(ctx.state.checksSkipped).toEqual([
			{
				check: "auth.login-throttled",
				entity: "notes.list",
				needs: 'opt in with checks: { "auth.login-throttled": true }',
			},
		])
	})

	it("runs an opt-in check where the config switches it on", async () => {
		const ctx = await running([], 1)
		const ran: string[] = []
		await runReadSecurity({ ...ctx, options: { ...ctx.options, checks: { "auth.login-throttled": true } } }, [
			optedIn(ran),
		])
		expect(ran).toEqual(["notes.list"])
	})
})

/* The stage's read-backs of a run-created record: `purpose: "probe"` GETs, no check's own. */
const targetReadsOf = (ctx: RunContext): string[] =>
	ctx.client.transcript
		.filter((exchange) => exchange.purpose === "probe" && exchange.method === "GET")
		.map((exchange) => ctx.client.relativePath(exchange.url))

describe("the security stage: target reads", () => {
	it("reads a record back once for every probe kind and operation that names it", async () => {
		const ctx = await running([], 1)
		const kinds: CheckId[] = ["response.no-server-error", "response.status-is-documented", "response.contract-call"]
		const bodies: unknown[] = []
		await runWriteSecurity(
			ctx,
			kinds.map((id) => writer(id, (c) => bodies.push(c.target?.current))),
		)
		expect(targetReadsOf(ctx)).toEqual(["/notes/run-1"])
		expect(bodies).toHaveLength(6)
		expect(new Set(bodies).size).toBe(6)
	})

	it("reads the record afresh for a write probe after another probe kind's write to it went through", async () => {
		const ctx = await running([], 1)
		const bodies: unknown[] = []
		const patching = writer("response.no-server-error", async (c) => {
			if (c.placement !== "write" || c.target === undefined) return
			await c.client.request("PATCH", c.target.path, { ...AS_ALPHA, body: { title: "changed" } })
		})
		const reading = writer("response.status-is-documented", (c) => {
			if (c.placement === "write") bodies.push(c.target?.current)
		})
		await runWriteSecurity(ctx, [patching, reading])
		expect(bodies).toEqual([{ id: "run-1", title: "changed" }])
		expect(targetReadsOf(ctx)).toEqual(["/notes/run-1", "/notes/run-1"])
	})
})

describe("the security stage: volume", () => {
	it("sends each probe kind to one target per operation, however many records the run created", async () => {
		const ctx = await running([], 3)
		await runReadSecurity(ctx)
		await runWriteSecurity(ctx)
		const targets = new Map<string, Set<string>>()
		for (const exchange of ctx.client.transcript) {
			if (exchange.check === undefined || !exchange.check.startsWith("auth.")) continue
			const key = `${exchange.check} ${String(exchange.operationId)}`
			targets.set(key, (targets.get(key) ?? new Set()).add(ctx.client.relativePath(exchange.url)))
		}
		expect(targets.size).toBeGreaterThan(0)
		expect([...targets].filter(([, paths]) => paths.size > 1)).toEqual([])
	})
})
