import { type DefectName, isDefectName } from "./table.ts"

/** The defects one reference exhibits. */
export class DefectSet {
	private readonly enabled: ReadonlySet<DefectName>

	/** Throws on a name that is not a defect: a typo must not silently run a clean backend. */
	constructor(names: readonly string[] = []) {
		const unknown = names.filter((name) => !isDefectName(name))
		if (unknown.length > 0) throw new Error(`unknown defect(s): ${unknown.join(", ")}`)
		this.enabled = new Set(names as DefectName[])
	}

	has(name: DefectName): boolean {
		return this.enabled.has(name)
	}

	list(): DefectName[] {
		return [...this.enabled]
	}
}
