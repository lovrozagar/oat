import { messageOf } from "../../errors/message.ts"

/**
 * An unexpected error as a report states it: its message, named when it is not a plain `Error`.
 *
 * Never its stack. Every caller files the text as a finding, and `FindingCollector` makes a
 * finding's text fit to share (no stack frame, no absolute path), so that rule lives there alone.
 */
export function errorText(error: unknown): string {
	return error instanceof Error && error.name !== "Error" ? `${error.name}: ${error.message}` : messageOf(error)
}
