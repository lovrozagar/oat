/**
 * Identifiers and timestamps are the server's, not the store's: one sequence, so every engine
 * issues the same ids in the same order. Timestamps derive from it rather than the clock —
 * wall-clock time makes ordering assertions flaky for reasons unrelated to the backend.
 */

import { createHash } from "node:crypto"
import type { EntityDef } from "../model.ts"

export class Ids {
	/** Every id issued or stored once the server is serving, per entity: what a client's run caused. */
	readonly caused: Record<string, string[]> = {}
	private sequence = 0
	private serving = false

	/** From here on every issued id and stored record is one a client caused: the ids a run may ledger. */
	serve(): void {
		this.serving = true
	}

	/** The next number in the sequence. */
	tick(): number {
		this.sequence += 1
		return this.sequence
	}

	/* An id the server hands out counts even when a defect then fails to store the record: the
	 * backend gave it back, so a client may rightly try to remove it. */
	next(entity: EntityDef): string | number {
		const id = this.issue(entity)
		this.note(entity, id)
		return id
	}

	note(entity: EntityDef, id: unknown): void {
		if (this.serving) (this.caused[entity.name] ??= []).push(String(id))
	}

	now(): number {
		return 1_700_000_000_000 + this.sequence * 1000
	}

	private issue(entity: EntityDef): string | number {
		const sequence = this.tick()
		const identity = entity.fields.find((field) => field.name === entity.identity)
		if (identity?.type === "integer") return sequence
		if (identity?.format === "uuid") {
			/* Deterministic but unordered, like a real v4: creation order says nothing about id order. */
			const h = createHash("sha1").update(`oat-ref-${sequence}`).digest("hex")
			const variant = "89ab"[Number.parseInt(h[16] as string, 16) % 4]
			return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`
		}
		return `${entity.name}_${String(sequence).padStart(6, "0")}`
	}
}
