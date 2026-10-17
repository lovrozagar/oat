// Oxlint registers one plugin name; this entry publishes every oat rule.
import { rule as boundaries } from "./boundaries.ts"
import { rule as exitOnlyInCli } from "./exit-only-in-cli.ts"
import { rule as grammarThroughRenderer } from "./grammar-through-renderer.ts"
import { rule as idThroughReader } from "./id-through-reader.ts"
import { rule as indexPurity } from "./index-purity.ts"
import { rule as networkThroughClient } from "./network-through-client.ts"
import { rule as noConsole } from "./no-console.ts"
import { rule as noHeaderBranching } from "./no-header-branching.ts"
import { rule as noModuleSideEffects } from "./no-module-side-effects.ts"
import { rule as noModuleState } from "./no-module-state.ts"
import { rule as noV8Ignore } from "./no-v8-ignore.ts"
import { rule as provenIdOrigin } from "./proven-id-origin.ts"

export default {
	meta: { name: "oat" },
	rules: {
		boundaries,
		"exit-only-in-cli": exitOnlyInCli,
		"grammar-through-renderer": grammarThroughRenderer,
		"id-through-reader": idThroughReader,
		"index-purity": indexPurity,
		"network-through-client": networkThroughClient,
		"no-console": noConsole,
		"no-header-branching": noHeaderBranching,
		"no-module-side-effects": noModuleSideEffects,
		"no-module-state": noModuleState,
		"no-v8-ignore": noV8Ignore,
		"proven-id-origin": provenIdOrigin,
	},
}
