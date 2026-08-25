-- AlterTable
ALTER TABLE "employees" ADD COLUMN     "mobileDeviceSequence" INTEGER;

-- AlterTable
ALTER TABLE "tenants" ADD COLUMN     "nextMobileDeviceSequence" INTEGER NOT NULL DEFAULT 1;

-- CreateTable
CREATE TABLE "mobile_document_counters" (
    "tenantId" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "nextNumber" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "mobile_document_counters_pkey" PRIMARY KEY ("tenantId","prefix")
);

-- AddForeignKey
ALTER TABLE "mobile_document_counters" ADD CONSTRAINT "mobile_document_counters_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
