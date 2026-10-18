import { UsageError } from "../../errors/usage-error.ts"

export class ScopeError extends UsageError {
	override name = "ScopeError"
}
