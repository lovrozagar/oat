/**
 * Ledgers each account-making request as it goes out, whatever sends it: a disposable session, a
 * fresh principal, a login that signs up, a scene, or a check's generated body. And notes an
 * account that deleted itself during the run, so teardown does not count it a leftover.
 */

import type { Client } from "../../client/client.ts"
import { SAFE } from "../../spec/methods.ts"
import type { Exchange } from "../exchange.ts"
import { returnedId } from "../proven-id.ts"
import { type AccountEntry, type AccountLedger, names } from "./ledger.ts"
import type { AccountOps } from "./ops.ts"

export interface AccountWatch {
	client: Client
	ledger: AccountLedger
	ops: AccountOps
	/** The identity the run holds `principal` under. */
	identityOf: (principal: string) => Readonly<Record<string, unknown>>
}

export function watchAccounts(watch: AccountWatch): void {
	const { client, ledger, ops } = watch
	client.setBeforeSend((sending) => {
		const { operationId } = sending
		if (operationId === undefined || SAFE.has(sending.method)) return undefined
		if (ops.creates(operationId)) {
			const entry = ledger.sending(operationId, sending.body)
			return (exchange) => ledger.answered(entry, exchange, idOf(watch, { body: sending.body, exchange, operationId }))
		}
		const principal = "principal" in sending.as ? sending.as.principal : undefined
		if (operationId !== ops.deleteSelf?.operationId || principal === undefined) return undefined
		return (exchange) => deletedItself(watch, { exchange, operationId, principal })
	})
}

/* The id an admin delete would remove the account by: as answered, else as sent. */
function idOf(
	watch: AccountWatch,
	{ operationId, body, exchange }: { operationId: string; body: unknown; exchange: Exchange },
): string | undefined {
	const identity = watch.ops.adminDelete(operationId)?.identity
	if (identity === undefined) return undefined
	const answer = exchange.responseBody
	const answered =
		answer !== null && typeof answer === "object" && !Array.isArray(answer)
			? returnedId(answer as Record<string, unknown>, identity)
			: undefined
	if (answered !== undefined) return answered
	const sent = body !== null && typeof body === "object" ? (body as Record<string, unknown>)[identity] : undefined
	return typeof sent === "string" ? sent : undefined
}

/* An account the run made, deleted by its own delete-self, which the backend accepted. */
function deletedItself(
	watch: AccountWatch,
	{ exchange, operationId, principal }: { exchange: Exchange; operationId: string; principal: string },
): void {
	if (exchange.status < 200 || exchange.status >= 300) return
	const identity = watch.identityOf(principal)
	const theirs = (entry: AccountEntry): boolean => names(entry, identity)
	for (const entry of watch.ledger.owed().filter(theirs)) {
		watch.ledger.settle(entry, {
			note: `deleted itself during the run (${operationId} #${exchange.seq})`,
			principal,
			status: "removed",
		})
	}
}
