import type { AuthFlow, HookAuth, PrincipalAuth } from "../config/types/principals.ts"

/** A principal whose credential a hook hands over, with no steps to run. */
export function isHookAuth(auth: PrincipalAuth): auth is HookAuth {
	return "fromHook" in auth && typeof auth.fromHook === "string" && !("steps" in auth)
}

/** A principal that signs in by running steps. */
export function isAuthFlow(auth: PrincipalAuth): auth is AuthFlow {
	return "steps" in auth
}
