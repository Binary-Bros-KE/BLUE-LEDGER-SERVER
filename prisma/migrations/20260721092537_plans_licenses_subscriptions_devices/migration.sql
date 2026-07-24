/*
  Warnings:

  - You are about to drop the column `isSuspended` on the `tenants` table. All the data in the column will be lost.
  - You are about to drop the column `licenseKey` on the `tenants` table. All the data in the column will be lost.
  - You are about to drop the column `maxBranches` on the `tenants` table. All the data in the column will be lost.
  - You are about to drop the column `maxDevices` on the `tenants` table. All the data in the column will be lost.
  - You are about to drop the column `maxUsers` on the `tenants` table. All the data in the column will be lost.
  - You are about to drop the column `subscriptionEndsAt` on the `tenants` table. All the data in the column will be lost.
  - You are about to drop the column `subscriptionPlan` on the `tenants` table. All the data in the column will be lost.
  - You are about to drop the column `subscriptionStatus` on the `tenants` table. All the data in the column will be lost.
  - You are about to drop the column `trialEndsAt` on the `tenants` table. All the data in the column will be lost.

*/
-- CreateEnum
CREATE TYPE "LicenseStatus" AS ENUM ('TRIAL', 'ACTIVE', 'SUSPENDED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "SuspensionReason" AS ENUM ('PAYMENT_OVERDUE', 'FRAUD', 'MANUAL', 'CUSTOMER_REQUESTED');

-- CreateEnum
CREATE TYPE "SubscriptionType" AS ENUM ('MONTHLY', 'LIFETIME', 'CUSTOM');

-- CreateEnum
CREATE TYPE "BillingCycle" AS ENUM ('MONTHLY', 'YEARLY', 'ONCE');

-- CreateEnum
CREATE TYPE "SubscriptionBillingStatus" AS ENUM ('ACTIVE', 'PAST_DUE', 'CANCELLED');

-- CreateEnum
CREATE TYPE "SupportStatus" AS ENUM ('ACTIVE', 'EXPIRED', 'LIFETIME');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('PAID', 'PENDING', 'FAILED');

-- CreateEnum
CREATE TYPE "DeviceType" AS ENUM ('DESKTOP', 'LAPTOP');

-- CreateEnum
CREATE TYPE "DeviceStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'REVOKED');

-- CreateEnum
CREATE TYPE "BusinessType" AS ENUM ('RETAIL', 'WHOLESALE', 'RETAIL_AND_WHOLESALE', 'HARDWARE', 'PHARMACY', 'SUPERMARKET', 'ELECTRONICS', 'BOOKSHOP', 'OTHER');

-- CreateEnum
CREATE TYPE "Currency" AS ENUM ('KES', 'UGX', 'TZS', 'USD');

-- CreateEnum
CREATE TYPE "PlanStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- DropIndex
DROP INDEX "tenants_licenseKey_key";

-- AlterTable
ALTER TABLE "tenants" DROP COLUMN "isSuspended",
DROP COLUMN "licenseKey",
DROP COLUMN "maxBranches",
DROP COLUMN "maxDevices",
DROP COLUMN "maxUsers",
DROP COLUMN "subscriptionEndsAt",
DROP COLUMN "subscriptionPlan",
DROP COLUMN "subscriptionStatus",
DROP COLUMN "trialEndsAt",
ADD COLUMN     "businessType" "BusinessType" NOT NULL DEFAULT 'OTHER',
ADD COLUMN     "currency" "Currency" NOT NULL DEFAULT 'KES',
ADD COLUMN     "lastCloudSync" TIMESTAMP(3),
ADD COLUMN     "pendingSyncRecords" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "storefrontCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "timezone" TEXT NOT NULL DEFAULT 'Africa/Nairobi';

-- DropEnum
DROP TYPE "SubscriptionPlan";

-- DropEnum
DROP TYPE "SubscriptionStatus";

-- CreateTable
CREATE TABLE "plans" (
    "id" TEXT NOT NULL,
    "outletId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "monthlyPriceCents" INTEGER,
    "purchasePriceCents" INTEGER,
    "annualMaintenanceCents" INTEGER,
    "maxBranches" INTEGER NOT NULL DEFAULT 1,
    "maxUsers" INTEGER NOT NULL DEFAULT 3,
    "maxDevices" INTEGER NOT NULL DEFAULT 1,
    "supportLevel" TEXT,
    "description" TEXT,
    "status" "PlanStatus" NOT NULL DEFAULT 'ACTIVE',
    "featureInventory" BOOLEAN NOT NULL DEFAULT true,
    "featureSales" BOOLEAN NOT NULL DEFAULT true,
    "featureQuotations" BOOLEAN NOT NULL DEFAULT false,
    "featurePurchaseOrders" BOOLEAN NOT NULL DEFAULT false,
    "featureExpenses" BOOLEAN NOT NULL DEFAULT false,
    "featurePayroll" BOOLEAN NOT NULL DEFAULT false,
    "featureCrm" BOOLEAN NOT NULL DEFAULT false,
    "featureMultiStore" BOOLEAN NOT NULL DEFAULT false,
    "featureCloudSync" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "licenses" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "licenseKey" TEXT NOT NULL,
    "status" "LicenseStatus" NOT NULL DEFAULT 'TRIAL',
    "trialEndsAt" TIMESTAMP(3),
    "suspensionReason" "SuspensionReason",
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "licenses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscriptions" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "subscriptionType" "SubscriptionType" NOT NULL,
    "billingCycle" "BillingCycle" NOT NULL,
    "status" "SubscriptionBillingStatus" NOT NULL DEFAULT 'ACTIVE',
    "startDate" TIMESTAMP(3) NOT NULL,
    "nextDueDate" TIMESTAMP(3),
    "priceCents" INTEGER NOT NULL,
    "maintenanceFeeCents" INTEGER,
    "maintenanceExpiry" TIMESTAMP(3),
    "supportExpiry" TIMESTAMP(3),
    "supportStatus" "SupportStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscription_payments" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "currency" "Currency" NOT NULL,
    "paymentMethod" TEXT NOT NULL,
    "transactionReference" TEXT,
    "billingPeriod" TEXT NOT NULL,
    "paymentDate" TIMESTAMP(3) NOT NULL,
    "nextDueDateAfter" TIMESTAMP(3),
    "status" "PaymentStatus" NOT NULL DEFAULT 'PAID',
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "subscription_payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "devices" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "deviceName" TEXT NOT NULL,
    "deviceType" "DeviceType" NOT NULL,
    "storefrontId" TEXT,
    "osName" TEXT,
    "appVersion" TEXT,
    "registeredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeen" TIMESTAMP(3),
    "lastSync" TIMESTAMP(3),
    "status" "DeviceStatus" NOT NULL DEFAULT 'ACTIVE',
    "licenseKeyUsed" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "devices_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "licenses_tenantId_key" ON "licenses"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "licenses_licenseKey_key" ON "licenses"("licenseKey");

-- CreateIndex
CREATE UNIQUE INDEX "subscriptions_tenantId_key" ON "subscriptions"("tenantId");

-- AddForeignKey
ALTER TABLE "plans" ADD CONSTRAINT "plans_outletId_fkey" FOREIGN KEY ("outletId") REFERENCES "outlets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "licenses" ADD CONSTRAINT "licenses_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_planId_fkey" FOREIGN KEY ("planId") REFERENCES "plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscription_payments" ADD CONSTRAINT "subscription_payments_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscription_payments" ADD CONSTRAINT "subscription_payments_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "devices" ADD CONSTRAINT "devices_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
