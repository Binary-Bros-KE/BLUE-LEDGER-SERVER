-- AlterTable
ALTER TABLE "sales" ADD COLUMN "includeTaxBreakdown" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "quotations" ADD COLUMN "includeTaxBreakdown" BOOLEAN NOT NULL DEFAULT true;
