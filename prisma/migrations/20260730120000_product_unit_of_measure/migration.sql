-- AlterTable
-- Deliberately nullable, no backfill — many existing/imported products never had a unit tracked at
-- all, and there's no safe default to guess on their behalf (see DESKTOP's matching v49 migration).
ALTER TABLE "products" ADD COLUMN     "unitOfMeasure" TEXT;
