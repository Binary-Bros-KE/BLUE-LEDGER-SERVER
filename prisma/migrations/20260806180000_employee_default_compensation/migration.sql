-- AlterTable
-- Nullable — no backfill needed for existing employee rows. DESKTOP's own SQLite side keeps the
-- JSON columns NOT NULL DEFAULT '[]' and always pushes a real array (never an explicit null), so
-- these only stay null here until an existing employee row is next synced.
ALTER TABLE "employees" ADD COLUMN "defaultBasicSalaryCents" INTEGER;
ALTER TABLE "employees" ADD COLUMN "defaultAllowancesJson" JSONB;
ALTER TABLE "employees" ADD COLUMN "defaultDeductionsJson" JSONB;
