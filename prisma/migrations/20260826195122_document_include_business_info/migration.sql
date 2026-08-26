-- AlterTable
ALTER TABLE "sales" ADD COLUMN "includeBusinessInfo" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "quotations" ADD COLUMN "includeBusinessInfo" BOOLEAN NOT NULL DEFAULT true;
