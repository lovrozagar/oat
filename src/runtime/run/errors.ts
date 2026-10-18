/** An unexpected error as a report states it: its stack when it has one. */
export function errorText(error: unknown): string {
	return error instanceof Error ? (error.stack ?? error.message) : String(error)
}
