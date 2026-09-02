-- "Borrow & Lend" — physical stock moving between a tenant and another shop (represented by the
-- existing Supplier model). Same header+items+append-only-events shape as "purchases".
CREATE TABLE "borrows" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "borrowNumber" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "notes" TEXT,
    "returnEvents" JSONB NOT NULL DEFAULT '[]',
    "items" JSONB NOT NULL,
    "localCreatedAt" TIMESTAMP(3) NOT NULL,
    "localUpdatedAt" TIMESTAMP(3) NOT NULL,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "borrows_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "borrows_tenantId_idx" ON "borrows"("tenantId");

-- AddForeignKey
ALTER TABLE "borrows" ADD CONSTRAINT "borrows_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "borrows" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "borrows" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "borrows"
  USING ("tenantId" = current_setting('app.tenant_id', true));
