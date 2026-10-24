/* Expectations that read the real clock, or bound an elapsed time with a number: a test's verdict then depends on the host. */

const CLOCK = /\b(performance\.now|Date\.now)\(\)/
const BOUND = /\)\.(not\.)?to(BeLessThan|BeLessThanOrEqual|BeGreaterThan|BeGreaterThanOrEqual)\(\s*[\d_.]+\s*\)/
const TIMED = /elapsed|duration|took|\bms\b|Ms\b/i

/**
 * The 1-based lines of `text` whose expectation reads the real clock or bounds a time with a
 * number, or none when the file fakes its timers.
 */
export function wallClockExpectations(text: string): number[] {
	if (text.includes("useFakeTimers")) return []
	return text.split("\n").flatMap((line, index) => {
		const at = line.indexOf("expect(")
		if (at === -1) return []
		const expectation = line.slice(at)
		const subject = expectation.slice(0, expectation.search(/\)\.(not\.)?to/) + 1)
		const timed = CLOCK.test(expectation) || (BOUND.test(expectation) && TIMED.test(subject))
		return timed ? [index + 1] : []
	})
}
