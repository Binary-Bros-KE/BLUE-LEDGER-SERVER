import type { Device, License, Plan, Subscription, Tenant } from "@prisma/client";
import { HttpError, NotFoundError } from "../lib/http-error.js";
import { assertLicenseUsable } from "../lib/license-guard.js";
import { type BillingPeriodEntry, computePaymentSchedule } from "../lib/billing-periods.js";
import { prisma } from "../prisma.js";
import {
  activationHeartbeatSchema,
  activationPaymentsQuerySchema,
  activationProfileUpdateSchema,
  activationRegisterSchema,
} from "../schemas/activation.js";

type LicenseWithContext = License & {
  tenant: Tenant & {
    subscription: (Subscription & { plan: Plan }) | null;
    devices: Device[];
  };
};

async function findLicenseWithContext(licenseKey: string): Promise<LicenseWithContext | null> {
  return prisma.license.findUnique({
    where: { licenseKey },
    include: {
      tenant: {
        include: { subscription: { include: { plan: true } }, devices: true },
      },
    },
  });
}

/** Every field the desktop's local Business Profile screen edits, mirrored here — kept in sync via
 * POST /activation/profile (desktop push) both ways: register seeds a fresh install with whatever's
 * already on file, and heartbeat re-syncs it periodically so a dashboard-side edit eventually
 * reaches the device too. `businessProfileUpdatedAt` rides alongside these on every register/
 * heartbeat response so the desktop can tell whether the cloud's copy is actually newer than its
 * own local edit before overwriting anything — see Tenant.businessProfileUpdatedAt's own comment. */
type BusinessProfileFields = {
  // Real bug found live (2026-07-24): businessName/businessType/currency are all editable on the
  // desktop's own local Business Profile screen (see shared/schemas/tenant.ts's
  // businessProfileInputSchema), but were never part of ANY push/pull surface here at all — not
  // even the one-time registration seed. Editing them on one device just silently never reached
  // the cloud or any other device, forever. Now included like every other profile field.
  businessName: string;
  businessType: string;
  currency: string;
  ownerName: string | null;
  contactEmail: string;
  contactPhone: string | null;
  businessRegistrationNumber: string | null;
  kraPin: string | null;
  email: string | null;
  alternativePhone: string | null;
  website: string | null;
  country: string | null;
  countyState: string | null;
  cityTown: string | null;
  physicalAddress: string | null;
  ownerPhone: string | null;
  ownerEmail: string | null;
};

function extractBusinessProfileFields(tenant: Tenant): BusinessProfileFields & { businessProfileUpdatedAt: string | null } {
  return {
    businessName: tenant.name,
    businessType: tenant.businessType,
    currency: tenant.currency,
    ownerName: tenant.ownerName,
    contactEmail: tenant.contactEmail,
    contactPhone: tenant.contactPhone,
    businessRegistrationNumber: tenant.businessRegistrationNumber,
    kraPin: tenant.kraPin,
    email: tenant.email,
    alternativePhone: tenant.alternativePhone,
    website: tenant.website,
    country: tenant.country,
    countyState: tenant.countyState,
    cityTown: tenant.cityTown,
    physicalAddress: tenant.physicalAddress,
    ownerPhone: tenant.ownerPhone,
    ownerEmail: tenant.ownerEmail,
    businessProfileUpdatedAt: tenant.businessProfileUpdatedAt?.toISOString() ?? null,
  };
}

export type ActivationResult = BusinessProfileFields & {
  tenantId: string;
  deviceId: string;
  deviceSequence: number;
  timezone: string;
  licenseStatus: string;
  subscriptionType: string | null;
  planName: string;
  maxBranches: number;
  maxUsers: number;
  maxDevices: number;
  businessProfileUpdatedAt: string | null;
};

/** First-time activation for a fresh desktop install — no auth token, the license key IS the
 * credential. Enforces the plan's maxDevices at the exact moment it matters (registration), not
 * after the fact. Creates a real Device row; the desktop caches the returned deviceId locally and
 * sends it on every future heartbeat. */
