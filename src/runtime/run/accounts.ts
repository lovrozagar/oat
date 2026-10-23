/**
 * Removes every account the run made, and lists by name each one it could not.
 *
 * In this order, each tried only when the one before could not: the document's delete-self, sent
 * as the account itself; the delete of the entity its sign-up creates, by its id, as the configured
 * principals strongest first; `hooks.teardownPrincipal`. What is left is a leftover, named by the
 * email or username it was made with, so a person can remove it. An account whose name a
 * configured principal holds, that this run did not make, is never removed: it is not oat's.
 */

import type { OperationModel } from "../../spec/graph/types.ts"
import type { RunFindingId } from "../check-ids.ts"
import type { Exchange } from "../exchange.ts"
import { accountLabel } from "../accounts/identity.ts"
import { type AccountEntry, names } from "../accounts/ledger.ts"
import { type AccountOps, accountOps } from "../accounts/ops.ts"
import { fillPath } from "../fill-path.ts"
import type { TeardownReport } from "../teardown/types.ts"
import { messageOf } from "../../errors/message.ts"
import { effectiveRecipe } from "../../credentials/effective.ts"
import { recipeKind } from "../../credentials/recipes/acquire.ts"
import { signsUp, signupOf } from "../../credentials/signup.ts"
import type { RunContext } from "./context.ts"
import { bindSignUp } from "./fresh.ts"
import { createdByRun, logIn } from "./principals.ts"
import { merged } from "./teardown.ts"

type Verdict = { status: "removed" | "left"; note: string; principal?: string }

/* A delete that answered this left no account: removed now, or gone already. */
function gone(exchange: Exchange): boolean {
	return (exchange.status >= 200 && exchange.status < 300) || exchange.status === 404 || exchange.status === 410
}

export async function teardownAccounts(ctx: RunContext): Promise<void> {
	const { options, accounts, findings } = ctx
	if (options.skipPrincipalTeardown === true) return
	declareMade(ctx)
	const owed = accounts.owed()
	if (owed.length === 0) return
	const ops = accountOps(ctx.model)
	for (const entry of owed) {
		let verdict: Verdict
		try {
			verdict = await removeAccount(ctx, ops, entry)
		} catch (error) {
			verdict = { note: `teardown stopped on an unexpected error: ${messageOf(error)}`, status: "left" }
			findings.blocked("world.teardown" satisfies RunFindingId, "account", {
				cause: messageOf(error),
				summary: `could not remove account ${labelOf(entry)}`,
			})
		}
		accounts.settle(entry, verdict)
	}
	/* Every account it made, with each one that deleted itself during the run. */
	const made = accounts.entries().filter((entry) => entry.status !== "refused")
	ctx.state.teardown = merged(ctx.state.teardown, accountReport(made))
}

/* How a person finds the account: by its email, else by how it was made. */
function labelOf(entry: AccountEntry): string {
	return accountLabel(entry.identity) ?? `#${entry.n} by ${entry.operationId}`
}

/** Each account the run made as its report lists it: removed, or a leftover named so a person can find it. */
export function accountReport(entries: readonly AccountEntry[]): TeardownReport {
	const named = entries.map((entry) => ({
		entry,
		id: labelOf(entry),
		principal: entry.principal ?? "(none)",
	}))
	return {
		failed: named
			.filter(({ entry }) => entry.status !== "removed")
			.map(({ entry, id, principal }) => ({
				entity: "account",
				id,
				principal,
				reason: entry.note ?? "teardown did not run",
			})),
		records: named.map(({ entry, id, principal }) => ({
			entity: "account",
			id,
			principal,
			removed: entry.status === "removed",
		})),
		removed: named.filter(({ entry }) => entry.status === "removed").length,
		unidentified: [],
		unsupported: [],
	}
}

/* A principal declared made by the run (`fresh`, `created`, or a login that signs up) whose sign-up no entry names. */
function declareMade(ctx: RunContext): void {
	for (const principal of ctx.principals.all) {
		if (!createdByRun(ctx, principal.id)) continue
		const identity = ctx.store.identityOf(principal.id)
		if (ctx.accounts.entries().some((entry) => names(entry, identity))) continue
		ctx.accounts.made(principal.id, identity)
	}
}

