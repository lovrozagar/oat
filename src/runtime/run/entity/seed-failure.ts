import type { OperationModel } from "../../../spec/graph/types.ts"
import type { Exchange } from "../../exchange.ts"
import { FencedError } from "../../fence.ts"
import { isOverflowError, overflowFrom } from "../../fixture.ts"
import { isNetworkError } from "../../../errors/network.ts"
import { SeedError } from "../../seed-error.ts"
import { existingOrBlocked } from "./fallback.ts"
import type { EntityRun, World } from "./state.ts"
import { messageOf } from "../../../errors/message.ts"
import type { RunFindingId } from "../../check-ids.ts"

/**
 * A seed that threw: the network went away, a request was fenced, the fixtures overflowed, or the
 * create failed. Each is reported as what it is; where records already exist, the entity is
 * still read against them.
 */
export async function seedFailed(run: EntityRun, createOp: OperationModel, error: unknown): Promise<World | null> {
	const { entity, findings, ctx } = run
	if (isNetworkError(error)) {
		await ctx.network.note(error, entity.name)
		return null
	}
	if (error instanceof FencedError) {
		findings.blocked(
			"world.seed" satisfies RunFindingId,
			entity.name,
			`seeding "${entity.name}" was fenced: ${error.request.reason}`,
			`${error.message}. The request was never sent, so "${entity.name}" has no cohort to test.`,
		)
		return null
	}
	if (isOverflowError(error)) {
		const overflow = overflowFrom(error, createOp.operationId)
		findings.gap("world.seed" satisfies RunFindingId, entity.name, overflow.message, overflow.message)
		return existingOrBlocked(run, {
			check: "world.seed" satisfies RunFindingId,
			detail: overflow.message,
			summary: `could not seed "${entity.name}"`,
		})
	}
	return createFailed(run, createOp, error)
}

/** What a failed create left: which operation failed, how, and the exchange that shows it. */
interface Failure {
	cause: string
	message: string
	failedOp: string
	evidence: Exchange[]
	/**
	 * Under --ops a create nobody targeted is support. Its failure leaves the targets ungraded —
	 * blocked, with the evidence — but it is not what this run was asked to judge, so it is not
	 * reported as a defect of its own.
	 */
	support: boolean
}

async function createFailed(run: EntityRun, createOp: OperationModel, error: unknown): Promise<World | null> {
	const { entity, findings } = run
	const failure = await failureOf(run, createOp, error)
	const status = error instanceof SeedError ? error.status : undefined
	/* A create that fails with 5xx is not a fixture problem — it is the defect. Reporting it as
	 * merely "blocked" buries the most serious thing oat found. */
	if (status !== undefined && status >= 500 && !failure.support) {
		run.ctx.findings
			.attributed([failure.failedOp])
			.backend(
				"create.does-not-error" satisfies RunFindingId,
				entity.name,
				`creating a "${entity.name}" fails with a server error`,
				`${failure.message}. The request body was generated from the documented schema, so ` +
					"either the handler rejects input the document permits, or it is failing " +
					"outright. Everything downstream of this entity is untestable until it is " +
					"fixed.",
				failure.evidence,
			)
	}
	/* A backend whose create is broken can still have a working list. */
	const world = await existingOrBlocked(run, {
		check: "world.seed" satisfies RunFindingId,
		detail: failure.support
			? `support operation ${failure.failedOp} failing: ${failure.message}`
			: `${failure.cause}: ${failure.message}`,
		evidence: failure.evidence,
		summary: `could not seed "${entity.name}"`,
	})
	if (world === null) return null
	findings.gap(
		"world.seed" satisfies RunFindingId,
		entity.name,
		`seeding "${entity.name}" failed; running read-only checks against existing records`,
		`${failure.cause}: ${failure.message}. Write-path and lifecycle checks are skipped for this entity.`,
	)
	return world
}

async function failureOf(run: EntityRun, createOp: OperationModel, error: unknown): Promise<Failure> {
	const { client, scope } = run.ctx
	const seedError = error instanceof SeedError ? error : undefined
	const failedOp = seedError?.operationId ?? createOp.operationId
	const evidence =
		seedError?.exchange === undefined
			? await Promise.all(
					client.transcript
						.filter((exchange) => exchange.status >= 500)
						.slice(-1)
						.map((exchange) => client.hydrate(exchange)),
				)
			: [seedError.exchange]
	return {
		cause: seedError?.culprit ?? "unknown",
		evidence,
		failedOp,
		message: messageOf(error),
		support: scope.mode === "targeted" && !scope.inScope(failedOp),
	}
}
