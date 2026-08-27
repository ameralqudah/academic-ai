import { ok, withApi } from '@/server/http/api';
import { runTool } from '@/server/services/tool.service';
import { toolRunSchema, type ToolRunInput } from '@/server/validation/ai';

export const maxDuration = 60;

export const POST = withApi<ToolRunInput>(
  {
    schema: toolRunSchema,
    rateLimit: { key: 'ai-tool', max: 40, windowSeconds: 300 },
  },
  async ({ user, body }) => {
    const result = await runTool({
      userId: user.id,
      toolKey: body.toolKey,
      text: body.input,
      options: body.options,
      projectId: body.projectId,
    });
    return ok(result);
  },
);
