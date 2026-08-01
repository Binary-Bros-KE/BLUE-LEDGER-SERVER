-- AlterTable
-- Nullable, no default — most existing customers/suppliers were never asked for this, and there's
-- no safe value to backfill on their behalf (see DESKTOP's matching v50 migration).
ALTER TABLE "customers" ADD COLUMN     "kraPin" TEXT;

-- AlterTable
ALTER TABLE "suppliers" ADD COLUMN     "kraPin" TEXT;
