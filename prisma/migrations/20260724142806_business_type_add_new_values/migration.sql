-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "BusinessType" ADD VALUE 'retail_shop';
ALTER TYPE "BusinessType" ADD VALUE 'wholesale_shop';
ALTER TYPE "BusinessType" ADD VALUE 'retail_and_wholesale';
ALTER TYPE "BusinessType" ADD VALUE 'restaurant';
ALTER TYPE "BusinessType" ADD VALUE 'hotel';
ALTER TYPE "BusinessType" ADD VALUE 'pharmacy';
ALTER TYPE "BusinessType" ADD VALUE 'electronics';
ALTER TYPE "BusinessType" ADD VALUE 'hardware';
ALTER TYPE "BusinessType" ADD VALUE 'general_store';
ALTER TYPE "BusinessType" ADD VALUE 'supermarket';
ALTER TYPE "BusinessType" ADD VALUE 'other';
