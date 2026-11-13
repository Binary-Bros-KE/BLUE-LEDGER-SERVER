-- Optional company a customer belongs to (DESKTOP migration 114).
ALTER TABLE "customers" ADD COLUMN "companyName" TEXT;
