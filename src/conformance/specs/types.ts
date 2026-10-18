/** One hostile spec fixture: a document and what oat should find in it. */
export interface SpecFixture {
	name: string
	why: string
	doc: Record<string, unknown>
	/** Operations oat should find. Undefined means "no expectation, just do not crash". */
	expectOperations?: number
	expectEntities?: number
}
