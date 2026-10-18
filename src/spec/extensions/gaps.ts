/** A tag oat could not resolve, named so the report can say which tag would close the gap. */

export interface Gap {
	operationId: string
	tag: string
	detail: string
}

export class GapCollector {
	readonly gaps: Gap[] = []
	record(operationId: string, tag: string, detail: string): void {
		this.gaps.push({ detail, operationId, tag })
	}
}
