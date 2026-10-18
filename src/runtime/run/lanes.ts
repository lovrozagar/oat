import type { EntityModel, SpecModel } from "../../spec/graph/types.ts"
import type { RunContext } from "./context.ts"
import { testEntity } from "./entity/test-entity.ts"
import { errorText } from "./errors.ts"
import { stopped } from "./interrupt.ts"
import type { RunFindingId } from "../check-ids.ts"

/**
 * Tests every entity in scope, lane by lane.
 *
 * Checks inside an entity stay ordered because cascade suppression consults findings already
 * reported for it — concurrent checks would let a root cause and its consequences race and both
 * be reported. Nested graphs couple entities too: a child create in flight while a parent
 * page-walk runs invents pagination findings. So entities that can observe each other share a
 * lane and run in series, and only lanes run side by side.
 */
export async function runLanes(ctx: RunContext): Promise<void> {
	const { findings, model, scope, progress, state } = ctx
	const queue = scope.entities
	progress.entityTotal = queue.length
	const run: LaneRun = { ctx, queue, started: 0, stopNoted: false }
	const before = findings.findings.length
	/* Each entity's errors are caught where it runs: a lane always finishes. */
	await Promise.all(entityLanes(model, queue).map((lane) => runLane(run, lane)))
	/* Lanes finish in whatever order the backend answers; the result and the reports read in plan
	 * order, so two runs of one document list the same things in the same place. */
	const planIndex = new Map(queue.map((entity, index) => [entity.name, index]))
	/* A finding about the run itself, not an entity, reads after them all. */
	const rank = (name: string): number => planIndex.get(name) ?? queue.length
	const byPlan = (a: string, b: string): number => rank(a) - rank(b)
	state.entitiesTested.sort(byPlan)
	const fromLanes = findings.findings.splice(before).sort((a, b) => byPlan(a.entity, b.entity))
	findings.findings.push(...fromLanes)
}

/** The lanes' shared count of entities started, and whether the stop was already reported. */
interface LaneRun {
	ctx: RunContext
	queue: readonly EntityModel[]
	started: number
	stopNoted: boolean
}

async function runLane(run: LaneRun, lane: readonly EntityModel[]): Promise<void> {
	const { ctx } = run
	for (const entity of lane) {
		/* Stopped from outside — Ctrl-C, a deadline — or the network is gone. Nothing more is
		 * tested, and everything made so far is still removed. */
		if (stopped(ctx)) {
			noteStop(run)
			return
		}
		run.started += 1
		ctx.progress.entityIndex = run.started
		try {
			await testEntity(ctx, entity)
		} catch (error) {
			/* An error oat did not expect must not skip teardown: it is reported, and the run
			 * carries on to remove what it made and write its report. */
			ctx.findings.blocked("run.error" satisfies RunFindingId, entity.name, {
				summary: `testing "${entity.name}" stopped on an unexpected error`,
				cause: errorText(error),
			})
		}
	}
}

function noteStop(run: LaneRun): void {
	if (run.stopNoted) return
	run.stopNoted = true
	const { options, findings, state } = run.ctx
	const left = run.queue.length - run.started
	const remaining = `${left} remaining entit${left === 1 ? "y" : "ies"}`
	if (options.signal?.aborted === true) {
		state.interrupted = true
		findings.gap("run.interrupted" satisfies RunFindingId, "run", {
			summary: `stopped before ${remaining}`,
			detail: "the run was interrupted; what was tested is reported, and what oat created is removed",
		})
		return
	}
	findings.blocked("net.unreachable" satisfies RunFindingId, "run", {
		summary: `skipped ${remaining}`,
		cause: "network down",
	})
}

/**
 * Entities grouped into lanes that can be tested side by side.
 *
 * Two entities share a lane when one can observe the other's writes: one's collection lives
 * under the other's (a child, created inside a parent oat also makes), an operation of one
 * invalidates a route of the other, or one's effects, waits or async polls land on the other.
 * Inside a lane entities keep their order and run one after another; lanes share nothing, so
 * nothing one does can turn up as a finding in another.
 */
export function entityLanes(model: SpecModel, entities: readonly EntityModel[]): EntityModel[][] {
	const parent = new Map(entities.map((entity) => [entity.name, entity.name]))
	/* Every name passed in is a queued entity's, and every parent is one too. */
	const find = (name: string): string => {
		let root = name
		while (parent.get(root) !== root) root = parent.get(root) as string
		return root
	}
	const join = (a: string | null | undefined, b: string | null | undefined): void => {
		if (a === null || a === undefined || b === null || b === undefined) return
		if (!parent.has(a) || !parent.has(b)) return
		parent.set(find(a), find(b))
	}
	joinNested(model, entities, join)
	for (const op of model.operations) {
		for (const route of op.invalidates) join(op.entity, model.byRoute.get(route)?.entity)
		for (const effect of op.effects) join(op.entity, effect.entity)
		if (op.wait !== null) join(op.entity, model.byOperationId.get(op.wait.operationId)?.entity)
		if (op.async !== null) {
			const poll = model.byOperationId.get(op.async.poll) ?? model.byRoute.get(op.async.poll)
			join(op.entity, poll?.entity)
		}
	}
	const lanes = new Map<string, EntityModel[]>()
	for (const entity of entities) {
		const root = find(entity.name)
		lanes.set(root, [...(lanes.get(root) ?? []), entity])
	}
	return [...lanes.values()]
}

/* A collection under another's path is a child of it: the two share a lane. */
function joinNested(model: SpecModel, entities: readonly EntityModel[], join: (a: string, b: string) => void): void {
	const collection = (entity: EntityModel): string | undefined =>
		model.byOperationId.get(entity.list ?? entity.create ?? "")?.path.replace(/\/+$/, "")
	for (const a of entities) {
		const pathA = collection(a)
		if (pathA === undefined) continue
		for (const b of entities) {
			const pathB = collection(b)
			if (a !== b && pathB !== undefined && pathB.startsWith(`${pathA}/`)) join(a.name, b.name)
		}
	}
}
