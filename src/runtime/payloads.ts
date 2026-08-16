/**
 * Discriminating string payloads.
 *
 * The unicode cohort member is a compact mix so filter/sort/search see more than Latin-1. The
 * catalog is the exhaustive set: each case is written and read back by `payload.string-survives`.
 * Cases that cannot exist on the JSON wire (NUL, lone surrogates, invalid UTF-8) are omitted.
 */

export const UNICODE_COHORT_STRING = "äöüß čćžšđ 日本語 中文 한글 привет مرحبا 🙂"

export interface StringPayload {
	id: string
	value: string
	why: string
}

export function codePointCount(text: string): number {
	return [...text].length
}

export function sliceCodePoints(text: string, max: number): string {
	if (codePointCount(text) <= max) return text
	return [...text].slice(0, max).join("")
}

export function payloadFits(value: string, maxLength: number | undefined, minLength: number | undefined): boolean {
	const n = codePointCount(value)
	if (maxLength !== undefined && n > maxLength) return false
	if (minLength !== undefined && n < minLength) return false
	return true
}

export const STRING_PAYLOADS: readonly StringPayload[] = [
	{ id: "empty", value: "", why: "empty vs null vs omitted" },
	{ id: "space", value: " ", why: "single ASCII space" },
	{ id: "spaces", value: "   ", why: "whitespace-only" },
	{ id: "tab", value: "\t", why: "horizontal tab" },
	{ id: "lf", value: "\n", why: "line feed" },
	{ id: "cr", value: "\r", why: "carriage return" },
	{ id: "crlf", value: "\r\n", why: "CRLF" },
	{ id: "vt", value: "\v", why: "vertical tab" },
	{ id: "ff", value: "\f", why: "form feed" },
	{ id: "leading-space", value: " leading", why: "trim on write" },
	{ id: "trailing-space", value: "trailing ", why: "trim on write" },
	{ id: "both-space", value: " padded ", why: "trim both ends" },
	{ id: "internal-double", value: "a  b", why: "collapse of internal space" },

	{ id: "nbsp", value: "\u00A0", why: "non-breaking space" },
	{ id: "nnbsp", value: "\u202F", why: "narrow no-break space" },
	{ id: "thin-space", value: "\u2009", why: "thin space" },
	{ id: "hair-space", value: "\u200A", why: "hair space" },
	{ id: "en-space", value: "\u2002", why: "en space" },
	{ id: "em-space", value: "\u2003", why: "em space" },
	{ id: "figure-space", value: "\u2007", why: "figure space" },
	{ id: "punct-space", value: "\u2008", why: "punctuation space" },
	{ id: "mmsp", value: "\u205F", why: "medium mathematical space" },
	{ id: "ideographic-space", value: "\u3000", why: "ideographic space" },
	{ id: "ogham-space", value: "\u1680", why: "Ogham space mark" },
	{ id: "braille-blank", value: "\u2800", why: "Braille blank, looks empty" },

	{ id: "zwsp", value: "\u200B", why: "zero-width space" },
	{ id: "zwnj", value: "\u200C", why: "zero-width non-joiner" },
	{ id: "zwj", value: "\u200D", why: "zero-width joiner" },
	{ id: "bom", value: "\uFEFF", why: "BOM / zero-width no-break space" },
	{ id: "word-joiner", value: "\u2060", why: "word joiner" },
	{ id: "soft-hyphen", value: "\u00AD", why: "soft hyphen" },
	{ id: "cgj", value: "\u034F", why: "combining grapheme joiner" },
	{ id: "invisible-times", value: "\u2062", why: "invisible times" },
	{ id: "invisible-separator", value: "\u2063", why: "invisible separator" },
	{ id: "invisible-plus", value: "\u2064", why: "invisible plus" },
	{ id: "function-application", value: "\u2061", why: "function application" },
	{ id: "hangul-filler", value: "\u3164", why: "Hangul filler" },
	{ id: "hangul-choseong-filler", value: "\u115F", why: "Hangul choseong filler" },
	{ id: "hangul-jungseong-filler", value: "\u1160", why: "Hangul jungseong filler" },
	{ id: "leading-zwsp", value: "\u200Bvisible", why: "leading ZWSP stripped" },
	{ id: "trailing-nbsp", value: "visible\u00A0", why: "trailing NBSP stripped" },
	{ id: "soft-hyphen-embedded", value: "invis\u00ADible", why: "soft hyphen eaten mid-word" },

	{ id: "lrm", value: "\u200E", why: "left-to-right mark" },
	{ id: "rlm", value: "\u200F", why: "right-to-left mark" },
	{ id: "alm", value: "\u061C", why: "Arabic letter mark" },
	{ id: "lre-pdf", value: "\u202Aembedded\u202C", why: "LRE/PDF pair" },
	{ id: "rle-pdf", value: "\u202Bembedded\u202C", why: "RLE/PDF pair" },
	{ id: "lro-pdf", value: "\u202Dembedded\u202C", why: "LRO/PDF pair" },
	{ id: "rlo-pdf", value: "\u202Eembedded\u202C", why: "RLO/PDF pair" },
	{ id: "lri-pdi", value: "\u2066embedded\u2069", why: "LRI/PDI pair" },
	{ id: "rli-pdi", value: "\u2067embedded\u2069", why: "RLI/PDI pair" },
	{ id: "fsi-pdi", value: "\u2068embedded\u2069", why: "FSI/PDI pair" },
	{ id: "mixed-bidi", value: "hello مرحبا world", why: "LTR + Arabic + LTR" },
	{ id: "trojan-bidi", value: "admin\u202E\u2066user", why: "Trojan Source RLO/FSI wrap" },

	{ id: "c0-soh", value: "\u0001", why: "C0 SOH" },
	{ id: "c0-bel", value: "\u0007", why: "C0 BEL" },
	{ id: "c0-bs", value: "\u0008", why: "C0 backspace" },
	{ id: "c0-esc", value: "\u001B", why: "C0 escape" },
	{ id: "del", value: "\u007F", why: "DEL" },
	{ id: "c1-nel", value: "\u0085", why: "C1 next line" },
	{ id: "c1-apc", value: "\u009F", why: "C1 APC" },
	{ id: "line-separator", value: "\u2028", why: "line separator, historical JSON-in-script" },
	{ id: "paragraph-separator", value: "\u2029", why: "paragraph separator" },

	{ id: "german", value: "äöüÄÖÜßẞ", why: "German umlauts and sharp s" },
	{ id: "german-strasse", value: "Straße", why: "ß / ss / ẞ fold" },
	{ id: "croatian", value: "čćžšđ ČĆŽŠĐ", why: "Croatian / South Slavic Latin" },
	{ id: "polish", value: "ąćęłńóśźż", why: "Polish Latin-extended" },
	{ id: "czech", value: "ěřůťďňľ", why: "Czech / Slovak" },
	{ id: "romanian", value: "ăâîșț", why: "Romanian" },
	{ id: "hungarian", value: "őű", why: "Hungarian double-acute" },
	{ id: "turkish-i", value: "ıiIİ", why: "Turkish dotless-i trap" },
	{ id: "nordic", value: "åæøÅÆØ", why: "Nordic" },
	{ id: "icelandic", value: "ðþÐÞ", why: "Icelandic" },
	{ id: "portuguese", value: "ãõç", why: "Portuguese" },
	{ id: "french", value: "œæÉÀÙ", why: "French" },
	{ id: "vietnamese", value: "Việt ơưạ", why: "Vietnamese stacked diacritics" },
	{ id: "baltic", value: "ėįū āēģķļņ", why: "Lithuanian / Latvian" },
	{ id: "catalan", value: "l·l", why: "Catalan middle-dot geminate" },
	{ id: "welsh", value: "ŵŷ", why: "Welsh circumflex vowels" },
	{ id: "esperanto", value: "ĉĝĥĵŝŭ", why: "Esperanto" },

	{ id: "russian", value: "Привет ёЁ ъь", why: "Russian Cyrillic" },
	{ id: "ukrainian", value: "їєґІ", why: "Ukrainian" },
	{ id: "serbian-cyr", value: "ђћјљњџ", why: "Serbian Cyrillic" },
	{ id: "bulgarian", value: "ъ", why: "Bulgarian er-golyam" },
	{ id: "greek", value: "Ελληνικά", why: "Greek" },

	{ id: "arabic", value: "مرحبا", why: "Arabic" },
	{ id: "arabic-harakat", value: "مَرْحَبًا", why: "Arabic with harakat" },
	{ id: "hebrew", value: "שלום", why: "Hebrew" },
	{ id: "hebrew-niqqud", value: "שָׁלוֹם", why: "Hebrew with niqqud" },
	{ id: "persian", value: "سلام", why: "Persian" },
	{ id: "urdu", value: "اردو", why: "Urdu" },

	{ id: "japanese", value: "日本語 ひらがな カタカナ", why: "kanji + hiragana + katakana" },
	{ id: "chinese-simplified", value: "汉字", why: "simplified Chinese" },
	{ id: "chinese-traditional", value: "漢字", why: "traditional Chinese" },
	{ id: "korean", value: "한글", why: "Hangul" },
	{ id: "fullwidth", value: "ＡＢＣ１２３", why: "fullwidth Latin and digits" },
	{ id: "halfwidth-katakana", value: "ｶﾀｶﾅ", why: "halfwidth katakana" },

	{ id: "hindi", value: "नमस्ते", why: "Devanagari" },
	{ id: "bengali", value: "বাংলা", why: "Bengali" },
	{ id: "tamil", value: "தமிழ்", why: "Tamil" },
	{ id: "thai", value: "สวัสดี", why: "Thai" },
	{ id: "lao", value: "ສະບາຍດີ", why: "Lao" },
	{ id: "khmer", value: "សួស្តី", why: "Khmer" },
	{ id: "tibetan", value: "བོད་ཡིག", why: "Tibetan" },
	{ id: "georgian", value: "ქართული", why: "Georgian" },
	{ id: "armenian", value: "Հայերեն", why: "Armenian" },
	{ id: "amharic", value: "አማርኛ", why: "Ethiopic / Amharic" },

	{
		id: "rare-scripts",
		value: "ⵣߒܐހඅကᠠᏣᓀ𞤀ᚠ᚛𐐔𐒀",
		why: "Tifinagh N'Ko Syriac Thaana Sinhala Myanmar Mongolian Cherokee Canadian-Aboriginal Adlam Runic Ogham Deseret Osage",
	},

	{ id: "emoji-basic", value: "🙂", why: "basic emoji, supplementary plane" },
	{ id: "emoji-skin", value: "👋🏽", why: "Fitzpatrick skin-tone modifier" },
	{ id: "emoji-zwj-job", value: "👩‍💻", why: "ZWJ profession sequence" },
	{ id: "emoji-zwj-family", value: "👨‍👩‍👧", why: "ZWJ family sequence" },
	{ id: "emoji-flag", value: "🇭🇷", why: "regional-indicator flag" },
	{ id: "emoji-flag-tag", value: "🏴󠁧󠁢󠁥󠁮󠁧󠁿", why: "tag-sequence flag" },
	{ id: "emoji-keycap", value: "1️⃣", why: "keycap combining sequence" },
	{ id: "emoji-vs16", value: "❤️", why: "emoji presentation vs text" },
	{ id: "emoji-heart-text", value: "❤", why: "text-presentation heart" },
	{ id: "emoji-zwj-flag", value: "🏴‍☠️", why: "ZWJ pirate flag" },
	{ id: "emoji-smp", value: "🧠", why: "SMP pictograph" },

	{ id: "nfc-eacute", value: "\u00E9", why: "NFC e-acute" },
	{ id: "nfd-eacute", value: "e\u0301", why: "NFD e + combining acute" },
	{ id: "nfc-and-nfd", value: "\u00E9e\u0301", why: "NFC and NFD of the same letter together" },
	{ id: "hangul-precomposed", value: "한", why: "precomposed Hangul syllable" },
	{ id: "hangul-jamo", value: "\u1112\u1161\u11AB", why: "Hangul L+V+T jamo" },
	{ id: "ligature-fi", value: "ﬁ", why: "Latin small ligature fi" },
	{ id: "isolated-combining", value: "\u0301", why: "lone combining acute" },
	{ id: "combining-stack", value: "a\u0301\u0302\u0308", why: "letter with stacked combining marks" },

	{ id: "latin-a", value: "a", why: "Latin a, pair with Cyrillic a" },
	{ id: "cyrillic-a", value: "а", why: "Cyrillic a, homoglyph of Latin a" },
	{ id: "paypal-latin", value: "paypal", why: "Latin paypal" },
	{ id: "paypal-cyrillic", value: "раураl", why: "Cyrillic lookalike of paypal" },
	{ id: "kelvin", value: "K", why: "Kelvin sign vs K" },
	{ id: "ascii-k", value: "K", why: "ASCII K, pair with Kelvin" },
	{ id: "long-s", value: "ſ", why: "Latin long s" },

	{ id: "quotes", value: "' \" `", why: "ASCII quotes" },
	{ id: "backslash", value: "\\", why: "backslash" },
	{ id: "sql-comment", value: "-- /*", why: "SQL comment tokens" },
	{ id: "html-script", value: "<script>", why: "HTML script tag, sanitiser bait" },
	{ id: "html-entity", value: "&amp;", why: "HTML entity" },
	{ id: "template-dollar", value: "${7}", why: "template interpolation" },
	{ id: "mustache", value: "{{name}}", why: "mustache interpolation" },
	{ id: "null-looking", value: "null", why: "the string null" },
	{ id: "undefined-looking", value: "undefined", why: "the string undefined" },
	{ id: "nan-looking", value: "NaN", why: "the string NaN" },
	{ id: "true-looking", value: "true", why: "the string true" },
	{ id: "zero", value: "0", why: "numeric-looking zero" },
	{ id: "neg-zero", value: "-0", why: "numeric-looking negative zero" },
	{ id: "exp-overflow", value: "1e309", why: "numeric-looking overflow" },
	{ id: "hex-looking", value: "0x1", why: "hex-looking" },
	{ id: "json-object", value: "{}", why: "JSON-looking object" },
	{ id: "json-array", value: "[]", why: "JSON-looking array" },
	{ id: "unicode-quotes", value: "“ ” ‚", why: "typographic quotes" },
	{ id: "embedded-nl", value: "a\nb", why: "newline inside the value" },
	{ id: "bom-prefix", value: "\uFEFFok", why: "BOM prefix on visible text" },
	{ id: "replacement", value: "\uFFFD", why: "replacement character" },
	{ id: "pua", value: "\uE000", why: "private-use area" },
	{ id: "currency", value: "€£¥₩₪₹₿", why: "currency signs" },
	{ id: "math-bold", value: "𝐀", why: "mathematical bold A, supplementary plane" },
	{ id: "superscript", value: "² ³", why: "superscript digits" },
]

