import { expectTypeOf } from "vitest"
import type * as oat from "../../src/index.ts"
import type {
	Actor,
	AuthFlow,
	AuthRefresh,
	AuthStep,
	EntityConfig,
	EntityModel,
	ExternalStep,
	FieldType,
	FilterableField,
	FilterableFrom,
	FilterOp,
	Finding,
	HeaderRequest,
	HookAuth,
	Hooks,
	InputRequest,
	OatConfig,
	OpenApiDocument,
	OperationModel,
	OperationStep,
	OriginSpec,
	OutOfBandConfig,
	OutOfBandRequest,
	OutOfBandStep,
	PathValueRequest,
	PayloadPolicy,
	Principal,
	PrincipalAuth,
	PrincipalAuthResult,
	ProfileSpec,
	QueryCapabilities,
	QueryCapabilitiesRequest,
	RateLimitSpec,
	ReportInput,
	RequestStep,
	RunOptions,
	RunResult,
	Scenario,
	ScenarioAssert,
	ScenarioRequestStep,
	ScenarioStep,
	SideEffectRequest,
	SpecModel,
	TeardownPrincipalContext,
	UploadFile,
	UploadRequest,
	UploadResolution,
	Uploads,
	Verdict,
} from "../../src/index.ts"

/*
 * The public surface, pinned. A value export added or removed changes the key union below and fails
 * the type check; a type export removed fails its import. A new type export must also be documented
 * in docs/api.md, which tests/structure/docs-sync.test.ts enforces.
 */
expectTypeOf<keyof typeof oat>().toEqualTypeOf<
	| "allocateRunDir"
	| "AuthRefreshRequiredError"
	| "buildModel"
	| "DEFAULT_RUNS_ROOT"
	| "defineConfig"
	| "dereference"
	| "env"
	| "EXIT"
	| "exitCode"
	| "loadConfig"
	| "loadPersistedPrincipals"
	| "loadSpec"
	| "renderJson"
	| "renderMarkdown"
	| "renderMatrixGraph"
	| "renderMatrixHtml"
	| "renderRepros"
	| "run"
	| "runVerdict"
	| "ScopeError"
	| "worstCaseWaitMs"
>()

export type PublicTypes = [
	Actor,
	AuthFlow,
	AuthRefresh,
	AuthStep,
	EntityConfig,
	EntityModel,
	ExternalStep,
	FieldType,
	FilterableField,
	FilterableFrom,
	FilterOp,
	Finding,
	HeaderRequest,
	HookAuth,
	Hooks,
	InputRequest,
	OatConfig,
	OpenApiDocument,
	OperationModel,
	OperationStep,
	OriginSpec,
	OutOfBandConfig,
	OutOfBandRequest,
	OutOfBandStep,
	PathValueRequest,
	PayloadPolicy,
	Principal,
	PrincipalAuth,
	PrincipalAuthResult,
	ProfileSpec,
	QueryCapabilities,
	QueryCapabilitiesRequest,
	RateLimitSpec,
	ReportInput,
	RequestStep,
	RunOptions,
	RunResult,
	Scenario,
	ScenarioAssert,
	ScenarioRequestStep,
	ScenarioStep,
	SideEffectRequest,
	SpecModel,
	TeardownPrincipalContext,
	UploadFile,
	UploadRequest,
	UploadResolution,
	Uploads,
	Verdict,
]
