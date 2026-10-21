/*
 * An operation whose security lets anonymous callers in must not demand a credential. A read is sent
 * with none, where `addressOf` puts it by placement. A write is never really sent anonymously: it
 * carries a body that is not JSON, so a server that lets the request in refuses the body instead, and
 * only one that checks for a credential first answers 401 or 403. Anything but those passes; a 2xx to
 * that body is reported as the validation defect it is (BACKEND_BUG, not SECURITY: the route is open
 * as declared), and the create tracker takes the write as applied (ledgered on evidence, else
 * reported as a record that may remain). A param-free public read is left to
 * response.public-get-returns-success, which already sends it with no credential and asks more of the
 * answer, so one guarded route is one finding. Mutating, since it sends writes, if only unreadable ones.
 */

import { ASSERTED } from "../../../finding.ts"
import { documentsSuccess, isPublicGet } from "../../../one-shot.ts"
import { defineCheck } from "../../core/define.ts"
import { isReadMethod } from "../../core/operation.ts"
import { andThen, cannot, ready, when } from "../../core/plan.ts"
import { type Address, addressOf, allowsAnonymous, declaredPlan, refused, scopedAddress, send } from "./probing.ts"

const ID = "auth.anonymous-operation-open"

/** A body no JSON parser reads, sent as JSON: nothing a server could apply. */
export const MALFORMED = "{"

export const anonymousOperationOpen = defineCheck<Address>({
	id: ID,
	mutates: true,
	needs: "an operation whose security lets anonymous callers in",
	plan: (ctx) =>
		andThen(declaredPlan(ctx), () =>
			andThen(when(allowsAnonymous(ctx.security), "an operation whose security lets anonymous callers in"), () => {
				const { operation } = ctx
				if (isPublicGet(operation) && documentsSuccess(operation)) {
					return cannot(
						`an open operation response.public-get-returns-success does not already read; it grades ${ctx.subject}`,
					)
				}
				if (isReadMethod(operation)) return addressOf(ctx)
				return andThen(scopedAddress(ctx), ({ path }) =>
					ready({ body: MALFORMED, contentType: "application/json", path }),
				)
			}),
		),
	async run(ctx, address) {
		const exchange = await send(ctx, address, { anonymous: true })
		if (address.body !== undefined && exchange.status >= 200 && exchange.status < 300) {
			return ctx.findings.backend(ID, ctx.subject, {
				detail:
					`${ctx.subject} answered ${exchange.status} to a body that is not JSON, so it accepted input it ` +
					"could not have read. The route is open, as the document declares; its validation is the defect. " +
					"The write is taken as applied: teardown removes what it made, or reports it as a record that may " +
					"remain.",
				evidence: [exchange],
				summary: "an open write accepted a body it could not have read: a validation defect",
			})
		}
		if (!refused(exchange.status)) return ASSERTED
		const unread =
			address.body === undefined ? "" : " The body was malformed JSON, so the refusal came before the body was read."
		return ctx.findings.backend(ID, ctx.subject, {
			detail: `${ctx.subject} answered ${exchange.status} to a request with no credential, though the document declares it open.${unread}`,
			evidence: [exchange],
			summary: "an operation the document declares open demanded a credential",
		})
	},
	subject: "operation",
})
