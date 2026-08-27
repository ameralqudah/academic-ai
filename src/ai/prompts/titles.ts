import type { ProjectContext } from '../types';

import { buildSystemPrompt } from './system';

export const TITLE_SCHEMA_HINT = `Return JSON only, with this exact shape:
{
  "titles": [
    {
      "title": "the research title, in the project language",
      "rationale": "2-3 sentences: why this title suits this researcher's field, level and problem area",
      "researchProblem": "the research problem this title implies, in 1-2 sentences",
      "variables": ["independent variable", "dependent variable", "moderator if any"],
      "fitScore": 0-100,
      "innovationScore": 0-100
    }
  ]
}`;

export function titleGenerationPrompt(context: ProjectContext, count = 10): string {
  return buildSystemPrompt(
    `Generate exactly ${count} distinct research titles for this researcher.

Requirements for the set as a whole:
- Cover genuinely different angles, not ${count} rewordings of one idea. Vary the unit of analysis, the relationship being studied, the population, and the methodological approach where the research type allows.
- Every title must be researchable at this academic level within a normal timeframe. Reject topics that would need data no student could obtain.
- Titles must be specific enough that the research problem is visible from the title alone.

Requirements for each title:
- Follow the naming conventions of the field. In Arabic, use standard academic title phrasing (e.g. "أثر … في … لدى …", "درجة … من وجهة نظر …", "واقع … وعلاقته بـ …") rather than translated English syntax.
- fitScore measures how well the title matches the stated field, specialisation, degree and research type.
- innovationScore measures how far it goes beyond what is already heavily studied. Be honest — a conventional topic should score low, and say why in the rationale.
- variables must be the actual constructs, not placeholders. For qualitative or review work, list the central concepts instead.

${TITLE_SCHEMA_HINT}`,
    context,
  );
}

export function titleImprovementPrompt(context: ProjectContext): string {
  return buildSystemPrompt(
    `The researcher wants one title improved. Produce three improved variants of the title they give you.

For each variant explain what you changed and why: sharper variables, clearer population, tighter scope, better fit to the research type, or more standard academic phrasing for the field. Keep the researcher's core idea — do not substitute a different topic.

${TITLE_SCHEMA_HINT.replace('"titles": [', '"titles": [ /* exactly 3 variants */')}`,
    context,
  );
}

export function titleComparisonPrompt(context: ProjectContext): string {
  return buildSystemPrompt(
    `The researcher will give you several candidate titles. Compare them and recommend one.

Return JSON only:
{
  "comparison": [
    {
      "title": "the candidate title, copied exactly",
      "strengths": ["…"],
      "weaknesses": ["…"],
      "feasibility": "one sentence on data access, sample and timeframe at this academic level",
      "score": 0-100
    }
  ],
  "recommendation": {
    "title": "the title you recommend, copied exactly",
    "reason": "2-3 sentences explaining the choice against the alternatives"
  }
}

Be decisive and be critical. A comparison where every candidate scores similarly is useless to the researcher.`,
    context,
  );
}
