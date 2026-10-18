/**
 * Values from schemas — the one place oat invents data.
 *
 * Seeding a cohort and probing a check both need values: a record to create, a second value to
 * patch to, an identifier that is well-formed and absent, a value just outside an enum. They used
 * to be invented in two places plus a dozen string literals in the checks (`"oat patched value"`,
 * `"<id>-oat-absent"`), and the literals were wrong exactly where it mattered: not a UUID where the
 * API takes UUIDs, not a date where it takes dates. Everything comes from here now, from the
 * normalized schema (see `spec/schema.ts`), and anything that cannot be constructed says so rather
 * than sending something the document forbids.
 *
 * Generation is deterministic in its inputs. Distinctness across runs comes from a per-run nonce,
 * never from suffix arithmetic that ignores `maximum`, `multipleOf`, `enum` or `format`.
 */

import { instance } from "./instance.ts"
import type { Context, GenerateOptions, Generated } from "./types.ts"
import { Unconstructible } from "./unconstructible.ts"
import { messageOf } from "../../errors/message.ts"

/** One value valid for `schema`, or why none can be made. */
export function generate(schema: unknown, options: GenerateOptions = {}): Generated {
	const ctx: Context = {
		defs: options.defs ?? {},
		depth: 0,
		distinct: options.distinct ?? new Set(),
		index: options.index ?? 0,
		nonce: options.nonce,
		optional: options.optional ?? "all",
		rand: options.rand ?? (() => 0.5),
		refs: [],
		variant: options.variant ?? "baseline",
	}
	try {
		return { ok: true, value: instance(schema, { ctx, distinct: false, pointer: "" }) }
	} catch (error) {
		if (error instanceof Unconstructible) return { ok: false, pointer: error.pointer || "/", reason: error.reason }
		if (error instanceof RangeError)
			return { ok: false, pointer: "/", reason: "the schema nests too deeply to generate" }
		/* Anything else is a schema generation could not even read: a reason, never a crash. */
		return { ok: false, pointer: "/", reason: `generation failed: ${messageOf(error)}` }
	}
}
