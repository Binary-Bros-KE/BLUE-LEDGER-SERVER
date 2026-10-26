import { randomUUID } from "node:crypto";
import { ConflictError, HttpError, NotFoundError } from "../lib/http-error.js";
import { withTenantContext } from "../lib/tenant-context.js";
import { prisma } from "../prisma.js";
import {
  mobileBusinessProfileSchema,
  mobileCreatePaymentMethodSchema,
  mobileStorefrontDetailsSchema,
  mobileUpdatePaymentMethodSchema,
} from "../schemas/mobile.js";
import { OWNER_APP_DEVICE_ID } from "./mobile-checkout-service.js";
import { isStorefrontLocationType } from "./mobile-sales-service.js";

/**
 * The Owner App's Settings tab — the day-to-day subset of DESKTOP's Business Profile, Storefronts
 * and Payment Methods screens. Three different sync paths, each matched exactly:
 *  - Business profile lives on the registry Tenant row and reaches DESKTOP through its own
 *    register/heartbeat pull, NOT the generic sync engine. Writing it here stamps
 *    businessProfileUpdatedAt (the same thing POST /activation/profile does for a desktop push), so
 *    every DESKTOP's next heartbeat sees the cloud copy as newer and takes it.
 *  - A storefront's printed details (phone, address, receipt header/footer) are on the synced
 *    Location row — the receipt header/footer DESKTOP actually prints from, since the tenant-level
 *    ones never leave the device.
 *  - Payment methods are synced rows too. Never deleted from here (DESKTOP's own rule once synced —
 *    deactivate instead); a new method's `code` must stay unique because sync reconciles payment
 *    methods across devices BY code.
 * Every synced-row write stamps deviceId "owner-app" + fresh localUpdatedAt/syncedAt.
 */

export type MobileBusinessProfile = {
  businessName: string;
  contactPhone: string | null;
  alternativePhone: string | null;
  email: string | null;
  website: string | null;
  kraPin: string | null;
  cityTown: string | null;
  physicalAddress: string | null;
  vatRatePercent: number;
  pricesTaxInclusive: boolean;
};

export type MobileStorefrontDetails = {
  id: string;
  locationName: string;
  phone: string | null;
  email: string | null;
  physicalAddress: string | null;
  receiptHeader: string | null;
  receiptFooter: string | null;
};

export type MobilePaymentMethodAdmin = {
  id: string;
  name: string;
  code: string;
  isActive: boolean;
  requiresReference: boolean;
  isSystemMethod: boolean;
};

export type MobileSettings = {
  profile: MobileBusinessProfile;
  storefronts: MobileStorefrontDetails[];
  paymentMethods: MobilePaymentMethodAdmin[];
};

export async function getSettings(tenantId: string): Promise<MobileSettings> {
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } });
  return withTenantContext(tenantId, async (tx) => {
    const [locations, methods] = await Promise.all([
      tx.location.findMany({ where: { tenantId, status: "active" }, orderBy: { locationName: "asc" } }),
      tx.paymentMethod.findMany({ where: { tenantId }, orderBy: { sortOrder: "asc" } }),
    ]);
    return {
      profile: {
        businessName: tenant.name,
        contactPhone: tenant.contactPhone,
        alternativePhone: tenant.alternativePhone,
        email: tenant.email,
        website: tenant.website,
        kraPin: tenant.kraPin,
        cityTown: tenant.cityTown,
        physicalAddress: tenant.physicalAddress,
        vatRatePercent: tenant.vatRatePercent,
        pricesTaxInclusive: tenant.pricesTaxInclusive,
      },
      storefronts: locations
        .filter((l) => isStorefrontLocationType(l.locationType))
        .map((l) => ({
          id: l.id,
          locationName: l.locationName,
          phone: l.phone,
          email: l.email,
          physicalAddress: l.physicalAddress,
          receiptHeader: l.receiptHeader,
          receiptFooter: l.receiptFooter,
        })),
      paymentMethods: methods.map((m) => ({
        id: m.id,
        name: m.name,
        code: m.code,
        isActive: m.isActive,
        requiresReference: m.requiresReference,
        isSystemMethod: m.isSystemMethod,
      })),
    };
  });
}

