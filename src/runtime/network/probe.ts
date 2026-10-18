/** Whether an origin answers at all: any HTTP status is a link, only a network failure is not. */

import { classifyNetworkError } from "../../errors/network.ts"
import { hasUsableInterface } from "./interfaces.ts"

export interface ProbeOptions {
	timeoutMs?: number
	fetchImpl?: typeof fetch
	online?: () => boolean
}

export async function probeOrigin(origin: string, options: ProbeOptions = {}): Promise<boolean> {
	const online = options.online ?? hasUsableInterface
	if (!online()) return false
	const timeoutMs = options.timeoutMs ?? 2_000
	const fetchImpl = options.fetchImpl ?? fetch
	let url: URL
	try {
		url = new URL(origin)
	} catch {
		return false
	}
	try {
		const response = await fetchImpl(url.origin, {
			method: "HEAD",
			redirect: "manual",
			signal: AbortSignal.timeout(timeoutMs),
		})
		return response.status > 0
	} catch (error) {
		return classifyNetworkError(error) === null
	}
}
