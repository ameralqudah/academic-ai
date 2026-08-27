import { ok, withApi } from '@/server/http/api';
import * as usersRepo from '@/server/repositories/users.repository';
import { updateSettingsSchema, type UpdateSettingsInput } from '@/server/validation/settings';

export const GET = withApi({}, async ({ user }) => {
  const settings = await usersRepo.ensureSettings(user.id);
  const record = await usersRepo.findById(user.id);
  return ok({ settings, name: record?.name ?? null, email: record?.email ?? '' });
});

export const PATCH = withApi<UpdateSettingsInput>(
  { schema: updateSettingsSchema },
  async ({ user, body }) => {
    await usersRepo.ensureSettings(user.id);

    const { name, locale, ...preferences } = body;

    if (name !== undefined || locale !== undefined) {
      await usersRepo.updateUser(user.id, {
        ...(name === undefined ? {} : { name }),
        ...(locale === undefined ? {} : { locale }),
      });
    }

    if (Object.keys(preferences).length > 0 || locale !== undefined) {
      await usersRepo.updateSettings(user.id, {
        ...preferences,
        ...(locale === undefined ? {} : { preferredLocale: locale }),
      });
    }

    return ok({ updated: true });
  },
);
