/**
 * The public configuration surface — and the single source of truth for its types.
 *
 * The runtime imports these definitions rather than declaring its own, so a mistake in a config
 * is a compile error rather than a surprise at request time. Everything backend-specific lives
 * here or in `x-*` spec tags; oat itself knows nothing about any particular API.
 */

import type { OatConfig } from "./types/config.ts"

export type {
	EntityConfig,
	OatConfig,
	OriginSpec,
	PayloadPolicy,
	ProfileSpec,
	QueryConfig,
	RateLimitSpec,
	SpecOverlay,
	TargetVersionSpec,
} from "./types/config.ts"
export type {
	FenceDecision,
	FenceRequest,
	HeaderRequest,
	Hooks,
	InputRequest,
	OutOfBandConfig,
	OutOfBandRequest,
	PathValueRequest,
	QueryCapabilitiesRequest,
	RemovalVerdict,
	RemovedRecord,
	SideEffectRequest,
	TeardownPrincipalContext,
	UploadFile,
	UploadRequest,
	UploadResolution,
	Uploads,
} from "./types/hooks.ts"
export type {
	AuthFlow,
	AuthRefresh,
	HookAuth,
	Principal,
	PrincipalAuth,
	PrincipalAuthResult,
} from "./types/principals.ts"
export type {
	DeclaredFilterGrammar,
	DeclaredSortGrammar,
	FieldType,
	FilterableField,
	FilterableFrom,
	FilterOp,
	Nulls,
	QueryCapabilities,
	SearchMode,
	SelectRelation,
	SortableField,
} from "./types/query.ts"
export type {
	AuthStep,
	ExternalStep,
	OperationStep,
	OutOfBandStep,
	RequestStep,
	Scenario,
	ScenarioAssert,
	ScenarioRequestStep,
	ScenarioStep,
} from "./types/steps.ts"

/**
 * Identity function that gives a config file full type checking and editor completion.
 *
 * ```ts
 * import { defineConfig } from "@lovrozagar/oat"
 *
 * export default defineConfig({
 *   spec: "https://api.example.com/openapi.json",
 *   baseUrl: "https://api.example.com",
 *   principals: [{ id: "alpha", headers: { authorization: `Bearer ${process.env.TOKEN}` } }],
 * })
 * ```
 */
export function defineConfig(config: OatConfig): OatConfig {
	return config
}
