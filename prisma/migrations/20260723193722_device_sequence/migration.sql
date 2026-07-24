-- AlterTable: add nullable first — existing device rows have no sequence yet, backfilled below.
ALTER TABLE "devices" ADD COLUMN     "sequenceNumber" INTEGER;

-- AlterTable
ALTER TABLE "tenants" ADD COLUMN     "nextDeviceSequence" INTEGER NOT NULL DEFAULT 1;

-- Backfill: number each tenant's existing devices 1, 2, 3... in registration order, so devices
-- that were created before this migration still get a permanent, unique-per-tenant sequence.
UPDATE "devices" d
SET "sequenceNumber" = sub.rn
FROM (
  SELECT "id", ROW_NUMBER() OVER (PARTITION BY "tenantId" ORDER BY "registeredAt") AS rn
  FROM "devices"
) sub
WHERE d."id" = sub."id";

-- Now safe to enforce NOT NULL.
ALTER TABLE "devices" ALTER COLUMN "sequenceNumber" SET NOT NULL;

-- Advance each tenant's counter past whatever was just backfilled, so the NEXT real registration
-- doesn't collide with a number just assigned to existing history.
UPDATE "tenants" t
SET "nextDeviceSequence" = sub.max_seq + 1
FROM (
  SELECT "tenantId", MAX("sequenceNumber") AS max_seq
  FROM "devices"
  GROUP BY "tenantId"
) sub
WHERE t."id" = sub."tenantId";
