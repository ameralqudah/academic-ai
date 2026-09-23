/**
 * Model Gateway adapters against the real provider APIs (P1-B). Manual only:
 * it spends money and needs real keys, so it is never part of CI.
 *
 *   GATEWAY_LIVE=1 ANTHROPIC_API_KEY=… OPENAI_API_KEY=… GOOGLE_AI_API_KEY=… npm run test:gateway:live
 *
 * For each provider with a usable key: a text generation, a stream, native
 * structured output and a forced native tool call, each checked against the
 * normalised contract. Keys are read from the environment and never printed.
 */

import 'dotenv/config';

import { z } from 'zod';

import { getEnv } from '@/config/env';
import { AnthropicAdapter } from '@/server/ai/gateway/adapters/anthropic';
import { GoogleAdapter } from '@/server/ai/gateway/adapters/google';
import { OpenAIAdapter } from '@/server/ai/gateway/adapters/openai';
import type { ProviderAdapter } from '@/server/ai/gateway/adapters/types';
import { requestSchema } from '@/server/ai/gateway/contract';
import { redact } from '@/server/ai/gateway/errors';
import { defineTool } from '@/server/ai/gateway/tools';

if (process.env.GATEWAY_LIVE !== '1') {
  console.log('Skipped: set GATEWAY_LIVE=1 (and real provider keys) to run the live adapter checks.');
  process.exit(0);
}

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) passed += 1;
  else failed += 1;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${ok || !detail ? '' : ` — ${redact(detail)}`}`);
}

async function main() {
  const env = getEnv();
  const targets: { adapter: ProviderAdapter; model: string }[] = [
    { adapter: new AnthropicAdapter(env.ANTHROPIC_API_KEY ?? ''), model: env.ANTHROPIC_MODEL },
    { adapter: new OpenAIAdapter(env.OPENAI_API_KEY ?? ''), model: env.OPENAI_MODEL },
    { adapter: new GoogleAdapter(env.GOOGLE_AI_API_KEY ?? ''), model: env.GOOGLE_MODEL },
  ];
  const signal = () => AbortSignal.timeout(60_000);
  const request = (text: string) =>
    requestSchema.parse({ purpose: 'live-check', messages: [{ role: 'user', content: text }], maxOutputTokens: 200, reasoning: false });

  const answer = z.object({ city: z.string(), country: z.string() });
  const weather = defineTool('get_weather', 'Weather for a city.', z.object({ city: z.string() }));

  for (const { adapter, model } of targets) {
    if (!adapter.configured()) {
      console.log(`\n${adapter.provider}: no usable key, skipped`);
      continue;
    }
    console.log(`\n${adapter.provider} (${model})`);
    const attempt = async (name: string, work: () => Promise<boolean>) => {
      try {
        check(name, await work());
      } catch (error) {
        check(name, false, error instanceof Error ? error.message : String(error));
      }
    };

    await attempt('text generation with usage', async () => {
      const result = await adapter.send({ request: request('Reply with the single word: ready'), model, signal: signal() });
      return /ready/i.test(result.text) && result.usage.inputTokens > 0 && result.usage.outputTokens > 0;
    });

    await attempt('stream ends with a final result', async () => {
      let text = '';
      let final = false;
      for await (const event of adapter.stream({ request: request('Count from 1 to 5.'), model, signal: signal() })) {
        if (event.type === 'text') text += event.text;
        else final = event.result.text.length > 0;
      }
      return text.length > 0 && final;
    });

    await attempt('native structured output parses against the schema', async () => {
      const result = await adapter.send({
        request: request('Which city is the Eiffel Tower in? Answer as JSON.'),
        model,
        responseSchema: { name: 'answer', schema: z.toJSONSchema(answer) as Record<string, unknown> },
        signal: signal(),
      });
      return answer.safeParse(JSON.parse(result.text)).success;
    });

    await attempt('a forced native tool call with valid arguments', async () => {
      const result = await adapter.send({
        request: request('What is the weather in Amman?'),
        model,
        tools: [weather],
        toolChoice: { name: 'get_weather' },
        signal: signal(),
      });
      const call = result.toolCalls[0];
      return call?.name === 'get_weather' && weather.validate.safeParse(call.arguments).success;
    });
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(redact(String(error)));
  process.exit(1);
});
