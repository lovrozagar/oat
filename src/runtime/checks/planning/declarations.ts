/**
 * How a backend answered a request exercising something the document declares. Only 400 and
 * 422 say "this is not supported"; 401, 403, 404 and 429 turn the request away before the
 * capability is ever consulted, and a 5xx is a crash, not a refusal.
 */
export function declarationAnswer(status: number): "accepted" | "refused" | "unknown" {
	if (status > 0 && status < 400) return "accepted"
	return status === 400 || status === 422 ? "refused" : "unknown"
}
