import { ok, withApi } from '@/server/http/api';
import { overview } from '@/server/services/admin.service';

export const GET = withApi({ admin: true }, async () => ok(await overview()));
