/* What each operation was graded by during a run, and the exchange that proved each pass. */

/** Exchanges by `seq`, which is unique within a run; the journal saves each with its `seq`. */
export interface PassEvidence {
	call: number
	/**
	 * A later exchange holding `value` at `path`. For a delete: a later read of the same resource
	 * answering `status`, or a later list of its collection where `value` is `absent`.
	 */
	observation?: { seq: number; path: string; value: string; absent?: true } | { seq: number; status: number }
}

/** Which checks graded which operations, filled as checks run. */
export class GradeLedger {
	readonly ran: Map<string, Set<string>> = new Map<string, Set<string>>()
	/** The checks in `ran` that only probed the operation: none of them judged its documented success. */
	readonly probed: Map<string, Set<string>> = new Map<string, Set<string>>()
	readonly suppressed: Map<string, Set<string>> = new Map<string, Set<string>>()
	readonly needs: Map<string, Set<string>> = new Map<string, Set<string>>()
	readonly evidence: Map<string, PassEvidence> = new Map<string, PassEvidence>()

	#add(map: Map<string, Set<string>>, operations: readonly string[], value: string): void {
		for (const op of operations) {
			const set = map.get(op) ?? new Set<string>()
			set.add(value)
			map.set(op, set)
		}
	}

	graded(operations: readonly string[], check: string): void {
		this.#add(this.ran, operations, check)
	}

	/**
	 * Graded by a security probe: listed in `ran` for the report, but a probe never judges the
	 * documented success, so it never stands in for the contract floor or for pass evidence.
	 */
	probedBy(operations: readonly string[], check: string): void {
		this.#add(this.ran, operations, check)
		this.#add(this.probed, operations, check)
	}

	/** Whether some check other than a probe graded the operation. */
	judged(operation: string): boolean {
		const probed = this.probed.get(operation)
		return [...(this.ran.get(operation) ?? [])].some((check) => probed?.has(check) !== true)
	}

	suppress(operations: readonly string[], check: string): void {
		this.#add(this.suppressed, operations, check)
	}

	skipped(operations: readonly string[], needs: string): void {
		this.#add(this.needs, operations, needs)
	}

	/** The call behind a pass, and the later read that showed it. An observation is never downgraded. */
	prove(operation: string, evidence: PassEvidence): void {
		const known = this.evidence.get(operation)
		if (known?.observation !== undefined && evidence.observation === undefined) return
		this.evidence.set(operation, evidence)
	}
}
