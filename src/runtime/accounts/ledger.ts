/**
 * Every account the run asked a backend to make, written down before the request goes out.
 *
 * Records are ledgered from their answers; an account is ledgered from its request, because a run
 * that dies between the two still made it. With a file, the ledger is rewritten on every change, so
 * the run's folder names each account even when the process does not live to tear it down. It keeps
 * the names an account is found by, never what it signs in with: the bodies stay in memory.
 */

import { writeFileSync } from "node:fs"
import type { Exchange } from "../exchange.ts"
import { accountIdentity } from "./identity.ts"

/**
 * `sending` until the answer: a run that stops there may have made it. `created` and `refused` by
 * the answer; `removed` or `left` by teardown.
 */
export type AccountStatus = "sending" | "created" | "refused" | "removed" | "left"

export interface AccountEntry {
	/** In the order the run sent them, from 1. */
	n: number
	operationId: string
	/** The names the account is found by, as sent: its email, its username. */
	identity: Record<string, string>
	status: AccountStatus
	/** Its id, as the sign-up answered it or sent it, when an admin delete would need it. */
	id?: string
	/** The principal the run removed it as, or tried to. */
	principal?: string
	/** How teardown removed it, or why it could not. */
	note?: string
}

/** What a sign-up sent and answered, kept in memory only: teardown may need to sign in as it. */
export interface SignUp {
	body: unknown
	answer?: Exchange
}

export class AccountLedger {
	private readonly list: AccountEntry[] = []
	/* By entry: what each sign-up sent, then answered. */
	private readonly sent = new WeakMap<AccountEntry, SignUp>()

	/** `file`, when given, is rewritten with every change. */
	constructor(private readonly file?: string) {}

	/** A sign-up about to be sent: ledgered, and on disk, before it goes. */
	sending(operationId: string, body: unknown): AccountEntry {
		const entry: AccountEntry = {
			identity: accountIdentity(body),
			n: this.list.length + 1,
			operationId,
			status: "sending",
		}
		this.list.push(entry)
		this.sent.set(entry, { body })
		this.persist()
		return entry
	}

	/**
	 * An account the run made with no sign-up it saw: a principal declared `created`, say. Made, and
	 * held as `principal`.
	 */
	made(principal: string, identity: Readonly<Record<string, unknown>>): AccountEntry {
		const entry: AccountEntry = {
			identity: accountIdentity(identity),
			n: this.list.length + 1,
			operationId: "(declared created)",
			principal,
			status: "created",
		}
		this.list.push(entry)
		this.persist()
		return entry
	}

	/** Its answer: a 2xx made the account, anything else did not. */
	answered(entry: AccountEntry, exchange: Exchange, id?: string): void {
		const ok = exchange.status >= 200 && exchange.status < 300
		entry.status = ok ? "created" : "refused"
		if (ok && id !== undefined && id !== "") entry.id = id
		/* Only a sign-up the ledger saw sent is answered. */
		;(this.sent.get(entry) as SignUp).answer = exchange
		this.persist()
	}

	/** Teardown's verdict on it. */
	settle(entry: AccountEntry, verdict: { status: "removed" | "left"; note: string; principal?: string }): void {
		entry.status = verdict.status
		entry.note = verdict.note
		if (verdict.principal !== undefined) entry.principal = verdict.principal
		this.persist()
	}

	/** What the sign-up sent and answered. */
	signUpOf(entry: AccountEntry): SignUp | undefined {
		return this.sent.get(entry)
	}

	/** The accounts that may exist: made, or sent with no answer. */
	owed(): AccountEntry[] {
		return this.list.filter((entry) => entry.status === "created" || entry.status === "sending")
	}

	/** Every account the run asked for, in order. */
	entries(): readonly AccountEntry[] {
		return this.list
	}

	private persist(): void {
		if (this.file === undefined) return
		writeFileSync(this.file, `${JSON.stringify({ accounts: this.list }, null, 2)}\n`, { mode: 0o600 })
	}
}

/** Whether every name `entry` was sent under is one `identity` holds: the same account. */
export function names(entry: AccountEntry, identity: Readonly<Record<string, unknown>>): boolean {
	const sent = Object.entries(entry.identity)
	return sent.length > 0 && sent.every(([key, value]) => identity[key] === value)
}
