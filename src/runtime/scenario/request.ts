/**
 * A request step: sent as the scenario's principal, another configured one, or anonymously, and
 * re-sent within its poll window until what it asserts shows.
 */

import type { Actor } from "../../client/credential-source.ts"
import type { ScenarioRequestStep } from "../../config/types/steps.ts"
import { resolveRequest } from "../steps/request.ts"
import type { Exchange } from "../exchange.ts"
import { blamed, ScenarioStopped, StepFailure } from "./failure.ts"
import { durationMs, nextPollWait } from "./poll.ts"
import { record } from "./record.ts"
import { principalOf } from "./state.ts"
import type { ScenarioRun } from "./types.ts"
import { stepOperation } from "./validate.ts"
import { holds, type Want, wantsOf } from "./want.ts"

type Resolved = Awaited<ReturnType<typeof resolveRequest>>

export async function requestStep(run: ScenarioRun, step: ScenarioRequestStep, index: number): Promise<void> {
	const stepOp = stepOperation(step)
	const deadline = step.poll === undefined ? 0 : Date.now() + durationMs(step.poll.within)
	let waitMs = step.poll?.everyMs ?? 500
	for (;;) {
		const { exchange, request } = await send(run, { index, step, stepOp })
		const ok = succeeded(step, exchange)
		const wants = wantsOf(step, run.scope)
		const unmet = wants.find(({ want }) => !holds(exchange, want.from, want))?.want
		if (ok && unmet === undefined) {
			record(run, { exchange, step, stepOp, wants })
			return
		}
		if (Date.now() < deadline) {
			if (run.input.stopped?.() === true) throw new ScenarioStopped()
			await run.sleep(waitMs)
			if (run.input.stopped?.() === true) throw new ScenarioStopped()
			waitMs = nextPollWait(waitMs, step.poll?.everyMs ?? 500)
			continue
		}
		throw unshown(run, { exchange, ok, request, stepOp, unmet, wants })
	}
}

/** The step's request, resolved against the scope and sent as the actor it names, through its origin's client. */
async function send(
	run: ScenarioRun,
	at: { step: ScenarioRequestStep; index: number; stepOp: string | undefined },
): Promise<{ exchange: Exchange; request: Resolved }> {
	const { step, stepOp } = at
	const request = await resolveRequest(run.context, step, run.scope, at.index)
	const exchange = await request.client.request(request.method, request.path, {
		...(request.body === undefined ? {} : { body: request.body }),
		...(request.contentType === undefined ? {} : { contentType: request.contentType }),
		as: actorOf(run, step),
		headers: request.headers ?? {},
		...(request.query === undefined ? {} : { query: request.query }),
		...(stepOp === undefined ? {} : { operationId: stepOp }),
		...(request.redirect === undefined ? {} : { redirect: request.redirect }),
	})
	run.sent.push(exchange)
	return { exchange, request }
}

/** Nobody for an anonymous step, else the principal the step names or the scenario's, on the scheme it names. */
function actorOf(run: ScenarioRun, step: ScenarioRequestStep): Actor {
	if (step.anonymous === true) return { anonymous: true }
	const principal = step.principal ?? run.principal
	/* Refuses a principal the config does not have, before anything is sent as it. */
	principalOf(run.input, run.scenario, principal)
	return step.scheme === undefined ? { principal } : { principal, scheme: step.scheme }
}

function succeeded(step: ScenarioRequestStep, exchange: Exchange): boolean {
	const accepted = step.expect ?? []
	if (accepted.length > 0) return accepted.includes(exchange.status)
	return exchange.status >= 200 && exchange.status < 300
}

/**
 * The failure of a step whose window ran out: a refused request blames the step's operation, an
 * unmet assert blames every operation it would have proved. The calls those operations already
 * made are evidence beside this one.
 */
function unshown(
	run: ScenarioRun,
	last: {
		exchange: Exchange
		ok: boolean
		request: Resolved
		stepOp: string | undefined
		unmet: Want | undefined
		wants: ReturnType<typeof wantsOf>
	},
): StepFailure {
	const { exchange, request, stepOp } = last
	const proves = [...last.wants.flatMap(({ assert }) => assert.observes ?? []), ...blamed(stepOp)]
	const earlier = proves
		.map((id) => run.calls.get(id))
		.filter((call): call is Exchange => call !== undefined && call !== exchange)
	if (!last.ok) {
		return new StepFailure(
			`${request.method} ${request.path} returned ${exchange.status}`,
			[...earlier, exchange],
			blamed(stepOp),
		)
	}
	/* A request that succeeded reaches here only with an assert unmet. */
	const unmet = last.unmet as Want
	return new StepFailure(
		`${request.method} ${request.path} did not show ${unmet.mode} "${unmet.value}" at ${unmet.from}`,
		[...earlier, exchange],
		proves,
	)
}
