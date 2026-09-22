/**
 * Reading a request for a diagram: whether it is one, and which kind.
 *
 * Pure, so routing and the handler agree and both can be tested without a
 * model. Lexical on purpose, like the format words: "رسمة" names a drawing in
 * every dialect that uses it, and a model call to establish that would be a
 * call spent on nothing.
 */

import type { DiagramKind, DiagramSpec } from './spec';

const DRAW = new RegExp(
  [
    String.raw`\b(?:diagram|draw|drawing|figure|framework|conceptual\s+model|research\s+model|path\s+model|measurement\s+model|structural\s+model|outer\s+model|inner\s+model|model\s+diagram)\b`,
    String.raw`(?<![\p{L}\p{N}])(?:ارسم|أرسم|ارسملي|رسم|رسمة|رسمه|الرسمة|الرسمه|مخطط|المخطط|شكل\s*النموذج|نموذج\s*الدراسة|نموذج\s*الدراسه|النموذج\s*المفاهيمي|الإطار\s*المفاهيمي|الاطار\s*المفاهيمي|نموذج\s*القياس|النموذج\s*الهيكلي|النموذج\s*البنائي|فريم\s*ورك|مودل)`,
  ].join('|'),
  'iu',
);

/*
 * Drawings this capability does not make. A chart of data is an analysis
 * output, and a picture of a landscape is not research; routing either here
 * would produce a model diagram nobody asked for.
 */
const NOT_A_MODEL = new RegExp(
  String.raw`\b(?:chart|bar\s+chart|pie|histogram|scatter|plot|photo|portrait|logo)\b|رسم\s*بياني|رسوم\s*بيانية|أعمدة|دائري|مدرج|صورة\s*شخصية|شعار|لوحة\s*فنية`,
  'iu',
);

/** Whether a message asks for a research-model diagram. */
export function asksForDiagram(message: string): boolean {
  return DRAW.test(message) && !NOT_A_MODEL.test(message);
}

/** Which of the three diagrams is meant, from the words used. */
export function diagramKindOf(message: string): DiagramKind {
  if (/\bmeasurement\b|\bouter\s+model\b|قياس|الفقرات|فقرات|المؤشرات|indicators|items/iu.test(message)) {
    return 'measurement';
  }
  if (/\bstructural\b|\binner\s+model\b|\bpath\s+(?:model|diagram)\b|الهيكلي|البنائي|المسارات|معاملات\s*المسار/iu.test(message)) {
    return 'structural';
  }
  return 'conceptual';
}

/** A title, when the model gave none. */
export function defaultTitle(kind: DiagramKind, language: 'ar' | 'en'): string {
  const titles: Record<DiagramKind, Record<'ar' | 'en', string>> = {
    conceptual: { ar: 'النموذج المفاهيمي للدراسة', en: 'Conceptual Model' },
    measurement: { ar: 'نموذج القياس', en: 'Measurement Model' },
    structural: { ar: 'النموذج الهيكلي', en: 'Structural Model' },
  };
  return titles[kind][language];
}

/**
 * The PLS model that was actually estimated, as a diagram with its figures.
 *
 * When a PLS analysis ran in the same task, its model is the model — there is
 * nothing for a language model to extract, and every number on the figure
 * comes from the estimate. p-values are not drawn: they need bootstrapping,
 * which runs separately, and a β without its test must not look like one with.
 */
export function specFromPls(
  estimates: {
    constructs: { name: string; indicators: string[]; mode: 'reflective' | 'formative' }[];
    paths: { from: string; to: string; coefficient: number }[];
    rSquared: { construct: string; rSquared: number }[];
    loadings: { construct: string; indicator: string; loading: number }[];
    n: number;
  },
  kind: DiagramKind,
  language: 'ar' | 'en',
): DiagramSpec {
  const incoming = new Set(estimates.paths.map((path) => path.to));
  const outgoing = new Set(estimates.paths.map((path) => path.from));

  return {
    kind: kind === 'conceptual' ? 'structural' : kind,
    title: defaultTitle(kind === 'conceptual' ? 'structural' : kind, language),
    language,
    constructs: estimates.constructs.map((construct) => ({
      id: construct.name,
      name: construct.name,
      role:
        incoming.has(construct.name) && outgoing.has(construct.name)
          ? 'mediator'
          : incoming.has(construct.name)
            ? 'dependent'
            : 'independent',
      dimensions: [],
      indicators: construct.indicators.slice(0, 10),
      mode: construct.mode,
    })),
    paths: estimates.paths.map((path) => ({ from: path.from, to: path.to })),
    moderations: [],
    values: {
      paths: estimates.paths.map((path) => ({ from: path.from, to: path.to, beta: path.coefficient })),
      rSquared: Object.fromEntries(estimates.rSquared.map((entry) => [entry.construct, entry.rSquared])),
      loadings: estimates.loadings,
      source:
        language === 'ar'
          ? `القيم من تحليل PLS-SEM الذي أُجري على بياناتك (ن = ${estimates.n})، دون اختبار الدلالة (يتطلب Bootstrapping).`
          : `Values from the PLS-SEM analysis of your data (n = ${estimates.n}); significance needs bootstrapping and is not shown.`,
    },
    notes: [],
  };
}
