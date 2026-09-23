/**
 * Whether a request asks for figures of the data.
 *
 * Shared by the router, the analysis and the diagram rules: "ارسم رسمات
 * بيانية" is a chart of the numbers, not the research model, and the model
 * diagram must not answer it.
 */

/* The start of a word, in any script: \b does not see Arabic letters. */
const START = String.raw`(?<![\p{L}\p{N}])`;

const CHARTS = new RegExp(
  [
    String.raw`\b(?:chart|charts|graph|graphs|histogram|bar\s+chart|pie\s+chart|plot|plots|figure|figures|visuali[sz]e|visuali[sz]ation)\b`,
    `${START}(?:رسم\\s*بياني|رسوم\\s*بيانية|رسومات|رسمات|مخططات|هيستوغرام|هستوغرام|هيستوجرام|مدرج\\s*تكراري|صندوقي|أعمدة|اعمدة|مدرج|دائري|بياني|بيانية|بيانيه)`,
  ].join('|'),
  'iu',
);

/** Whether a message asks for figures of the data, not a model diagram. */
export function asksForCharts(message: string): boolean {
  return CHARTS.test(message);
}
