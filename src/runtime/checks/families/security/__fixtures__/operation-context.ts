import type { RequestOptions } from "../../../../../client/types.ts"
import type { RecipeAnchors } from "../../../../../credentials/anchors.ts"
import { FindingCollector } from "../../../../finding.ts"
import type { SpecModel } from "../../../../../spec/graph/types.ts"
import { type Answer, fakeClient, op, type Sent } from "../../../__fixtures__/harness.ts"
import type { Actor } from "../../../core/context.ts"
import { placementOf } from "../../../core/operation.ts"
import type {
	DedicatedCredential,
	OperationWriteContext,
	ProbeCredentials,
	ProbeRequest,
	Probed,
	WriteTarget,
} from "../../../core/operation-context.ts"

/*
 * A socket-free stage for one operation check: the operation of a small document, a client a test
 * answers by what each request carries (its actor included), and probe credentials the test scripts.
 * Every request and every probe-credential call is recorded, so a test asserts on both.
 */

/** Answers a request as the fake client saw it, actor included; `undefined` is a 404. */
export type SentResponder = (sent: Sent) => Answer | undefined

/** A principal as an operation check sees it. */
export function actorOf(id: string, fields: Partial<Omit<Actor, "id">> = {}): Actor {
	return { id, inviteAs: undefined, rank: 0, scope: {}, tenant: undefined, ...fields }
}

/** What the probe credentials answer: recipes by scheme, and the dedicated credential a request gets. */
export interface ProbeScript {
	recipes?: Readonly<Record<string, Probed<RecipeAnchors>>>
	dedicated?: (request: ProbeRequest) => Probed<DedicatedCredential>
	/** The value a principal's own credential holds, by request. */
	held?: (request: ProbeRequest) => Probed<{ value: string }>
}

/** Every call the checks made on the probe credentials. */
export interface ProbeCalls {
	dedicated: ProbeRequest[]
	held: ProbeRequest[]
	recipe: Array<{ principal: string; scheme: string }>
}

function probeOf(script: ProbeScript, calls: ProbeCalls): ProbeCredentials {
	return {
		dedicated: async (request) => {
			calls.dedicated.push(request)
			return script.dedicated?.(request) ?? { untested: "no dedicated credential in this test" }
		},
		held: async (request) => {
			calls.held.push(request)
			return script.held?.(request) ?? { untested: "no held credential in this test" }
		},
		recipe: (request) => {
			calls.recipe.push(request)
			return script.recipes?.[request.scheme] ?? { untested: `no ${request.scheme} recipe in this test` }
		},
	}
}

/** How a staged operation check is answered, and what its context carries. */
export interface OperationStage {
	respond?: SentResponder
	probe?: ProbeScript
	principals?: [Actor, ...Actor[]]
	peer?: Actor
	target?: WriteTarget
	checks?: OperationWriteContext["options"]["checks"]
	/** Where the probe runs; by default, where the stage places an operation by its method and path. */
	placement?: OperationWriteContext["placement"]
}

/** A full operation context for `operationId` of `model`, with the fake client, the probe and fresh findings. */
export function operationContextFor(
	model: SpecModel,
	operationId: string,
	stage: OperationStage = {},
): { ctx: OperationWriteContext; sent: Sent[]; findings: FindingCollector; calls: ProbeCalls } {
	const respond = stage.respond ?? (() => undefined)
	const { client, sent } = fakeClient((method, path, options) =>
		/* The harness hands the responder every option it was sent; this stage answers by actor too. */
		respond({ method, options: options as RequestOptions, path }),
	)
	const findings = new FindingCollector()
	const calls: ProbeCalls = { dedicated: [], held: [], recipe: [] }
	const operation = op(model, operationId)
	const principals = stage.principals ?? [actorOf("alpha")]
	const ctx: OperationWriteContext = {
		actor: principals[0],
		client,
		findings,
		model,
		nonce: "test",
		placement: stage.placement ?? placementOf({}, operation),
		operation,
		options: { checks: stage.checks ?? {} },
		principals,
		probe: probeOf(stage.probe ?? {}, calls),
		security: operation.security,
		subject: operationId,
		...(stage.peer === undefined ? {} : { peer: stage.peer }),
		...(stage.target === undefined ? {} : { target: stage.target }),
	}
	return { calls, ctx, findings, sent }
}

/** Who a sent request acted as: a principal's id, `forged`, or `anonymous`. */
export function sender(sent: Sent): string {
	const as = sent.options.as
	return "principal" in as ? as.principal : "forged" in as ? "forged" : "anonymous"
}
