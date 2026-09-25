/* ------------------------------------------------------------------------
 * WS2 D2 (approved): what the numeric guard found when a section version was
 * saved. One nullable jsonb column; no default, no backfill, no data change.
 * Versions saved before this read as null (readers fall back to a fresh scan).
 * No RLS change: section_versions has none.
 *
 * Rollback: ALTER TABLE "section_versions" DROP COLUMN "integrity";
 * ---------------------------------------------------------------------- */
ALTER TABLE "section_versions" ADD COLUMN "integrity" jsonb;