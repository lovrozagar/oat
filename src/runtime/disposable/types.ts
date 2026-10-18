import type { Hooks } from "../../config/types/hooks.ts"
import type { PrincipalAuth } from "../../config/types/principals.ts"
import type { SpecModel } from "../../spec/graph/types.ts"
import type { Client } from "../../client/client.ts"
import type { Exchange } from "../exchange.ts"
import type { FindingCollector } from "../finding.ts"
import type { BackoffConfig } from "../poll.ts"
import type { GradeLedger } from "../grades.ts"

/** The second user a destructive operation runs as. */
export interface Session {
	headers: () => Record<string, string>
	/** Values the signup sent or returned, by name — a body field with the same name gets them. */
	known: Record<string, unknown>
	roots: Record<string, string>
	/** Re-runs the flow's declared refresh; resolves to the exchange it ended on, if any. */
	renew?: () => Promise<Exchange | undefined>
}

export interface DisposableInput {
	auth: () => Record<string, string>
	client: Client
	findings: FindingCollector
	checksRun?: Set<string>
	grades: GradeLedger
	inScope: (operationId: string) => boolean
	mode: "full" | "targeted"
	model: SpecModel
	nonce?: string
	authFlow?: PrincipalAuth
	hooks?: Hooks
	outOfBand?: Partial<BackoffConfig>
	resolveInput?: Hooks["resolveInput"]
	rootsFromFlow?: Record<string, string>
	seed?: number
	/** Kept for callers; the signup comes from the auth flow or `x-fresh-principal`. */
	registerOperationId?: string
}
