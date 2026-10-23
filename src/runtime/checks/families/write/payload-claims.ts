/** An entity in plan order, and the write path the document says its payload check probes. */
export interface PlannedPayload {
	entity: string
	path: string | null
}

interface Outcome {
	/** The path the entity ran the whole catalog on, or null once it never will. */
	path: Promise<string | null>
	settle: (path: string | null) => void
}

function outcome(): Outcome {
	/* The executor runs at once, so `settle` is assigned before it is returned. */
	let settle!: (path: string | null) => void
	const path = new Promise<string | null>((resolve) => {
		settle = resolve
	})
	return { path, settle }
}

/**
 * Which entity runs the whole payload catalog on each write path: the first in plan order that
 * reaches it (`plannedWritePath` gives each entity's path). Lanes run side by side, so the first to arrive would make the report depend on which
 * lane the backend answered sooner. An entity claims a path only once every entity planned before
 * it on that path has run the catalog there or finished without it. A wait only ever points back
 * in plan order, and a lane runs its entities in plan order, so the earliest entity still pending
 * never waits and every claim settles.
 */
export class PayloadClaims {
	private planned: readonly PlannedPayload[] = []
	private readonly outcomes = new Map<string, Outcome>()

	/** The run's entities in plan order, each with the path it is planned on (`plannedWritePath`). */
	plan(entities: readonly PlannedPayload[]): void {
		this.planned = entities
		for (const { entity } of entities) this.outcomes.set(entity, outcome())
	}

	/**
	 * Null when `entity` runs the whole catalog on `path`; otherwise the entity before it in plan
	 * order that ran it there. An entity outside the plan has no entity before it. A claimant settles
	 * the path only once it has run the catalog to its end; one that stops partway passes it on.
	 */
	async claim(entity: string, path: string): Promise<string | null> {
		const at = this.planned.findIndex((planned) => planned.entity === entity)
		for (const earlier of this.planned.slice(0, Math.max(at, 0))) {
			if (earlier.path !== path) continue
			if ((await this.outcomes.get(earlier.entity)?.path) === path) return earlier.entity
		}
		return null
	}

	/** `entity` is done with the catalog: it ran it on `path`, or (null) never will. The first word stands. */
	settle(entity: string, path: string | null = null): void {
		this.outcomes.get(entity)?.settle(path)
	}
}