export async function registerDevice(input: unknown): Promise<ActivationResult> {
  const parsed = activationRegisterSchema.parse(input);
  const license = await findLicenseWithContext(parsed.licenseKey);
  if (!license) {
    throw new NotFoundError("Invalid license key");
  }
  assertLicenseUsable(license);

  const { tenant } = license;
  if (!tenant.subscription) {
    throw new HttpError(400, "This tenant has no subscription set up — contact Blue Ledger support.");
  }

  // A per-tenant override (set by an admin on the tenant's own detail page) beats the plan's
  // shared default — lets one tenant's limit be raised (or lowered) without moving them to a
  // different Plan, which would affect every other tenant on it too.
  const effectiveMaxDevices = tenant.maxDevicesOverride ?? tenant.subscription.plan.maxDevices;
  const activeDeviceCount = tenant.devices.filter((device) => device.status === "ACTIVE").length;
  if (activeDeviceCount >= effectiveMaxDevices) {
    throw new HttpError(
      403,
      `Device limit reached (${effectiveMaxDevices} for this tenant). Contact Blue Ledger support to add more.`,
    );
  }

  // Claiming the sequence and creating the Device happen in one transaction — `increment` is an
  // atomic row-level operation, so two concurrent registrations for the same tenant can never be
  // handed the same number. Deliberately not derived from `activeDeviceCount` (a live count), which
  // would let a revoked-then-replaced device reuse an old number — this counter only ever grows.
  const { device, deviceSequence } = await prisma.$transaction(async (tx) => {
    const updatedTenant = await tx.tenant.update({
      where: { id: tenant.id },
      data: { nextDeviceSequence: { increment: 1 }, lastCloudSync: new Date() },
    });
    const claimedSequence = updatedTenant.nextDeviceSequence - 1;

    const createdDevice = await tx.device.create({
      data: {
        tenantId: tenant.id,
        deviceName: parsed.deviceName,
        deviceType: parsed.deviceType,
        osName: parsed.osName,
        appVersion: parsed.appVersion,
        lastSeen: new Date(),
        licenseKeyUsed: parsed.licenseKey,
        sequenceNumber: claimedSequence,
      },
    });

    return { device: createdDevice, deviceSequence: claimedSequence };
  });

  return {
    tenantId: tenant.id,
    deviceId: device.id,
    deviceSequence,
    timezone: tenant.timezone,
    licenseStatus: license.status,
    subscriptionType: tenant.subscription.subscriptionType,
    planName: tenant.subscription.plan.name,
    maxBranches: tenant.subscription.plan.maxBranches,
    maxUsers: tenant.subscription.plan.maxUsers,
    maxDevices: effectiveMaxDevices,
    ...extractBusinessProfileFields(tenant),
  };
}

export type HeartbeatResult = BusinessProfileFields & {
  tenantId: string;
  deviceSequence: number;
  licenseStatus: string;
  nextDueDate: string | null;
  subscriptionType: string | null;
  planName: string;
  maxBranches: number;
  maxUsers: number;
  maxDevices: number;
  businessProfileUpdatedAt: string | null;
};

/** Called periodically by an already-registered install — the ongoing "is this license still
 * good" check. Rejects with 403 the moment a license is found suspended/cancelled; the desktop
 * caches whatever it last successfully heard so it can keep working offline in between calls. */
export async function heartbeat(input: unknown): Promise<HeartbeatResult> {
  const parsed = activationHeartbeatSchema.parse(input);
  const license = await findLicenseWithContext(parsed.licenseKey);
  if (!license) {
    throw new NotFoundError("Invalid license key");
  }

  const device = license.tenant.devices.find((d) => d.id === parsed.deviceId);
  if (!device) {
    throw new NotFoundError("Device not recognized for this license — re-activate this installation.");
  }

  assertLicenseUsable(license);

  await prisma.device.update({
    where: { id: device.id },
    data: { lastSeen: new Date(), ...(parsed.appVersion ? { appVersion: parsed.appVersion } : {}) },
  });
  await prisma.tenant.update({ where: { id: license.tenant.id }, data: { lastCloudSync: new Date() } });

  const subscription = license.tenant.subscription;
  return {
    // Already-activated installs need this backfilled too — activation-service.ts's register()
    // has always returned it, but heartbeat never did, so any install that activated before that
    // field started being persisted locally (see tenant-repository.ts's updateTenantLicenseRow)
    // had no path to ever pick it up. Cheap to include on every heartbeat; COALESCE on the desktop
    // side makes this a no-op once it's already set.
    tenantId: license.tenant.id,
    // Same reasoning as tenantId above — every device already has a real sequenceNumber (backfilled
    // for pre-existing devices by the device_sequence migration), but only register() ever returned
    // it until now. Lets an already-activated device pick up its clean integer tag on its next
    // heartbeat instead of staying on the hash-based pre-activation fallback forever.
    deviceSequence: device.sequenceNumber,
    licenseStatus: license.status,
    nextDueDate: subscription?.nextDueDate?.toISOString() ?? null,
    subscriptionType: subscription?.subscriptionType ?? null,
    planName: subscription?.plan.name ?? "",
    maxBranches: subscription?.plan.maxBranches ?? 1,
    maxUsers: subscription?.plan.maxUsers ?? 1,
    maxDevices: license.tenant.maxDevicesOverride ?? subscription?.plan.maxDevices ?? 1,
    ...extractBusinessProfileFields(license.tenant),
  };
}

/** The desktop app's own Business Profile screen is the real source of truth for these fields —
 * this is the push side of the sync (register/heartbeat above are the pull side). No license-usable
 * check here: even a suspended tenant should be able to keep their on-file details current, since
 * suspension is a billing/access concern, not a "we stop listening to you" one. */
