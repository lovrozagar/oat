/**
 * The public configuration surface — and the single source of truth for its types.
 *
 * The runtime imports these definitions rather than declaring its own, so a mistake in a config
 * is a compile error rather than a surprise at request time. Everything backend-specific lives
 * here or in `x-*` spec tags; oat itself knows nothing about any particular API.
 */

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
} from "../types/config.ts"
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
} from "../types/hooks.ts"
export type { PrincipalEntry, PrincipalsConfig, Recipe, SecurityConfig } from "../types/security.ts"
export type {
	DeclaredFilterGrammar,
	DeclaredSortGrammar,
	FieldType,
	FilterableField,
	FilterableFrom,
	FilterOp,
	Nulls,
	QueryCapabilities,
	QueryParamNames,
	QueryParamRole,
	SearchMode,
	SelectRelation,
	SortableField,
} from "../types/query.ts"
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
} from "../types/steps.ts"
