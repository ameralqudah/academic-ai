/**
 * The structure of a research model, read from the conversation by a model.
 *
 * The model is asked for structure and nothing else — constructs, roles,
 * paths, labels — and told the conversation is where the model lives. The
 * researcher who asked "draw it" had described their variables three messages
 * earlier; asking them again, or drawing a model they never proposed, are the
 * two failures this has to avoid.
 */

import { z } from 'zod';

import { gateway, GatewayError, toAppError } from '@/server/ai/gateway';
import { requirementsFor } from '@/server/ai/model-router';
import { currentPreferredModel } from '@/server/ai/request-scope';
import { buildContextPrompt } from '@/server/context/manager';
import { logger } from '@/lib/logger';

import { parseSpec, type DiagramKind, type DiagramSpec } from './spec';

export function extractionPrompt(kind: DiagramKind, language: 'ar' | 'en'): string {
  return `You read a researcher's conversation and return the structure of the research model they want drawn. You do not draw, and you do not answer in prose.

Return JSON only:
{
  "kind": "conceptual" | "measurement" | "structural",
  "title": "<a short figure title, in ${language === 'ar' ? 'Arabic' : 'English'}>",
  "language": "${language}",
  "constructs": [
    {"id": "<short id>", "name": "<variable name as the researcher uses it>", "role": "independent" | "mediator" | "moderator" | "dependent" | "control",
     "dimensions": ["<sub-dimension>", ...], "indicators": ["<item code or item>", ...], "mode": "reflective" | "formative"}
  ],
  "paths": [{"from": "<id>", "to": "<id>", "hypothesis": "H1"}],
  "moderations": [{"moderator": "<id>", "from": "<id>", "to": "<id>", "hypothesis": "H3"}]
}

Rules:
1. The model is the one in the conversation. Take the variables, dimensions and relations the researcher and the assistant already set out. Do not add variables that were not discussed, and do not drop ones that were.
2. If the conversation contains no research model at all — no variables — return {"constructs": []}. Do not invent one.
3. The kind asked for is "${kind}" unless the request clearly says otherwise.
4. Every independent variable has a path to what it affects. A mediator has paths in and out. A moderator appears in "moderations", on the path it moderates, not in "paths".
5. Number hypotheses H1, H2, … in the order the conversation gives them, or in path order if it gives none.
6. Indicators only if the conversation names items or item codes; otherwise leave them empty.
7. NO NUMBERS. No coefficients, loadings, R², p-values or sample sizes, whatever the conversation contains. Figures on a diagram come from an analysis, not from you.
8. Names in ${language === 'ar' ? 'Arabic' : 'English'}, short enough for a box.`;
}

export async function extractDiagramSpec(input: {
  userId: string;
  request: string;
  kind: DiagramKind;
  language: 'ar' | 'en';
  conversationId?: string | null;
  taskId?: string | null;
}): Promise<{ spec: DiagramSpec } | { missing: 'constructs' | 'paths' }> {
  let context = '';

  try {
    context = (
      await buildContextPrompt({
        purpose: 'answer',
        request: input.request,
        userId: input.userId,
        conversationId: input.conversationId ?? null,
        taskId: input.taskId ?? null,
        locale: input.language,
      })
    ).prompt;
  } catch (error) {
    logger.warn('diagram.contextFailed', { error: String(error).slice(0, 200) });
  }

  /*
   * Native structured output through the Model Gateway (P1-B): the reply is a
   * JSON object by construction, and `parseSpec` then checks what it means.
   * A reply that is not an object leaves `raw` null, exactly as before.
   */
  const requirements = requirementsFor({ capability: 'diagram.draw' });
  let raw: unknown = null;
  try {
    const { data } = await gateway().generateStructured(
      {
        purpose: 'diagram.extract',
        system: [extractionPrompt(input.kind, input.language), context].filter(Boolean).join('\n\n'),
        messages: [{ role: 'user', content: input.request }],
        maxOutputTokens: 2000,
        temperature: 0,
        needsReasoning: requirements.needsReasoning,
        latencySensitive: requirements.latencySensitive,
        requested: currentPreferredModel(),
      },
      z.record(z.string(), z.unknown()),
      { name: 'diagram' },
    );
    raw = data;
  } catch (error) {
    if (!(error instanceof GatewayError)) throw error;
    if (error.errorClass !== 'schema_validation') throw toAppError(error);
  }

  return parseSpec(raw, { kind: input.kind, language: input.language });
}
