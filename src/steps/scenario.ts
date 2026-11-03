import type { Scenario, ScenarioStep } from "../config/types/steps.ts"
import type { BuiltStep, StepItem, Unchecked } from "./types.ts"

/** A scenario as written with the builders: `covers` typed over the operations it may grade. */
export interface ScenarioInit<Covered extends string = string> {
	id: string
	/** The operations this scenario grades, an explicit list: each must be called by a step. */
	covers: Covered[]
	/** Config principal whose credential the steps send. Default: the writer (`writer`, else the first principal). */
	principal?: string
	/** The configured origin the whole scenario belongs to. */
	origin?: string
	steps: StepItem[]
}

const isBuilt = (item: StepItem): item is BuiltStep => "toStep" in item && typeof item.toStep === "function"

/** The plain oat scenario the builders stand for: each builder becomes its step, plain steps stay as they are. */
export function scenario<Covered extends string>(init: ScenarioInit<Covered>): Scenario {
	const { covers, id, origin, principal } = init
	const steps: ScenarioStep[] = init.steps.map((item) => (isBuilt(item) ? item.toStep() : item))
	return {
		covers,
		id,
		...(origin === undefined ? {} : { origin }),
		...(principal === undefined ? {} : { principal }),
		steps,
	}
}

/** A deliberately invalid value, sent as written: the one way past an operation's body type. */
export function unchecked<V>(value: V): V & Unchecked {
	return value as V & Unchecked
}
