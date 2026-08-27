import type { ToolKey } from '@/config/research';

import type { ProjectContext } from '../types';

import { ACADEMIC_RULES, formatContext } from './system';

const REWRITE_STYLES: Record<string, string> = {
  moreAcademic:
    'Raise the register: precise terminology, hedged claims, formal connectives, no first-person narration.',
  moreNatural:
    'Keep it academic but make it read like a person wrote it: vary sentence length, cut nominalisations, remove stacked prepositional phrases.',
  simpleAcademic:
    'Keep the academic register but simplify: shorter sentences, plainer vocabulary, one idea per sentence. Suitable for an undergraduate reader.',
  formalAcademic:
    'Maximum formality, suitable for a doctoral dissertation or a journal submission: dense, precise, impersonal.',
};

const TRANSLATION_DIRECTIONS: Record<string, string> = {
  arToEn:
    'Translate from Arabic into English. The result must read as English academic prose written by a native academic — not as translated Arabic. Restructure sentences where English convention requires it.',
  enToAr:
    'Translate from English into Arabic. The result must read as genuine academic Arabic — correct terminology, formal register, natural word order — not as a literal rendering of English syntax.',
};

const CITATION_STYLES: Record<string, string> = {
  APA7: 'APA 7th edition',
  HARVARD: 'Harvard',
  MLA: 'MLA 9th edition',
  CHICAGO: 'Chicago (author–date)',
};

const TOOL_INSTRUCTIONS: Record<ToolKey, (options: Record<string, string>) => string> = {
  rewriter: (options) => `Rewrite the text the researcher gives you.

${REWRITE_STYLES[options.style ?? 'moreAcademic'] ?? REWRITE_STYLES.moreAcademic}

Preserve the meaning exactly. Do not add claims, examples, or citations that are not in the original. Do not remove a hedge that was there.
Return the rewritten text only — no preamble, no explanation of what you changed.`,

  summarizer: () => `Summarise the study or text the researcher gives you.

Structure the summary as:
- **الهدف / Purpose** — what the study set out to do
- **المنهج / Method** — design, participants, instruments, analysis, as far as the text states them
- **أبرز النتائج / Key findings** — only findings stated in the text
- **الحدود / Limitations** — as stated, plus any obvious ones the text implies
- **الصلة ببحثك / Relevance** — two sentences on how it connects to this researcher's project

If the text does not state something, write "غير مذكور" / "not stated". Never fill a gap with a plausible guess.`,

  questionGenerator: () => `Generate research questions from the problem statement the researcher gives you.

Produce one main question and 4–6 sub-questions. Each must be answerable with the project's declared research type, and each must name the variables it involves.
After the list, add one short paragraph flagging any question that would be difficult to answer at this academic level, and why.`,

  hypothesisGenerator: () => `Derive testable hypotheses from the questions or variables the researcher gives you.

For each: state the null hypothesis, then the alternative, then one sentence on what would justify the direction.
Number them so they map onto the research questions.
If the project's research type is qualitative or a review, say plainly that hypotheses are not appropriate and offer guiding propositions instead.`,

  gapFinder: () => `Help the researcher locate a genuine research gap.

Work from what they give you. Identify: what the existing work they describe has established; what it has assumed without testing; which populations, settings, time periods, or variables are missing; and which methodological approaches have not been tried.
Then propose 3–5 candidate gaps, each with a one-line statement of the study it implies and an honest note on whether it is a real gap or merely an under-reported one.
Do not cite specific studies. Point the researcher at what to search for instead.`,

  methodologyAssistant: () => `Propose a research methodology for what the researcher describes.

Cover each of these as its own labelled part: research design; population; sample size with a justification; sampling technique; data collection instrument and how validity and reliability will be established; data collection procedure; statistical or qualitative analysis techniques mapped to each question; ethical considerations.
Every choice needs a justification tied to this study. Offer an alternative where a reasonable examiner might expect one.`,

  translator: (options) => `${TRANSLATION_DIRECTIONS[options.direction ?? 'arToEn'] ?? TRANSLATION_DIRECTIONS.arToEn}

Preserve technical terminology and keep any citations, numbers and proper nouns exactly as they are.
Return the translation only.`,

  citationAssistant: (options) => `Format the reference details the researcher gives you in ${CITATION_STYLES[options.style ?? 'APA7'] ?? CITATION_STYLES.APA7} style.

CRITICAL: format only what they supply. If a required element is missing (year, journal, volume, pages, publisher, DOI), leave a clearly marked placeholder such as [الناشر مفقود] / [publisher missing] — never guess it, never look it up from memory, never invent a DOI.
After the formatted list, add one line telling the researcher that every entry must be verified against the actual source before submission.
Also provide the matching in-text citation form for each entry.`,
};

export function toolPrompt(
  toolKey: ToolKey,
  options: Record<string, string>,
  context: ProjectContext | null,
): string {
  const instruction = TOOL_INSTRUCTIONS[toolKey](options);

  const contextBlock = context
    ? ['', '=== PROJECT CONTEXT ===', formatContext(context)].join('\n')
    : '\n(The researcher is using this tool outside a project. Work only from the text they give you.)';

  return [ACADEMIC_RULES, contextBlock, '', '=== YOUR TASK ===', instruction].join('\n');
}