export async function updateProfile(input: unknown): Promise<{ success: true }> {
  const parsed = activationProfileUpdateSchema.parse(input);
  const { licenseKey, ...fields } = parsed;
  const license = await prisma.license.findUnique({ where: { licenseKey } });
  if (!license) {
    throw new NotFoundError("Invalid license key");
  }
  await prisma.tenant.update({
    where: { id: license.tenantId },
    data: { ...fields, businessProfileUpdatedAt: new Date() },
  });
  return { success: true };
}

export type PaymentSummary = {
  id: string;
  amountCents: number;
  currency: string;
  paymentMethod: string;
  transactionReference: string | null;
  billingPeriod: string;
  paymentDate: string;
  status: string;
};

export type PaymentHistoryResult = {
  recentPayments: PaymentSummary[];
  pendingPayments: PaymentSummary[];
};

function toPaymentSummary(payment: {
  id: string;
  amountCents: number;
  currency: string;
  paymentMethod: string;
  transactionReference: string | null;
  billingPeriod: string;
  paymentDate: Date;
  status: string;
}): PaymentSummary {
  return {
    id: payment.id,
    amountCents: payment.amountCents,
    currency: payment.currency,
    paymentMethod: payment.paymentMethod,
    transactionReference: payment.transactionReference,
    billingPeriod: payment.billingPeriod,
    paymentDate: payment.paymentDate.toISOString(),
    status: payment.status,
  };
}

/** Read-only, license-key-authenticated — lets the desktop show "your last 5 payments" plus
 * anything still outstanding without needing an Account/JWT. */
export async function listPayments(input: unknown): Promise<PaymentHistoryResult> {
  const parsed = activationPaymentsQuerySchema.parse(input);
  const license = await prisma.license.findUnique({ where: { licenseKey: parsed.licenseKey } });
  if (!license) {
    throw new NotFoundError("Invalid license key");
  }

  const [recentPayments, pendingPayments] = await Promise.all([
    prisma.subscriptionPayment.findMany({
      where: { tenantId: license.tenantId, status: "PAID" },
      orderBy: { paymentDate: "desc" },
      take: 5,
    }),
    prisma.subscriptionPayment.findMany({
      where: { tenantId: license.tenantId, status: "PENDING" },
      orderBy: { paymentDate: "asc" },
    }),
  ]);

  return {
    recentPayments: recentPayments.map(toPaymentSummary),
    pendingPayments: pendingPayments.map(toPaymentSummary),
  };
}

export type PaymentScheduleResult = {
  billingCycle: string;
  /** What ONE period costs — Subscription.priceCents for MONTHLY, maintenanceFeeCents for YEARLY.
   * Null for ONCE (nothing recurring exists to show a schedule or a prepay picker for). */
  pricePerPeriodCents: number | null;
  currency: string;
  periods: BillingPeriodEntry[];
  nextDueDate: string | null;
};

/** Powers both DESKTOP's own port of the admin dashboard's "Jan ✅ Feb ✅ Mar ❌" PaymentCalendar
 * view and the "pay N periods in advance" picker's period list/pricing — read-only, license-key-
 * authenticated like listPayments above. All period math lives in billing-periods.ts so this can
 * never disagree with how the platform-billing STK flow itself computes what a payment covers. */
export async function getPaymentSchedule(input: unknown): Promise<PaymentScheduleResult> {
  const parsed = activationPaymentsQuerySchema.parse(input);
  const license = await prisma.license.findUnique({
    where: { licenseKey: parsed.licenseKey },
    include: { tenant: { include: { subscription: true } } },
  });
  if (!license) {
    throw new NotFoundError("Invalid license key");
  }

  const subscription = license.tenant.subscription;
  if (!subscription) {
    return { billingCycle: "ONCE", pricePerPeriodCents: null, currency: license.tenant.currency, periods: [], nextDueDate: null };
  }

  const paidPayments = await prisma.subscriptionPayment.findMany({
    where: { tenantId: license.tenantId, status: "PAID" },
    select: { billingPeriod: true },
  });
  const paidPeriods = new Set(paidPayments.map((payment) => payment.billingPeriod));

  const periods = computePaymentSchedule(subscription.startDate, subscription.billingCycle, paidPeriods);
  const pricePerPeriodCents =
    subscription.billingCycle === "MONTHLY"
      ? subscription.priceCents
      : subscription.billingCycle === "YEARLY"
        ? (subscription.maintenanceFeeCents ?? null)
        : null;

  return {
    billingCycle: subscription.billingCycle,
    pricePerPeriodCents,
    currency: license.tenant.currency,
    periods,
    nextDueDate: subscription.nextDueDate?.toISOString() ?? null,
  };
}
