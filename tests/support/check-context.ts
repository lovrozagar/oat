import { type CheckContext, checkMemo } from "../../src/runtime/checks/core/context.ts"
import { SchemaValidator } from "../../src/runtime/validate.ts"

/*
 * A complete `CheckContext` for tests that drive one check directly. Every field `run()` would
 * set has a neutral default here, so a field added to the context breaks this one place instead of
 * every hand-written fake — and those fakes are type-checked, so they cannot silently fall behind.
 */

type Required_ = "client" | "entityName" | "findings" | "listOp" | "model"

export function checkContext<C extends CheckContext["client"]>(
	fields: Pick<CheckContext<C>, Required_> & Partial<CheckContext<C>>,
): CheckContext<C> {
	return {
		actor: { id: "alpha", inviteAs: undefined, rank: 0, scope: {}, tenant: undefined },
		actors: [],
		asyncOps: [],
		collectionKey: null,
		createAcknowledged: false,
		createOp: undefined,
		deleteOp: undefined,
		effectOps: [],
		hooks: {},
		identity: "id",
		invite: null,
		memo: checkMemo(),
		nonce: "test",
		outOfBand: { attempts: 6, initialMs: 200, maxMs: 3000 },
		peerScope: undefined,
		query: null,
		readOp: undefined,
		records: [],
		scope: {},
		seed: 1,
		softDelete: null,
		uniqueAdopted: false,
		uniqueCreateOp: undefined,
		uniqueSets: [],
		uniqueUpdateOp: undefined,
		updateOp: undefined,
		uploads: { seed: 1 },
		validator: new SchemaValidator(),
		waitOps: [],
		...fields,
	}
}
