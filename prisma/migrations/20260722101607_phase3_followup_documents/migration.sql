-- CreateTable
CREATE TABLE "expense_categories" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "status" TEXT NOT NULL,
    "localCreatedAt" TIMESTAMP(3) NOT NULL,
    "localUpdatedAt" TIMESTAMP(3) NOT NULL,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "expense_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "expenses" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "expenseNumber" TEXT NOT NULL,
    "expenseDate" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "paidBy" TEXT,
    "paymentMethodId" TEXT NOT NULL,
    "storefrontId" TEXT,
    "reference" TEXT,
    "description" TEXT,
    "status" TEXT NOT NULL,
    "isRecurring" BOOLEAN NOT NULL,
    "recurrenceFrequency" TEXT,
    "nextDueDate" TEXT,
    "lastReminderSent" TEXT,
    "localCreatedAt" TIMESTAMP(3) NOT NULL,
    "localUpdatedAt" TIMESTAMP(3) NOT NULL,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "expenses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "salaries" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "payslipNumber" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "payPeriod" TEXT NOT NULL,
    "basicSalaryCents" INTEGER NOT NULL,
    "allowancesCents" INTEGER NOT NULL,
    "deductionsCents" INTEGER NOT NULL,
    "netPayCents" INTEGER NOT NULL,
    "paymentMethodId" TEXT,
    "paymentReference" TEXT,
    "status" TEXT NOT NULL,
    "notes" TEXT,
    "allowancesJson" JSONB NOT NULL,
    "deductionsJson" JSONB NOT NULL,
    "localCreatedAt" TIMESTAMP(3) NOT NULL,
    "localUpdatedAt" TIMESTAMP(3) NOT NULL,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "salaries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recurring_bills" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "categoryId" TEXT,
    "storefrontId" TEXT,
    "amountCents" INTEGER NOT NULL,
    "cycle" TEXT NOT NULL,
    "startDate" TEXT NOT NULL,
    "nextDueDate" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "notes" TEXT,
    "localCreatedAt" TIMESTAMP(3) NOT NULL,
    "localUpdatedAt" TIMESTAMP(3) NOT NULL,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "recurring_bills_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sale_voids" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "saleId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "notes" TEXT,
    "requestedBy" TEXT NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL,
    "approvedBy" TEXT,
    "approvedAt" TIMESTAMP(3),
    "localCreatedAt" TIMESTAMP(3) NOT NULL,
    "localUpdatedAt" TIMESTAMP(3) NOT NULL,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sale_voids_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sale_returns" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "saleId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "notes" TEXT,
    "requestedBy" TEXT NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL,
    "approvedBy" TEXT,
    "approvedAt" TIMESTAMP(3),
    "items" JSONB NOT NULL,
    "localCreatedAt" TIMESTAMP(3) NOT NULL,
    "localUpdatedAt" TIMESTAMP(3) NOT NULL,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sale_returns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quotations" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "quotationNumber" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "subtotalCents" INTEGER NOT NULL,
    "discountAmountCents" INTEGER NOT NULL,
    "taxAmountCents" INTEGER NOT NULL,
    "grandTotalCents" INTEGER NOT NULL,
    "validUntil" TEXT NOT NULL,
    "notes" TEXT,
    "convertedSaleId" TEXT,
    "convertedAt" TIMESTAMP(3),
    "items" JSONB NOT NULL,
    "serviceCharges" JSONB NOT NULL,
    "delivery" JSONB,
    "localCreatedAt" TIMESTAMP(3) NOT NULL,
    "localUpdatedAt" TIMESTAMP(3) NOT NULL,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "quotations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchases" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "purchaseNumber" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "supplierInvoiceNumber" TEXT,
    "locationId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "taxType" TEXT NOT NULL,
    "subtotalCents" INTEGER NOT NULL,
    "discountAmountCents" INTEGER NOT NULL,
    "taxAmountCents" INTEGER NOT NULL,
    "grandTotalCents" INTEGER NOT NULL,
    "paymentMethodId" TEXT,
    "paymentReference" TEXT,
    "paymentStatus" TEXT NOT NULL,
    "amountPaidCents" INTEGER NOT NULL,
    "payments" JSONB NOT NULL,
    "notes" TEXT,
    "orderedAt" TIMESTAMP(3),
    "receivedAt" TIMESTAMP(3),
    "items" JSONB NOT NULL,
    "localCreatedAt" TIMESTAMP(3) NOT NULL,
    "localUpdatedAt" TIMESTAMP(3) NOT NULL,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "purchases_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "expense_categories_tenantId_idx" ON "expense_categories"("tenantId");

-- CreateIndex
CREATE INDEX "expenses_tenantId_idx" ON "expenses"("tenantId");

-- CreateIndex
CREATE INDEX "salaries_tenantId_idx" ON "salaries"("tenantId");

-- CreateIndex
CREATE INDEX "recurring_bills_tenantId_idx" ON "recurring_bills"("tenantId");

-- CreateIndex
CREATE INDEX "sale_voids_tenantId_idx" ON "sale_voids"("tenantId");

-- CreateIndex
CREATE INDEX "sale_returns_tenantId_idx" ON "sale_returns"("tenantId");

-- CreateIndex
CREATE INDEX "quotations_tenantId_idx" ON "quotations"("tenantId");

-- CreateIndex
CREATE INDEX "purchases_tenantId_idx" ON "purchases"("tenantId");

-- AddForeignKey
ALTER TABLE "expense_categories" ADD CONSTRAINT "expense_categories_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "salaries" ADD CONSTRAINT "salaries_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recurring_bills" ADD CONSTRAINT "recurring_bills_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_voids" ADD CONSTRAINT "sale_voids_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_returns" ADD CONSTRAINT "sale_returns_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotations" ADD CONSTRAINT "quotations_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- RowLevelSecurity (hand-added, Prisma has no native support). Checklist for every table, learned
-- the hard way twice already: ENABLE + FORCE (the app connects as blueledger_app, which OWNS these
-- tables — Postgres exempts owners from RLS unless FORCE is also set) + current_setting's
-- missing_ok=true second argument (fails CLOSED — zero rows — for a query outside
-- withTenantContext, instead of a hard error).
ALTER TABLE "expense_categories" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "expense_categories" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "expense_categories"
  USING ("tenantId" = current_setting('app.tenant_id', true));

ALTER TABLE "expenses" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "expenses" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "expenses"
  USING ("tenantId" = current_setting('app.tenant_id', true));

ALTER TABLE "salaries" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "salaries" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "salaries"
  USING ("tenantId" = current_setting('app.tenant_id', true));

ALTER TABLE "recurring_bills" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "recurring_bills" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "recurring_bills"
  USING ("tenantId" = current_setting('app.tenant_id', true));

ALTER TABLE "sale_voids" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sale_voids" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "sale_voids"
  USING ("tenantId" = current_setting('app.tenant_id', true));

ALTER TABLE "sale_returns" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sale_returns" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "sale_returns"
  USING ("tenantId" = current_setting('app.tenant_id', true));

ALTER TABLE "quotations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "quotations" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "quotations"
  USING ("tenantId" = current_setting('app.tenant_id', true));

ALTER TABLE "purchases" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "purchases" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "purchases"
  USING ("tenantId" = current_setting('app.tenant_id', true));
