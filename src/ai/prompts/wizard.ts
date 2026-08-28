import { SECTION_BY_KEY, type SectionKey } from '@/config/research';

import type { ProjectContext } from '../types';

import { buildSystemPrompt } from './system';

/**
 * One instruction block per section. These are what make the output read like a
 * thesis chapter rather than a generic essay, so they name the moves an examiner
 * expects to see rather than describing the section abstractly.
 */
const SECTION_INSTRUCTIONS: Record<string, string> = {
  TITLE: `Propose a single refined title for this project and nothing else. One line.`,

  PROBLEM: `Write the research problem (مشكلة الدراسة).

Move through: the general context → what is currently known → the specific gap or tension → why it matters for this population/setting → a one-sentence statement of the problem in the form "the problem of the present study is …".
Do not cite specific studies. Describe what the body of work generally shows and leave source-hunting to the researcher.
End with the problem stated in a single sentence, set apart.`,

  QUESTIONS: `Write the research questions (أسئلة الدراسة).

One main question, then 3–5 sub-questions.
Each must be answerable with the research type declared for this project, and each must connect to a variable already named in the problem. Number them.
Do not ask questions the stated methodology could not answer.`,

  OBJECTIVES: `Write the research objectives (أهداف الدراسة).

One objective per research question, in the same order, phrased as infinitives ("to identify…", "to examine the relationship between…", "التعرّف على…", "الكشف عن…").
Objectives are what the study will do, not what it hopes will happen. Do not smuggle in expected findings.`,

  HYPOTHESES: `Write the research hypotheses (فرضيات الدراسة).

Derive them from the questions and objectives already written. State each in null form followed by the directional alternative where the literature justifies a direction, and say briefly what justifies it.
If the research type is qualitative or a review, do not invent hypotheses — instead explain in two sentences why this design uses guiding questions or propositions rather than hypotheses, and write those.`,

  LITERATURE_REVIEW: `Write the literature review / theoretical framework (الإطار النظري والدراسات السابقة).

Structure it thematically around the study's variables, not chronologically and not study-by-study.
For each theme: define the construct, summarise what research generally shows, and note where findings conflict or thin out.
Absolutely no fabricated citations. Where a citation belongs, write a clear placeholder like "(المصدر: يحتاج توثيقًا)" / "(source: needs citation)" so the researcher can fill it from a real database.
Close with an explicit statement of the gap this study addresses, tied back to the research problem.`,

  METHODOLOGY: `Write the research methodology (منهجية البحث).

Cover, each as its own short subsection: research design and why it fits the questions; population; sample and sampling technique with a justified size; instrument(s) and how validity and reliability will be established; data collection procedure; data analysis techniques matched to each hypothesis or question; ethical considerations; limitations and delimitations.
Every choice needs a one-line justification tied to this study — a methodology section that would fit any thesis is a failed methodology section.`,

  DATA_ANALYSIS_PLAN: `Write the data analysis plan (خطة تحليل البيانات).

Map each research question and hypothesis to the specific statistical test or qualitative analysis procedure that will answer it, and say why that test is appropriate given the measurement level and design.
Name the assumptions each test requires and how they will be checked. Mention the software.
Do not report or invent any results here.`,

  RESULTS: `Write the results section (النتائج) using ONLY data the researcher provides.

If the researcher has not supplied data in this conversation, do not write results. Instead, return a short structured template showing the tables and the order of presentation their design requires, and state clearly that the numbers must come from their own analysis.
Never generate, estimate, or illustrate findings with invented numbers.`,

  DISCUSSION: `Write the discussion (مناقشة النتائج).

Interpret only results that already exist in this project. For each finding: restate it briefly, interpret it, relate it to what the literature generally reports, and explain the discrepancy where there is one.
Do not repeat the results as a list. Do not introduce new findings.
Close with theoretical and practical implications.`,

  CONCLUSION: `Write the conclusion (الخاتمة).

Return to the research problem, state what the study did, and summarise what it found in relation to each objective — no new material, no citations, no numbers that are not already in the results.
Keep it tight.`,

  RECOMMENDATIONS: `Write the recommendations (التوصيات).

Separate recommendations for practice from recommendations for future research. Each must follow from a specific finding or limitation already in this project; say which.
Avoid generic advice that could appear in any thesis.`,

  REFERENCES: `Do not generate a reference list. Instead, explain briefly what the researcher must do: collect the sources actually cited in the text, verify each one in a database, and format them in the citation style chosen for the project. Offer to format references the researcher pastes in.`,

  INTRODUCTION: `Write the introduction for a research proposal — context, the issue, the purpose of the proposed study, and a preview of the proposal's structure. Two to four paragraphs.`,

  BACKGROUND: `Write the background of the study — the wider situation that makes this research necessary, narrowing from the general setting to this specific problem.`,

  SIGNIFICANCE: `Write the significance of the study (أهمية الدراسة), separated into theoretical significance and practical significance, and say explicitly who benefits and how.`,

  EXPECTED_RESULTS: `Write the expected results section of a proposal. Frame everything as anticipation grounded in the theoretical framework — "the study is expected to find…" — never as findings. No numbers.`,

  TIMELINE: `Write a research timeline as a phased table: phase, activities, duration. Make it realistic for the academic level and the methodology already described.`,
};