const REQUIRED_IDS = [
	"empty",
	"space",
	"german",
	"croatian",
	"russian",
	"arabic",
	"japanese",
	"emoji-basic",
	"zwsp",
	"nbsp",
	"nfd-eacute",
	"html-script",
] as const

/** Catalog invariants. Failures are strings so the conformance parser suite can print them. */
export function catalogProblems(): string[] {
	const problems: string[] = []
	const seen = new Set<string>()
	for (const payload of STRING_PAYLOADS) {
		if (seen.has(payload.id)) problems.push(`duplicate id ${payload.id}`)
		seen.add(payload.id)
		if (payload.value.includes("\u0000")) problems.push(`${payload.id} contains NUL`)
		if (codePointCount(payload.value) > 128) problems.push(`${payload.id} exceeds 128 code points`)
		try {
			const round = JSON.parse(JSON.stringify(payload.value)) as string
			if (round !== payload.value) problems.push(`${payload.id} is not JSON-stable`)
		} catch {
			problems.push(`${payload.id} is not JSON-serialisable`)
		}
		for (let i = 0; i < payload.value.length; i++) {
			const code = payload.value.charCodeAt(i)
			const loneHigh = code >= 0xd800 && code <= 0xdbff && (payload.value.charCodeAt(i + 1) & 0xfc00) !== 0xdc00
			const loneLow = code >= 0xdc00 && code <= 0xdfff && (payload.value.charCodeAt(i - 1) & 0xfc00) !== 0xd800
			if (loneHigh || loneLow) {
				problems.push(`${payload.id} contains a lone surrogate`)
				break
			}
		}
	}
	for (const id of REQUIRED_IDS) {
		if (!seen.has(id)) problems.push(`missing required family ${id}`)
	}
	if (!UNICODE_COHORT_STRING.includes("äöüß")) problems.push("cohort missing German")
	if (!UNICODE_COHORT_STRING.includes("čćžšđ")) problems.push("cohort missing Croatian")
	if (!UNICODE_COHORT_STRING.includes("привет")) problems.push("cohort missing Russian")
	if (!UNICODE_COHORT_STRING.includes("日本語")) problems.push("cohort missing Japanese")
	if (!UNICODE_COHORT_STRING.includes("🙂")) problems.push("cohort missing emoji")
	return problems
}
