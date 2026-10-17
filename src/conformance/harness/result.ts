/** One case of a suite that is not the defect matrix: what it checked, why, and how it came out. */
export interface ParserResult {
	name: string
	why: string
	ok: boolean
	detail: string
}
