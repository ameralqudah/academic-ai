/**
 * The whole surface the model has onto the statistics engine (P1-C), without
 * importing it: checks (smoke, CI without a database) read this list, and
 * `tools.ts` refuses to load if its tools differ from it. None of these writes
 * a number.
 */
export const STATS_TOOL_NAMES = [
  'createAnalysisSpec',
  'validateAnalysisSpec',
  'runAnalysis',
  'getAnalysisResult',
  'getAnalysisProvenance',
  'generateTableFromResult',
  'generateFigureFromResult',
] as const;
