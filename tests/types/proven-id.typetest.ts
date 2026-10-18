/*
 * Compile-time test, checked by `tsc -p tsconfig.test.json` (part of `bun check`).
 *
 * Teardown deletes what was recorded. A plain string — an id oat only sent, a value lifted from a
 * request body — must not be recordable, or the next fallback that "knows" the id would delete a
 * row somebody else owns. Each line below must fail to compile; if one stops failing, the
 * `@ts-expect-error` above it is unused and the check fails. The first three lines must compile.
 */
import type { CheckContext } from "../../src/runtime/checks/core/context.ts"
import type { ProvenId } from "../../src/runtime/proven-id.ts"
import type { Ledger } from "../../src/runtime/teardown/ledger.ts"
import type { Owner } from "../../src/runtime/teardown/types.ts"
import type { WorldOptions } from "../../src/runtime/world/types.ts"

declare const ledger: Ledger
declare const owner: Owner
declare const options: WorldOptions
declare const ctx: CheckContext
declare const sentId: string
declare const returned: ProvenId

/* What the backend gave back is recordable everywhere. */
ledger.record({ entity: "note", id: returned, scope: {} }, owner)
options.onCreate?.("note", returned, {})
ctx.recordCreated?.({ entity: "note", id: returned, scope: {} })

// @ts-expect-error an id oat only sent is not proof of a record it made
ledger.record({ entity: "note", id: sentId, scope: {} }, owner)

// @ts-expect-error seeding reports only ids a response or a confirming read returned
options.onCreate?.("note", sentId, {})

// @ts-expect-error a check records only ids the backend gave back
ctx.recordCreated?.({ entity: "note", id: sentId, scope: {} })