async function removeAccount(ctx: RunContext, ops: AccountOps, entry: AccountEntry): Promise<Verdict> {
	const held = holder(ctx, entry)
	if (held !== undefined && configuredNotMade(ctx, held)) {
		return {
			note: `its name is configured principal ${held}'s, which this run did not make; oat removes only accounts it made`,
			principal: held,
			status: "left",
		}
	}
	const principal = held ?? (await signIn(ctx, entry))
	const tried: string[] = []
	const op = ops.deleteSelf
	if (op !== undefined && principal === undefined) {
		tried.push(`${op.operationId} needs the account signed in, and the run holds no credential for it`)
	} else if (op !== undefined && principal !== undefined) {
		const why = await borrowedFor(ctx, principal, op)
		if (why !== undefined) {
			tried.push(`${op.operationId} was not sent as the account: ${why}`)
		} else {
			const sent = await sendAs(ctx, { as: principal, op, path: op.path, tried, who: "the account" })
			if (sent !== undefined && gone(sent)) {
				return { note: `deleted itself by ${op.operationId} (${sent.status})`, principal, status: "removed" }
			}
		}
	}
	const admin = await adminDelete(ctx, ops, entry, tried)
	if (admin !== undefined) return admin
	const hooked = await hookRemoves(ctx, entry, principal, tried)
	if (hooked !== undefined) return hooked
	if (tried.length === 0) tried.push("the document has no delete-self, and no hooks.teardownPrincipal is configured")
	return { note: tried.join("; "), status: "left", ...(principal === undefined ? {} : { principal }) }
}

/*
 * Why what `principal` would send on `op` is not its own account's credential, if it is not: a
 * delete-self sent with it would remove whoever the credential belongs to. Judged on the schemes the
 * client picks for `op`, not on every credential the principal holds.
 */
async function borrowedFor(ctx: RunContext, principal: string, op: OperationModel): Promise<string | undefined> {
	const route = `${op.method.toUpperCase()} ${op.path}`
	const resolution = await ctx.client.credentialFor({ actor: { principal }, operationId: op.operationId, route })
	if (resolution.kind === "unsatisfied" || resolution.kind === "blocked") {
		return `it holds no credential of its own for ${op.operationId}`
	}
	if (resolution.kind !== "sends") return `${op.operationId} would carry no credential of the account's`
	return borrowed(
		ctx,
		principal,
		resolution.schemes.map((scheme) => ({ scheme, value: resolution.sentValues[scheme] as string })),
	)
}

/*
 * Why these values `principal` sends are not its own account's, if they are not: one from a static
 * recipe is the configured principals' own, and one another principal holds too is that principal's.
 */
async function borrowed(
	ctx: RunContext,
	principal: string,
	sent: ReadonlyArray<{ scheme: string; value: string }>,
): Promise<string | undefined> {
	const entry = ctx.store.principals[principal]
	for (const { scheme } of sent) {
		const recipe = effectiveRecipe(ctx.options.security?.[scheme], entry?.security?.[scheme])
		if (recipe !== undefined && recipeKind(recipe) === "static") {
			return `its ${scheme} credential comes from a static recipe, the configured principals' own`
		}
	}
	const values = new Set(sent.map((one) => one.value))
	const shared = (await ctx.store.snapshot()).find(
		(one) => one.principal !== principal && values.has(one.credential.value),
	)
	return shared === undefined ? undefined : `its credential is ${shared.principal}'s`
}

/* The principal the run holds this account as, by the names it was made with. */
function holder(ctx: RunContext, entry: AccountEntry): string | undefined {
	if (entry.principal !== undefined) return entry.principal
	return Object.keys(ctx.store.principals).find((id) => names(entry, ctx.store.identityOf(id)))
}

function configuredNotMade(ctx: RunContext, id: string): boolean {
	return Object.hasOwn(ctx.options.principals, id) && !createdByRun(ctx, id)
}

