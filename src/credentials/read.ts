import { readPath } from "../client/read-path.ts"
import { readSaveAs } from "../runtime/cookies/save-as.ts"
import type { StepAnswer } from "./ports.ts"

/*
 * Reading a credential, a lifetime or a claim out of an answer. A recipe's `from` takes the same
 * address forms as `saveAs`: a JSON path of the body (dotted, a JSON pointer, or a filter, read
 * as everywhere else in oat), `header:<name>` or `cookie:<name>`.
 */

/** The text at an address of an answer: a non-empty string, or a number as text; else undefined. */
export function readAnswer(answer: StepAnswer, address: string): string | undefined {
	const value = readSaveAs(address, { ...answer, readJson: readPath })
	if (typeof value === "number") return String(value)
	return typeof value === "string" && value !== "" ? value : undefined
}
