-- CreateTable
CREATE TABLE "stock_requests" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "requestNumber" TEXT NOT NULL,
    "storefrontId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "notes" TEXT,
    "rejectionReason" TEXT,
    "requestedBy" TEXT NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL,
    "reviewedBy" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "items" JSONB NOT NULL,
    "localCreatedAt" TIMESTAMP(3) NOT NULL,
    "localUpdatedAt" TIMESTAMP(3) NOT NULL,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "stock_requests_tenantId_idx" ON "stock_requests"("tenantId");

-- AddForeignKey
ALTER TABLE "stock_requests" ADD CONSTRAINT "stock_requests_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Row-Level Security — ENABLE + FORCE (the app connects as the table-owning role, which Postgres
-- exempts from RLS by default) + current_setting's missing_ok=true (so a query outside
-- withTenantContext fails closed with zero rows instead of hard-erroring).
ALTER TABLE "stock_requests" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "stock_requests" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "stock_requests"
  USING ("tenantId" = current_setting('app.tenant_id', true));
