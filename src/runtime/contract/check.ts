/**
 * The floor under every operation: nothing in the document goes uncalled. An operation no check
 * and no scenario graded is called once with a request built from its own schema. A documented
 * success whose body matches the schema passes at the `contract` tier — the weakest honest
 * claim, and the report says so. A server error or a body that breaks the schema fails. A
 * refused request leaves it untested with the refusal as the reason, because a request oat
 * guessed is not proof the backend is wrong; that operation needs a scenario.
 */

import type { CheckId } from "../check-ids.ts"
import type { Check } from "../checks/core/check.ts"
import { ASSERTED, type Outcome } from "../finding.ts"

export const CONTRACT_CHECK_ID = "response.contract-call" as const satisfies CheckId

export const contractCallCheck: Check = {
	id: CONTRACT_CHECK_ID,
	needs: "an operation nothing else graded, with every path parameter resolvable",
	plan: () => ({ ok: false }),
	run: (): Promise<Outcome> => Promise.resolve(ASSERTED),
	/* Runs after every check and scenario, over what they left ungraded. `runContractCalls` does. */
	subjects: () => [],
}
