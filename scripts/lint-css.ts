/**
 * The CSS half of the community-plugin store scan, which `eslint-plugin-obsidianmd`
 * does not cover: `styles.css` may carry no `!important` and no `:has()`. The
 * store's checker is not published, so this mirrors the two rules it reported
 * against 0.3.0 rather than all of it. `bun run lint:scanner` runs it after the
 * TypeScript replica; a hit fails the gate.
 *
 * Comments may talk about the rules; only selectors and declarations count.
 * Each comment is blanked to the newlines it spanned, so line numbers stay true.
 */
import { readFileSync } from "node:fs";

const RULES: Array<{ re: RegExp; msg: string }> = [
  { re: /!important/, msg: "Avoid !important — override styles by increasing selector specificity or using CSS variables instead." },
  { re: /:has\(/, msg: "Avoid :has — it can cause significant performance issues due to broad selector invalidation." },
];

const file = process.argv[2] ?? "styles.css";
const text = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ""));
let hits = 0;
text.split("\n").forEach((line, i) => {
  for (const r of RULES) {
    if (!r.re.test(line)) continue;
    hits++;
    console.error(`${file}:${i + 1}: ${r.msg}`);
  }
});
if (hits > 0) {
  console.error(`\n${hits} CSS problem${hits === 1 ? "" : "s"} the store scanner would report.`);
  process.exit(1);
}
console.log(`${file}: no !important, no :has()`);
