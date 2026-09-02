import { ok, withApi } from '@/server/http/api';
import { deleteArtifact, readArtifact } from '@/server/services/artifact.service';

type Params = { id: string };

/** The file itself, as a download. */
export const GET = withApi<undefined, Params>(
  { rateLimit: { max: 100, windowSeconds: 300, key: 'artifact.download' } },
  async ({ user, params }) => {
    const { artifact, bytes, contentType } = await readArtifact(params.id, user.id);

    return new Response(bytes as BodyInit, {
      headers: {
        'content-type': contentType,
        /*
         * The version is in the download name, so a researcher with four
         * exports in their downloads folder can tell them apart without
         * opening each one.
         */
        'content-disposition': `attachment; filename="${encodeURIComponent(
          `${artifact.filename.replace(/\.[^.]+$/, '')}-v${artifact.version}.${artifact.kind}`,
        )}"`,
        'content-length': String(bytes.length),
      },
    });
  },
);

export const DELETE = withApi<undefined, Params>({}, async ({ user, params }) => {
  await deleteArtifact(params.id, user.id);
  return ok({ deleted: true });
});
