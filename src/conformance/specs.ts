/**
 * Hostile spec fixtures.
 *
 * Every one of these is a shape found in a real published OpenAPI document. The bar is not that
 * oat models them well — several are genuinely untestable — but that it never throws, never
 * hangs, and says plainly what it could not do. Prior art in this space died on exactly this
 * class: one `nullable` without a `type` made the validator refuse to compile and took the whole
 * run with it.
 *
 * Vendored rather than downloaded so the check stays offline and deterministic.
 */

import { documentFixtures } from "./specs/documents.ts"
import { modelFixtures } from "./specs/models.ts"
import type { SpecFixture } from "./specs/types.ts"

export type { SpecFixture } from "./specs/types.ts"

/** Every fixture, in the order the parser suite reports them. */
export function specFixtures(): SpecFixture[] {
	return [...documentFixtures(), ...modelFixtures()]
}
