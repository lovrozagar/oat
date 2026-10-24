/** Which principal a run writes as: the one `writer` names, or the first in config order. */

import type { PrincipalsConfig } from "../config/types/security.ts"

/** `principals` with `writer` first and the others in config order: every reader takes the first as the writer. */
export function writerFirst(principals: PrincipalsConfig, writer: string | undefined): PrincipalsConfig {
	const named = writer === undefined ? undefined : principals[writer]
	if (writer === undefined || named === undefined) return principals
	return { [writer]: named, ...principals }
}