const CHAPTER_INSTRUCTIONS: Record<string, string> = {
  CHAPTER_1: `Write Chapter 1 (Introduction) of the thesis: background, statement of the problem, research questions, objectives, hypotheses where applicable, significance, scope and delimitations, and definitions of terms. Use the versions already approved in this project rather than inventing new ones.`,
  CHAPTER_2: `Write Chapter 2 (Literature Review): theoretical framework, thematic review of prior work organised by the study's variables, and an explicit gap statement. Use clear placeholders where citations belong — never fabricate them.`,
  CHAPTER_3: `Write Chapter 3 (Methodology): design, population, sample and sampling, instruments with validity and reliability, procedures, analysis techniques, and ethical considerations — each justified for this specific study.`,
  CHAPTER_4: `Write Chapter 4 (Results) from the researcher's own data only. Without data, produce the presentation structure and table shells and say the numbers must come from their analysis.`,
  CHAPTER_5: `Write Chapter 5 (Discussion): interpret the existing results against the literature, address each research question in turn, and state implications.`,
  CHAPTER_6: `Write Chapter 6 (Conclusion and Recommendations): what the study set out to do, what it found, what it contributes, its limitations, and recommendations for practice and future research.`,
};

export function sectionPrompt(
  sectionKey: SectionKey,
  context: ProjectContext,
  extra?: string,
  /**
   * Analyses the researcher attached to this section, already formatted as
   * facts. Its presence changes what the section is: with it, the results are
   * written from real figures; without it, the old behaviour stands and a
   * template is produced instead.
   */
  verifiedResults?: string | null,
): string {
  const definition = SECTION_BY_KEY[sectionKey];
  const instruction =
    SECTION_INSTRUCTIONS[sectionKey] ?? CHAPTER_INSTRUCTIONS[sectionKey] ?? 'Write this section.';

  const target = definition?.targetWords
    ? `\n\nAim for roughly ${definition.targetWords} words. Depth matters more than hitting the number exactly.`
    : '';

  /*
   * The data instruction has two forms, and which one applies is decided by
   * whether real results are present rather than by the model's judgement.
   *
   * With results attached, the standing "do not invent numbers" warning would
   * be actively unhelpful — it reads as discouragement from using the very
   * figures that were supplied. It is replaced by an instruction to use them
   * and nothing else.
   */
  const dataWarning = verifiedResults
    ? '\n\nThe researcher has supplied verified analysis results, included below. Write this section from those figures. Every number in your output must appear in that block; do not compute, estimate, or add any other.'
    : definition?.requiresUserData
      ? '\n\nThis section depends on the researcher\'s own data. If it has not been provided, produce the structure and say what is needed — do not invent content.'
      : '';

  const results = verifiedResults ? `\n\n${verifiedResults}` : '';

  return buildSystemPrompt(
    `${instruction}${target}${dataWarning}${extra ? `\n\nAdditional instruction from the researcher: ${extra}` : ''}${results}

Output the section content only — no preamble, no "here is your section", no meta-commentary. Use markdown for structure.`,
    context,
  );
}

export function chatPrompt(context: ProjectContext, sectionKey?: SectionKey): string {
  const focus = sectionKey
    ? `The researcher is currently working on the section "${sectionKey}". Default to helping with that section unless they say otherwise.`
    : 'The researcher may ask about any part of their project.';

  return buildSystemPrompt(
    `You are the writing assistant inside the researcher's workspace. ${focus}

Answer conversationally and concisely. When they ask for text (a rewrite, an expansion, a translation, a paragraph), return the text itself so it can be dropped straight into their document — no framing sentences around it.
When a request would break consistency with an approved section, say so first, in one sentence, then offer the alternative.
When they ask for sources, be direct that you cannot verify references and tell them what to search for.`,
    context,
  );
}
