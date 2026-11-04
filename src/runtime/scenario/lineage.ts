/**
 * Which account each scope name descends from: a value a ledgered sign-up answered, or one a step
 * saved after sending such a value. A self delete sent through a session carries no principal, so
 * the names it sends are what tie it to the account it removed.
 *
 * A tag is the ledger's entry, held here only: it never enters the scope, an exchange or a report.
 */

import { placeholderNames } from "../../config/types/placeholder.ts"
import type { ScenarioRequestStep } from "../../config/types/steps.ts"
import type { AccountEntry } from "../accounts/ledger.ts"
import type { Exchange } from "../exchange.ts"

/** By scope name, the account its value descends from. */
export type Lineage = Map<string, AccountEntry>

/** What a scenario asks of the run's account ledger. */
export interface ScenarioAccounts {
	/** The entry whose sign-up `exchange` answered. */
	madeBy: (exchange: Exchange) => AccountEntry | undefined
	/** The operation that deletes the caller's own account. */
	deleteSelf: string
	/** `entry` deleted itself by `exchange`: settled, while the run still owes it. */
	deletedItself: (entry: AccountEntry, exchange: Exchange) => void
}

/** Every `{name}` the step's request sends. */
export function referenced(step: ScenarioRequestStep): Set<string> {
	const path = "path" in step ? step.path : undefined
	return new Set(placeholderNames([path, step.body, step.headers, step.query, step.bind]))
}

/**
 * The account a step's answer descends from: the one its own sign-up made, else the one account
 * every tagged name it sent descends from. Names from two accounts tag nothing.
 */
export function tagOf(
	lineage: Lineage,
	step: ScenarioRequestStep,
	made: AccountEntry | undefined,
): AccountEntry | undefined {
	if (made !== undefined) return made
	const carried = new Set<AccountEntry>()
	for (const name of referenced(step)) {
		const entry = lineage.get(name)
		if (entry !== undefined) carried.add(entry)
	}
	return carried.size === 1 ? [...carried][0] : undefined
}

/** Tags every name the step saved with `tag`; a name rebound with none no longer descends. */
export function keep(lineage: Lineage, step: ScenarioRequestStep, tag: AccountEntry | undefined): void {
	const saved = [...Object.keys(step.saveAs ?? {}), ...Object.keys(step.saveClaimsFrom?.bind ?? {})]
	for (const name of saved) {
		if (tag === undefined) lineage.delete(name)
		else lineage.set(name, tag)
	}
}

/**
 * A self delete the backend accepted, sent with no principal (through a session, say), settles the
 * account its names descend from. One sent as a principal is the watch's to settle by that principal.
 */
export function selfDeleted(
	lineage: Lineage,
	sent: { accounts: ScenarioAccounts | undefined; step: ScenarioRequestStep; exchange: Exchange },
): void {
	const { accounts, step, exchange } = sent
	if (accounts === undefined || step.anonymous !== true) return
	if (exchange.operationId !== accounts.deleteSelf) return
	if (exchange.status < 200 || exchange.status >= 300) return
	const entry = tagOf(lineage, step, undefined)
	if (entry !== undefined) accounts.deletedItself(entry, exchange)
}