export async function updateBusinessProfile(tenantId: string, input: unknown): Promise<{ success: true }> {
  const parsed = mobileBusinessProfileSchema.parse(input);
  await prisma.tenant.update({
    where: { id: tenantId },
    data: {
      name: parsed.businessName,
      contactPhone: parsed.contactPhone,
      alternativePhone: parsed.alternativePhone,
      email: parsed.email,
      website: parsed.website,
      kraPin: parsed.kraPin,
      cityTown: parsed.cityTown,
      physicalAddress: parsed.physicalAddress,
      vatRatePercent: parsed.vatRatePercent,
      pricesTaxInclusive: parsed.pricesTaxInclusive,
      businessProfileUpdatedAt: new Date(),
    },
  });
  return { success: true };
}

export async function updateStorefrontDetails(tenantId: string, locationId: string, input: unknown): Promise<{ id: string }> {
  const parsed = mobileStorefrontDetailsSchema.parse(input);
  const now = new Date();
  return withTenantContext(tenantId, async (tx) => {
    const location = await tx.location.findUnique({ where: { id: locationId } });
    if (!location || location.tenantId !== tenantId) throw new NotFoundError("Storefront not found");
    await tx.location.update({
      where: { id: locationId },
      data: { ...parsed, deviceId: OWNER_APP_DEVICE_ID, localUpdatedAt: now, syncedAt: now },
    });
    return { id: locationId };
  });
}

/** "M-Pesa Till" → "MPESA_TILL", then MPESA_TILL_2, _3… until unused — DESKTOP's own code rule
 * (letters, digits, underscores, uppercase), auto-filled because a shop owner shouldn't have to
 * invent one on a phone. */
function codeFromName(name: string): string {
  const base = name
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 24);
  return base || "METHOD";
}

export async function createPaymentMethod(tenantId: string, input: unknown): Promise<MobilePaymentMethodAdmin> {
  const parsed = mobileCreatePaymentMethodSchema.parse(input);
  const now = new Date();
  return withTenantContext(tenantId, async (tx) => {
    const existing = await tx.paymentMethod.findMany({ where: { tenantId }, select: { name: true, code: true, sortOrder: true } });
    if (existing.some((m) => m.name.toLowerCase() === parsed.name.toLowerCase())) {
      throw new ConflictError(`A payment method named "${parsed.name}" already exists`);
    }
    const codes = new Set(existing.map((m) => m.code));
    const base = codeFromName(parsed.name);
    let code = base;
    for (let n = 2; codes.has(code); n++) code = `${base}_${n}`;

    const created = await tx.paymentMethod.create({
      data: {
        id: `payment_method_${randomUUID()}`,
        tenantId,
        deviceId: OWNER_APP_DEVICE_ID,
        name: parsed.name,
        code,
        description: null,
        isSystemMethod: false,
        isActive: true,
        requiresReference: parsed.requiresReference,
        sortOrder: existing.reduce((max, m) => Math.max(max, m.sortOrder), 0) + 1,
        localCreatedAt: now,
        localUpdatedAt: now,
      },
    });
    return {
      id: created.id,
      name: created.name,
      code: created.code,
      isActive: created.isActive,
      requiresReference: created.requiresReference,
      isSystemMethod: created.isSystemMethod,
    };
  });
}

export async function updatePaymentMethod(tenantId: string, methodId: string, input: unknown): Promise<{ id: string }> {
  const parsed = mobileUpdatePaymentMethodSchema.parse(input);
  const now = new Date();
  return withTenantContext(tenantId, async (tx) => {
    const method = await tx.paymentMethod.findUnique({ where: { id: methodId } });
    if (!method || method.tenantId !== tenantId) throw new NotFoundError("Payment method not found");
    if (parsed.isActive === false) {
      // Checkout needs at least one way to get paid.
      const othersActive = await tx.paymentMethod.count({ where: { tenantId, isActive: true, id: { not: methodId } } });
      if (othersActive === 0) throw new HttpError(400, "Keep at least one payment method active");
    }
    await tx.paymentMethod.update({
      where: { id: methodId },
      data: { ...parsed, deviceId: OWNER_APP_DEVICE_ID, localUpdatedAt: now, syncedAt: now },
    });
    return { id: methodId };
  });
}
