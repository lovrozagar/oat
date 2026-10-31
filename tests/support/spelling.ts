/* en-GB spellings in text, identifiers included, for the structure test that holds oat to en-US. */

/* The en-GB spellings, inflections spelled out, so no correct en-US word can ever match. */
const EN_GB: ReadonlySet<string> = /* @__PURE__ */ new Set(
	`	behaviour behaviours behavioural colour colours coloured colouring honour honours honoured honouring
	favour favours favoured favourite favourable flavour flavours flavoured neighbour neighbours
	labour humour rumour vapour armour endeavour savour harbour
	organise organised organises organising organiser organisation organisations
	recognise recognised recognises recognising recognisable unrecognised
	initialise initialised initialises initialising initialiser initialisation
	serialise serialised serialises serialising serialiser serialisation deserialise deserialised deserialisation
	normalise normalised normalises normalising normaliser normalisation denormalise denormalised
	summarise summarised summarises summarising singularise singularised singularises pluralise pluralised
	capitalise capitalised parenthesise parenthesised synthesise synthesised synthesises
	generalise generalised generalises generalising generalisation categorise categorised uncategorised
	prioritise prioritised optimise optimised optimises optimising optimisation minimise minimised
	maximise maximised customise customised customisation authorise authorised authorises authorisation
	unauthorised finalise finalised localise localised localisation specialise specialised sanitise
	sanitised sanitiser sanitisation standardise standardised utilise utilised visualise materialise
	materialised memoise memoised tokenise tokenised tokeniser emphasise apologise
	analyse analysed analysing analyser paralyse catalyse
	catalogue catalogues catalogued analogue
	centre centres centred metre metres litre litres theatre fibre calibre
	licence defence offence pretence
	modelled modelling modeller unmodelled unlabelled labelled labelling labeller mislabelled cancelled cancelling travelled
	travelling traveller signalled signalling totalled journalled levelled channelled marshalled
	unmarshalled fuelled funnelled tunnelled counselled
	grey judgement judgements acknowledgement acknowledgements programme programmes whilst amongst artefact artefacts sceptical
	fulfil skilful wilful ageing practise practised enrolment
`
		.split(/\s+/)
		.filter(Boolean),
)

/**
 * Files that quote en-GB on purpose: a target's vendored API document and lockfiles naming
 * packages, which are third-party text, and this list with its test, which spell what they find.
 */
export const QUOTED_FILES: readonly RegExp[] = [
	/^tests\/targets\/[^/]+\/openapi[^/]*\.(json|ya?ml)$/,
	/(^|\/)package-lock\.json$/,
	/^tests\/support\/spelling\.ts$/,
	/^tests\/structure\/spelling\.test\.ts$/,
]

/*
 * Tokens quoted in our own files: GitHub Actions' `cancelled()` and its 'cancelled' result, and the
 * three 0.24 check ids, named where a migration says what replaced them and a baseline refuses them.
 */
const QUOTED_TOKENS: readonly RegExp[] = [
	/\bcancelled\(\)/g,
	/["']cancelled["']/g,
	/\b(select\.projection|select\.nested|spec\.declared-rate-limit-is)-honoured\b/g,
]

/** The en-GB words in `text`, lower case, in order, identifiers split at case and `_` boundaries. */
export function enGbWords(text: string): string[] {
	const own = QUOTED_TOKENS.reduce((left, token) => left.replace(token, ""), text)
	return (own.match(/[A-Za-z]+/g) ?? [])
		.flatMap((word) => word.split(/(?<=[a-z])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/))
		.map((word) => word.toLowerCase())
		.filter((word) => EN_GB.has(word))
}
