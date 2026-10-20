import type { Hooks } from "../../config/types/hooks.ts"
import type { SpecModel } from "../../spec/graph/types.ts"
import type { Client } from "../../client/client.ts"
import type { Exchange } from "../exchange.ts"
import type { FindingCollector } from "../finding.ts"
import type { GradeLedger } from "../grades.ts"

/** The second user a destructive operation runs as: a principal of its own in the run's store. */
export interface Session {
	/** Its principal id: its requests go `as: { principal }`, refreshed and 401-retried like any other. */
	principal: string
	/** Values the signup sent or returned, by name — a body field with the same name gets them. */
	known: Record<string, unknown>
	/** Path parameters bound for it, filled before any is read from a list. */
	scope: Readonly<Record<string, string>>
	/** Runs its declared refresh once; resolves to the exchange it ended on, if any. */
	renew?: () => Promise<Exchange | undefined>
}

/** A second user, signed up and bound in the run's store, and what its signup sent and answered, by name. */
export interface Enrolled {
	id: string
	known: Record<string, unknown>
	/** Path parameters its login's claims bound for it; empty when they bound none. */
	scope: Readonly<Record<string, string>>
	/** Runs its recipe's declared refresh once, the exchange it ended on; absent when the recipe declares none. */
	renew?: () => Promise<Exchange | undefined>
}

export interface DisposableInput {
	/** The suite principal: what a destructive operation must spare. */
	principal: string
	/**
	 * Signs a second user up through the document's `x-fresh-principal` operation and binds it in the
	 * run's store as `disposable-<label>`; BLOCKED with the reason when it cannot.
	 */
	enroll: (label: string) => Promise<Enrolled | { blocked: string }>
	client: Client
	findings: FindingCollector
	checksRun?: Set<string>
	grades: GradeLedger
	inScope: (operationId: string) => boolean
	mode: "full" | "targeted"
	model: SpecModel
	nonce?: string
	resolveInput?: Hooks["resolveInput"]
	seed?: number
}
