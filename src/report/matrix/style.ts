/** The poster's stylesheet: one dark sheet, the entity cards laid out in up to five columns. */

const BEFORE_CARDS = `  :root {
    --bg: #243044;
    --ink: #f2ead8;
    --mute: #9aa3b2;
    --line: #4a5870;
    --passed: #7dcea0;
    --fail: #ff6b3d;
    --block: #6d7686;
    --skip: #3d4758;
    --pin: #f0c14b;
    --card: #1b2332;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; background: var(--bg); color: var(--ink); }
  body { font-family: "IBM Plex Mono", ui-monospace, monospace; font-size: 13px; line-height: 1.45; }
  .poster { width: 1440px; margin: 0 auto; padding: 32px 44px 36px; }
  header {
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 24px;
    align-items: end;
    border-bottom: 1px solid var(--line);
    padding-bottom: 16px;
  }
  .kicker { font-size: 11px; letter-spacing: 0.18em; text-transform: uppercase; color: var(--mute); }
  h1 {
    font-family: Syne, sans-serif;
    font-weight: 800;
    font-size: 38px;
    line-height: 0.95;
    letter-spacing: -0.03em;
    margin: 8px 0 10px;
  }
  .thesis { color: var(--ink); max-width: 44em; }
  .counts { display: grid; grid-template-columns: repeat(4, auto); gap: 18px 28px; text-align: right; }
  .counts b { display: block; font-family: Syne, sans-serif; font-size: 28px; font-weight: 700; }
  .counts span { color: var(--mute); font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; }
  .counts .failed b { color: var(--fail); }
  .counts .blocked b { color: var(--block); }
  .counts .passed b { color: var(--passed); }
  .band, .stage, .cards { margin-top: 18px; background: var(--card); border: 1px solid var(--line); }
  .band-label, .stage-label {
    color: var(--mute);
    font-size: 11px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    padding: 10px 16px 0;
  }
  svg { display: block; width: 100%; height: auto; }
  .legend {
    display: flex; gap: 22px; padding: 8px 16px 12px;
    color: var(--mute); font-size: 11px; letter-spacing: 0.06em; text-transform: uppercase;
  }
  .swatch { display: inline-block; width: 10px; height: 10px; margin-right: 6px; vertical-align: -1px; }
  .swatch.passed { background: var(--passed); }
  .swatch.failed { background: var(--fail); }
  .swatch.blocked { background: var(--block); box-shadow: inset 0 0 0 1px #9aa3b2; }
  .swatch.skipped { background: var(--skip); }
  .swatch.out-of-scope { background: transparent; box-shadow: inset 0 0 0 1px var(--skip); }
  .forest { padding: 16px 20px 20px; }
  .forest-lead { color: var(--mute); margin: 0 0 14px; }
  .bar-row { display: grid; grid-template-columns: 80px 1fr 90px; gap: 12px; align-items: center; margin: 6px 0; }
  .bar-name { color: var(--pin); }
  .bar-track { height: 8px; background: #2c3546; }
  .bar-fill { height: 8px; background: #ff6b3d; }
  .bar-n { color: var(--mute); font-size: 11px; }
  .bar-more { color: var(--mute); margin-top: 8px; }
  .crowd-note { margin-top: 16px; color: var(--mute); }
`

const AFTER_CARDS = `  .card { background: var(--card); padding: 14px 16px 16px; }
  .card h2 { font-family: Syne, sans-serif; font-size: 18px; margin: 0 0 6px; }
  .card .meta { color: var(--mute); font-size: 11px; margin-bottom: 10px; }
  .dots { display: flex; gap: 5px; flex-wrap: wrap; }
  .dot { width: 12px; height: 12px; border: 1px solid var(--line); }
  .dot.passed { background: var(--passed); border-color: #3f6b55; }
  .dot.failed { background: var(--fail); border-color: var(--fail); }
  .dot.blocked { background: transparent; border-style: dashed; border-color: var(--block); }
  .dot.skipped { background: var(--skip); }
  .dot.out-of-scope { background: transparent; opacity: 0.4; }
  .strips { margin-top: 18px; display: grid; gap: 10px; }
  .strip { display: grid; grid-template-columns: 140px 1fr; gap: 12px; align-items: start; }
  .strip-title { color: var(--mute); font-size: 11px; letter-spacing: 0.12em; text-transform: uppercase; padding-top: 6px; }
  .chips { display: flex; flex-wrap: wrap; gap: 6px; }
  .chip { border: 1px solid var(--line); padding: 3px 8px; color: var(--mute); }
  .chip.passed { color: var(--passed); border-color: #3f6b55; }
  .chip.failed { color: var(--fail); border-color: var(--fail); background: #3a221c; }
  .chip.blocked { color: var(--block); border-style: dashed; }
  .chip.skipped { opacity: 0.45; }
  .chip.out-of-scope { opacity: 0.25; border-style: dotted; }
  footer {
    margin-top: 18px; color: var(--mute); font-size: 11px;
    display: flex; justify-content: space-between; gap: 16px;
    border-top: 1px solid var(--line); padding-top: 12px;
  }
  footer code { color: var(--ink); }
`

/** The sheet for a poster of `entityCount` entities, one or more. */
export function posterStyle(entityCount: number): string {
	const cards = `  .cards { display: grid; grid-template-columns: repeat(${Math.min(entityCount, 5)}, minmax(200px, 1fr)); gap: 1px; background: var(--line); border: 1px solid var(--line); }`
	return `${BEFORE_CARDS}${cards}\n${AFTER_CARDS}`
}
