import type { DefectName } from "../../reference/defects/table.ts"
import type { FindingId } from "../../runtime/check-ids.ts"

/** The defects with a row in the write family; a name that is not a defect falls out and fails its row. */
type WriteDefect = Extract<
	DefectName,
	| "CREATED_201_AS_200"
	| "IDEMPOTENCY_IGNORED"
	| "UNIQUE_NOT_ENFORCED"
	| "DELETE_MISSING_OK"
	| "IMMUTABLE_WRITABLE"
	| "PATCH_REPLACES"
	| "SOFT_DELETE_LEAK"
	| "CREATE_DROPS_FIELD"
	| "READ_DROPS_FIELD"
	| "STRING_PAYLOAD_MANGLED"
	| "COLUMN_NAME_MISMATCH"
	| "CONCURRENT_WRITE_LOST"
	| "ETAG_IGNORED"
	| "DELETE_KEEPS_ROW"
	| "IDEMPOTENT_REPLAY_INSERTS"
	| "CLIENT_ID_IGNORED"
	| "CLIENT_ID_OVERWRITES"
	| "HIDDEN_FROM_CREATOR"
	| "CREATE_500_ON_NON_ASCII"
>

/** The defects whose primary check is in the write family, and the check each must trip. */
export const WRITE_EXPECTED: Record<WriteDefect, FindingId | FindingId[]> = {
	CREATED_201_AS_200: "create.status-matches-document",
	IDEMPOTENCY_IGNORED: "idempotency.replay-does-not-duplicate",
	UNIQUE_NOT_ENFORCED: ["create.unique-conflict-rejected", "update.unique-conflict-rejected"],
	DELETE_MISSING_OK: "delete.absent-record-returns-404",
	IMMUTABLE_WRITABLE: "patch.immutable-field-rejected",
	PATCH_REPLACES: ["patch.minimality", "consistency.projections-agree"],
	SOFT_DELETE_LEAK: "softdelete.absent-from-default-list",
	CREATE_DROPS_FIELD: "create.persists-submitted-fields",
	READ_DROPS_FIELD: ["payload.string-survives", "consistency.projections-agree"],
	STRING_PAYLOAD_MANGLED: "payload.string-survives",
	COLUMN_NAME_MISMATCH: [
		"create.persists-submitted-fields",
		"list.read-after-write",
		"search.q-narrows-result",
		"filter.equality-selects-exactly-one",
		"sort.order-is-applied",
		"sort.multi-key-tiebreak",
		"response.status-is-documented",
		/* Postgres refuses the unknown column outright, so the defect's reads answer 500. */
		"response.no-server-error",
		/*
		 * On an engine with double-quoted-string fallback the response *shape* is corrupted, not
		 * just its values: D1 returns the unresolved identifier as the key, quotes included, so a
		 * row comes back as `{ "\"name\"": "name" }`. The declared property is then missing and an
		 * undeclared one is present, which is a genuine schema violation rather than a knock-on
		 * mis-diagnosis. Verified against a live D1; `node:sqlite` compiles the fallback off and
		 * never reaches this shape.
		 */
		"schema.success-response-matches-document",
	],
	CONCURRENT_WRITE_LOST: [
		"concurrency.no-lost-update",
		/* The defect *is* read-modify-write: PATCH reads the row, then writes every column back.
		 * That is PUT semantics wearing a PATCH label, so whenever anything else touches the row
		 * inside that window the rewrite clobbers a field the caller never named — which is
		 * precisely what the minimality check asserts against. It surfaces on a backend with real
		 * latency and hides on one without, so it is a legitimate second symptom, not a false
		 * positive. */
		"patch.minimality",
	],
	ETAG_IGNORED: "concurrency.if-match-enforced",
	DELETE_KEEPS_ROW: "delete.absent-record-returns-404",
	IDEMPOTENT_REPLAY_INSERTS: "idempotency.replay-does-not-duplicate",
	/* A table stored under an id the client was never told cannot parent the rows seeded under it. */
	/* A server that ignores the client's id accepts a create repeating an existing id: the unique
	 * check on the identity is that same loss, seen from the other side. */
	CLIENT_ID_IGNORED: ["create.keeps-submitted-identity", "world.seed", "create.unique-conflict-rejected"],
	CLIENT_ID_OVERWRITES: "create.unique-conflict-rejected",
	/* The payload probe's control write is what hides the row: reading it back finds nothing. */
	HIDDEN_FROM_CREATOR: "payload.string-survives",
	CREATE_500_ON_NON_ASCII: [
		"create.does-not-error",
		/* The probes that write non-ASCII strings hit the same crash on their own creates. */
		"payload.string-survives",
		"response.status-is-documented",
		"response.no-server-error",
	],
}