/*
 * An account no principal holds, a check's sign-up say: held as `account-<n>` from what it sent and
 * answered. A credential the answer carried is enough; otherwise its recipes sign it in, unless one
 * of them signs up, which would make another account to remove.
 */
async function signIn(ctx: RunContext, entry: AccountEntry): Promise<string | undefined> {
	const signUp = ctx.accounts.signUpOf(entry)
	const body = signUp?.body
	if (signUp?.answer === undefined || body === null || typeof body !== "object" || Array.isArray(body)) return undefined
	const id = `account-${entry.n}`
	await bindSignUp(ctx, { body: body as Record<string, unknown>, entry: {}, id, signup: signUp.answer })
	if ((await ctx.store.snapshot()).some((held) => held.principal === id)) return id
	const { signup } = signupOf(ctx.model)
	if (Object.values(ctx.options.security ?? {}).some((recipe) => signsUp(recipe, signup))) return undefined
	return (await logIn(ctx, id, {})) === undefined ? id : undefined
}

/* The delete of the entity the sign-up creates, by the account's id, as each configured principal the run did not make, strongest first. */
async function adminDelete(
	ctx: RunContext,
	ops: AccountOps,
	entry: AccountEntry,
	tried: string[],
): Promise<Verdict | undefined> {
	const admin = ops.adminDelete(entry.operationId)
	if (admin === undefined || entry.id === undefined) return undefined
	const { op } = admin
	const param = op.pathParams.at(-1) as string
	const path = fillPath(op.path, { [param]: entry.id })
	const admins = ctx.principals.all.filter((principal) => !createdByRun(ctx, principal.id))
	for (const principal of admins.toSorted((a, b) => b.rank - a.rank)) {
		const sent = await sendAs(ctx, { as: principal.id, op, path, tried, who: principal.id })
		if (sent !== undefined && gone(sent)) {
			return {
				note: `deleted by ${op.operationId} as ${principal.id} (${sent.status})`,
				principal: principal.id,
				status: "removed",
			}
		}
	}
	return undefined
}

/*
 * One teardown request as principal `as`: what it answered, or undefined when it could not be sent,
 * its credential gone with its session say. Either way `tried` says so, and the next way may still
 * remove the account.
 */
async function sendAs(
	ctx: RunContext,
	send: { as: string; op: OperationModel; path: string; tried: string[]; who: string },
): Promise<Exchange | undefined> {
	const { op, path, tried, who } = send
	try {
		const sent = await ctx.client
			.view({ purpose: "teardown" })
			.request(op.method, path, { as: { principal: send.as }, operationId: op.operationId })
		if (!gone(sent)) tried.push(`${op.operationId} as ${who} answered ${sent.status}`)
		return sent
	} catch (error) {
		tried.push(`${op.operationId} as ${who} was not sent: ${messageOf(error)}`)
		return undefined
	}
}

async function hookRemoves(
	ctx: RunContext,
	entry: AccountEntry,
	principal: string | undefined,
	tried: string[],
): Promise<Verdict | undefined> {
	const teardown = ctx.hooks.teardownPrincipal
	if (teardown === undefined) return undefined
	const address = accountLabel(entry.identity)
	const held = (await ctx.store.snapshot()).find((one) => principal !== undefined && one.principal === principal)
	const credential = held?.credential
	if (address === undefined || principal === undefined || held === undefined || credential === undefined) {
		tried.push(
			`hooks.teardownPrincipal needs ${address === undefined ? "an address to name it by" : "a credential the run holds for it"}`,
		)
		return undefined
	}
	/* A hook handed another principal's credential as this account's would remove that account. */
	const why = await borrowed(ctx, principal, [{ scheme: held.scheme, value: credential.value }])
	if (why !== undefined) {
		tried.push(`hooks.teardownPrincipal was not called: ${why}, and it is handed the account's own credential`)
		return undefined
	}
	try {
		await teardown(address, { credential: credential.value, sends: credential.sends })
		return { note: "removed by hooks.teardownPrincipal", principal, status: "removed" }
	} catch (error) {
		tried.push(`hooks.teardownPrincipal threw: ${messageOf(error)}`)
		return undefined
	}
}
