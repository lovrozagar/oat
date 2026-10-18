import type { RemovalVerdict, RemovedRecord } from "../../config/types/hooks.ts"
import type { ProvenId } from "../proven-id.ts"

/** A record oat made: its entity, the id the backend gave back, and the path parameters in scope. */
export interface Created {
	entity: string
	id: ProvenId
	scope: Record<string, string>
}

/** The principal a record belongs to, as far as removing it goes. */
export interface Owner {
	id: string
	headers: () => Record<string, string>
}

export interface Disposable {
	entity: string
	id: string
	/** Path parameters in scope when the record was created. */
	scope: Record<string, string>
	/** Who created it. Only the creator's view of the record decides whether it is gone. */
	owner: Owner
}

/** A create that answered 2xx without an id oat could read: what it made may remain. */
export interface UnidentifiedCreate {
	entity: string
	operationId: string
	method: string
	url: string
	status: number
	/** The exchange's sequence number in the run's transcript. */
	seq: number
}

export interface TeardownReport {
	removed: number
	/** Records still in place, each with the principal that created it. */
	failed: Array<{ entity: string; id: string; principal: string; reason: string }>
	unsupported: string[]
	/** Every record the unwind was given, in creation order, its creator, and whether it is gone now. */
	records: Array<{ entity: string; id: string; principal: string; removed: boolean }>
	/** Creates whose record oat could not identify, so could not remove. Each fails the run. */
	unidentified: UnidentifiedCreate[]
	/** What `hooks.verifyRemoved` threw, once per call that did; those records keep teardown's verdict. */
	verifyHookErrors?: string[]
}

export interface UnwindOptions {
	onItem?: (done: number, total: number, item: Disposable) => void
	/* Read each list again afterwards, so a 2xx delete that kept its record is not counted gone. */
	verify?: boolean
	/* Asked about every record counted removed and every one teardown could not show gone. */
	verifyRemoved?: (record: RemovedRecord) => RemovalVerdict | Promise<RemovalVerdict>
}

/** One record's line in the report, updated as the unwind learns whether it is gone. */
export type RecordState = TeardownReport["records"][number]

/** What the unwind asks of the ledger it unwinds. */
export interface LedgerView {
	/** What moved the record away, when an accepted write did. */
	movedAway: (item: Disposable) => string | undefined
	/** Whether the record's creator ever read it back. */
	seenByCreator: (item: Disposable) => boolean
	sighted: (entity: string, id: string, principal: string) => void
}
