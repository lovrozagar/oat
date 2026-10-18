/** A scripted `fetch`: answers each request from a handler and keeps what was sent. */

export interface Sent {
	url: string
	method: string
	headers: Record<string, string>
	body: unknown
	redirect: RequestInit["redirect"]
	signal: boolean
}

export interface Transport {
	fetch: typeof fetch
	sent: Sent[]
}

export type Answer = (sent: Sent, index: number) => Response | Promise<Response>

export function transport(answer: Answer): Transport {
	const sent: Sent[] = []
	const scripted = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const request: Sent = {
			body: init?.body,
			headers: { ...(init?.headers as Record<string, string> | undefined) },
			method: init?.method ?? "GET",
			redirect: init?.redirect,
			signal: init?.signal !== undefined,
			url: String(input),
		}
		sent.push(request)
		return answer(request, sent.length - 1)
	}
	return { fetch: scripted as typeof fetch, sent }
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(body), {
		headers: { "content-type": "application/json", ...headers },
		status,
	})
}

/** An answer per call, in order; the last repeats. */
export function sequence(...answers: Array<() => Response>): Answer {
	return (_sent, index) => (answers[Math.min(index, answers.length - 1)] as () => Response)()
}

/** What `fetch` throws when the connection is refused. */
export function refused(): Error {
	return Object.assign(new TypeError("fetch failed"), {
		cause: Object.assign(new Error("connect"), { code: "ECONNREFUSED" }),
	})
}
