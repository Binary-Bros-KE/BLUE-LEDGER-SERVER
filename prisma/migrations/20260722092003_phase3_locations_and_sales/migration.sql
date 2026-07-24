-- CreateTable
CREATE TABLE "locations" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "locationCode" TEXT NOT NULL,
    "locationName" TEXT NOT NULL,
    "displayName" TEXT,
    "locationType" TEXT NOT NULL,
    "phone" TEXT,
    "alternativePhone" TEXT,
    "email" TEXT,
    "country" TEXT,
    "county" TEXT,
    "city" TEXT,
    "physicalAddress" TEXT,
    "buildingName" TEXT,
    "floorRoom" TEXT,
    "postalAddress" TEXT,
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "googleMapsLink" TEXT,
    "managerName" TEXT,
    "managerPhone" TEXT,
    "managerEmail" TEXT,
    "openingTime" TEXT,
    "closingTime" TEXT,
    "workingDays" TEXT,
    "defaultTaxRate" DOUBLE PRECISION,
    "allowNegativeStock" BOOLEAN NOT NULL,
    "priceLevel" TEXT,
    "isInventoryLocation" BOOLEAN NOT NULL,
    "canReceiveStock" BOOLEAN NOT NULL,
    "canSellStock" BOOLEAN NOT NULL,
    "canTransferStock" BOOLEAN NOT NULL,
    "status" TEXT NOT NULL,
    "description" TEXT,
    "notes" TEXT,
    "receiptHeader" TEXT,
    "receiptFooter" TEXT,
    "localCreatedAt" TIMESTAMP(3) NOT NULL,
    "localUpdatedAt" TIMESTAMP(3) NOT NULL,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "locations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sales" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "receiptNumber" TEXT,
    "locationId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "customerId" TEXT,
    "saleStatus" TEXT NOT NULL,
    "subtotalCents" INTEGER NOT NULL,
    "discountAmountCents" INTEGER NOT NULL,
    "taxAmountCents" INTEGER NOT NULL,
    "grandTotalCents" INTEGER NOT NULL,
    "paymentMethodId" TEXT,
    "paymentReference" TEXT,
    "amountReceivedCents" INTEGER,
    "changeGivenCents" INTEGER,
    "notes" TEXT,
    "completedAt" TIMESTAMP(3),
    "transactionType" TEXT NOT NULL,
    "paymentStatus" TEXT NOT NULL,
    "invoiceNumber" TEXT,
    "invoiceDate" TEXT,
    "dueDate" TEXT,
    "amountPaidCents" INTEGER NOT NULL,
    "balanceDueCents" INTEGER NOT NULL,
    "invoiceNotes" TEXT,
    "payments" JSONB NOT NULL,
    "items" JSONB NOT NULL,
    "serviceCharges" JSONB NOT NULL,
    "delivery" JSONB,
    "localCreatedAt" TIMESTAMP(3) NOT NULL,
    "localUpdatedAt" TIMESTAMP(3) NOT NULL,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sales_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "locations_tenantId_idx" ON "locations"("tenantId");

-- CreateIndex
CREATE INDEX "sales_tenantId_idx" ON "sales"("tenantId");

-- AddForeignKey
ALTER TABLE "locations" ADD CONSTRAINT "locations_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales" ADD CONSTRAINT "sales_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- RowLevelSecurity (hand-added, Prisma has no native support — same pattern as every prior table).
-- ENABLE alone is not enough: the app connects as blueledger_app, which OWNS these tables, and
-- Postgres exempts table owners from RLS by default. FORCE is what actually makes the policy bind
-- against the app's own queries, not just other roles'.
-- current_setting(..., true) is missing_ok=true — see Phase 1's own migration comment for why
-- (fail CLOSED on a missing session var, not with a hard error).
ALTER TABLE "locations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "locations" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "locations"
  USING ("tenantId" = current_setting('app.tenant_id', true));

ALTER TABLE "sales" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sales" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "sales"
  USING ("tenantId" = current_setting('app.tenant_id', true));

-- Corrective fix: Phase 2's products migration enabled RLS but forgot FORCE, so it was silently a
-- no-op for the app's own queries this whole time (confirmed via pg_class.relforcerowsecurity).
-- Can't edit that already-applied migration file without re-triggering the checksum-mismatch dance
-- (same issue hit in Phase 1/2) — fixing it here instead, in a fresh migration.
ALTER TABLE "products" FORCE ROW LEVEL SECURITY;
