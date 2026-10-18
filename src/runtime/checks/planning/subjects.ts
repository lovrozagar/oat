import type { EntityModel, OperationModel, SpecModel } from "../../../spec/graph.ts"
import type { Exchange } from "../../client.ts"
import type { CheckContext } from "../core/context.ts"

export const graded = (ctx: CheckContext, op: OperationModel): boolean => ctx.inScope?.(op) ?? true

/* A record that does not carry its identity names nothing a request could address. */
export const NO_IDENTITY = "a record that carries its identity"

/* Matches no id: what a record without an identity is looked up as. */
export const NO_KEY = "\u0000no-identity"

export const declared = (...operationIds: Array<string | undefined>): string[] =>
	operationIds.filter((id): id is string => id !== undefined && id !== "")

export const ownOps = (entity: EntityModel, model: SpecModel, keep: (op: OperationModel) => boolean): string[] =>
	model.operations.filter((op) => op.entity === entity.name && keep(op)).map((op) => op.operationId)

/** Subject sets shared by the registry. Each reads the same fields the check's context is built from. */
export const subjectsOf = {
	async: (entity: EntityModel, model: SpecModel): string[] => ownOps(entity, model, (op) => op.async !== null),
	asyncReceipt: (entity: EntityModel, model: SpecModel): string[] =>
		ownOps(entity, model, (op) => op.async?.idFrom !== undefined),
	create: (entity: EntityModel): string[] => declared(entity.create),
	createAndForeignReads: (entity: EntityModel, model: SpecModel): string[] => {
		const create = model.byOperationId.get(entity.create ?? "")
		if (create === undefined) return []
		const foreign = create.invalidates
			.map((route) => model.byRoute.get(route))
			.filter(
				(op): op is OperationModel =>
					op !== undefined && op.entity !== entity.name && op.method.toUpperCase() === "GET",
			)
			.map((op) => op.operationId)
		return [create.operationId, ...foreign]
	},
	createAndList: (entity: EntityModel): string[] => declared(entity.create, entity.list),
	delete: (entity: EntityModel): string[] => declared(entity.delete),
	deleteAndList: (entity: EntityModel): string[] => declared(entity.delete, entity.list),
	effects: (entity: EntityModel, model: SpecModel): string[] => ownOps(entity, model, (op) => op.effects.length > 0),
	invite: (entity: EntityModel): string[] =>
		entity.invite === null ? [] : declared(entity.invite.invite, entity.invite.accept, entity.invite.revoke),
	list: (entity: EntityModel): string[] => declared(entity.list),
	nonCreate: (entity: EntityModel, model: SpecModel): string[] => ownOps(entity, model, (op) => op.action !== "create"),
	read: (entity: EntityModel): string[] => declared(entity.read),
	readAndGated: (entity: EntityModel, model: SpecModel): string[] => [
		...new Set([...declared(entity.read), ...ownOps(entity, model, (op) => op.featureGate !== null)]),
	],
	readAndList: (entity: EntityModel): string[] => declared(entity.read, entity.list),
	update: (entity: EntityModel): string[] => declared(entity.update),
	waits: (entity: EntityModel, model: SpecModel): string[] => ownOps(entity, model, (op) => op.wait !== null),
	writeAndRead: (entity: EntityModel): string[] => declared(entity.update ?? entity.create, entity.read),
}

export function itemParamFor(ctx: CheckContext, id: string): Record<string, string> {
	const op = ctx.readOp ?? ctx.updateOp ?? ctx.deleteOp
	const param = op?.pathParams.at(-1)
	return param === undefined ? {} : { [param]: id }
}

/** Document first, then the live `Content-Type`. Media type is the stream tag — not `x-async`. */
export function isEventStream(exchange: Exchange, op?: OperationModel): boolean {
	if (op?.eventStream === true) return true
	const type = exchange.responseHeaders["content-type"] ?? ""
	return type.includes("text/event-stream")
}
