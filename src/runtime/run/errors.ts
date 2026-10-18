/** An unexpected error as a report states it: its stack when it has one. */
export function errorText(error: unknown): string {
	return error instanceof Error ? (error.stack ?? error.message) : String(error)
}

/** An error's message as a report states it: the message, or anything else as text. */
export function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}
