/**
 * The document as a run sees it: the config's overlay applied, then everything outside `allow`
 * removed. One function, so `run`, `plan` and `doctor` cannot disagree about what oat may call.
 */

import type { Principal } from "../config/types/principals.ts"
import type { Scenario } from "../config/types/steps.ts"
import { assertAllowedReferences, pruneToAllow } from "./allow.ts"
import { applyOverlay, type SpecOverlay } from "./overlay.ts"
import type { OpenApiDocument } from "./types.ts"

export interface DocumentConfig {
	overlay?: SpecOverlay
	allow?: readonly string[]
	principals?: readonly Principal[]
	scenarios?: readonly Scenario[]
}

export function prepareDocument(
	raw: OpenApiDocument,
	config: DocumentConfig,
	onRemoved?: (removed: string[]) => void,
): OpenApiDocument {
	const overlaid = config.overlay === undefined ? raw : applyOverlay(raw, config.overlay)
	if (config.allow === undefined) return overlaid
	const { doc, removed } = pruneToAllow(overlaid, config.allow)
	assertAllowedReferences(new Set(config.allow), config)
	onRemoved?.(removed)
	return doc
}
