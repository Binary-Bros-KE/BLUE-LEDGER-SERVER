import { HttpError, NotFoundError } from "../lib/http-error.js";
import {
  SUBSCRIPTION_NOTICE_LABELS,
  SUBSCRIPTION_NOTICE_STAGES,
  daysRemaining,
  defaultRenewalStart,
  endDateFor,
  pendingNotice,
  stageFor,
  type SubscriptionNoticeStage,
  type SubscriptionStage,
} from "../lib/subscription-schedule.js";
import { withTenantContext } from "../lib/tenant-context.js";
import type { MobileSession } from "../middleware/mobile-auth.js";
import { prisma } from "../prisma.js";
import { mobileSubscriptionNoticeSchema, mobileSubscriptionRenewSchema, mobileSubscriptionSchema } from "../schemas/mobile.js";

/**
 * Subscriptions (DStv, GOtv...) from the phone: the same rows and rules as DESKTOP's
 * subscription-service.ts (synced as customer_subscriptions / customer_subscription_notices; every
 * date rule from lib/subscription-schedule.ts, a copy of DESKTOP's). Tracking and manual reminders
 * only. Writes are stamped like every other phone write so the tills pull them on their next sync.
 * Branch-scoped employees only see their own storefront's.
 */

const OWNER_APP_DEVICE_ID = "owner-app";

export type MobileSubscriptionNotice = {
  id: string;
  stage: SubscriptionNoticeStage;
  channel: string;
  recipient: string | null;
  sentAt: string;
  sentByName: string | null;
};

export type MobileSubscription = {
  id: string;
  customerId: string;
  customerName: string;
  customerPhone: string | null;
  customerEmail: string | null;
  locationId: string | null;
  locationName: string | null;
  serviceName: string;
  accountNumber: string | null;
  startDate: string;
  periodDays: number;
  endDate: string;
  amountCents: number | null;
  status: string;
  renewedFromId: string | null;
  notes: string | null;
  daysLeft: number;
  stage: SubscriptionStage;
  pendingNotice: SubscriptionNoticeStage | null;
  notices: MobileSubscriptionNotice[];
};

export type MobileSubscriptionServiceSuggestion = { serviceName: string; periodDays: number; amountCents: number | null };

/** "Today" on the shop's own calendar (Tenant.timezone), never the server's: a VPS on UTC is a day
 * behind Nairobi for three hours every night. */
async function shopToday(tenantId: string): Promise<string> {
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { timezone: true } });
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: tenant.timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  } catch {
    return new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Nairobi", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  }
}

async function branchScope(tx: Parameters<Parameters<typeof withTenantContext>[1]>[0], session: MobileSession): Promise<string | null> {
  if (session.isSuperAdmin) return null;
  const employee = await tx.employee.findUnique({ where: { id: session.employeeId }, select: { branchId: true } });
  return employee?.branchId ?? null;
}

type Tx = Parameters<Parameters<typeof withTenantContext>[1]>[0];
type Row = Awaited<ReturnType<Tx["customerSubscription"]["findMany"]>>[number];

async function decorate(tx: Tx, tenantId: string, rows: Row[], today: string): Promise<MobileSubscription[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((row) => row.id);
  const [customers, locations, notices] = await Promise.all([
    tx.customer.findMany({ where: { tenantId, id: { in: [...new Set(rows.map((row) => row.customerId))] } }, select: { id: true, name: true, phone: true, email: true } }),
    tx.location.findMany({ where: { tenantId }, select: { id: true, locationName: true } }),
    tx.customerSubscriptionNotice.findMany({ where: { tenantId, subscriptionId: { in: ids } }, orderBy: { sentAt: "asc" } }),
  ]);
  const senders = await tx.employee.findMany({
    where: { id: { in: [...new Set(notices.map((notice) => notice.sentBy).filter((id): id is string => Boolean(id)))] } },
    select: { id: true, firstName: true, lastName: true },
  });
  const customerById = new Map(customers.map((customer) => [customer.id, customer]));
  const locationById = new Map(locations.map((location) => [location.id, location.locationName]));
  const senderById = new Map(senders.map((employee) => [employee.id, `${employee.firstName} ${employee.lastName}`.trim()]));

  return rows.map((row) => {
    const rowNotices: MobileSubscriptionNotice[] = notices
      .filter((notice) => notice.subscriptionId === row.id)
      .map((notice) => ({
        id: notice.id,
        stage: notice.stage as SubscriptionNoticeStage,
        channel: notice.channel,
        recipient: notice.recipient,
        sentAt: notice.sentAt,
        sentByName: notice.sentBy ? (senderById.get(notice.sentBy) ?? null) : null,
      }));
    const daysLeft = daysRemaining(row.endDate, today);
    const customer = customerById.get(row.customerId);
    return {
      id: row.id,
      customerId: row.customerId,
      customerName: customer?.name ?? "Unknown customer",
      customerPhone: customer?.phone ?? null,
      customerEmail: customer?.email ?? null,
      locationId: row.locationId,
      locationName: row.locationId ? (locationById.get(row.locationId) ?? null) : null,
      serviceName: row.serviceName,
      accountNumber: row.accountNumber,
      startDate: row.startDate,
      periodDays: row.periodDays,
      endDate: row.endDate,
      amountCents: row.amountCents,
      status: row.status,
      renewedFromId: row.renewedFromId,
      notes: row.notes,
      daysLeft,
      stage: stageFor(daysLeft),
      pendingNotice: pendingNotice(
        row.status,
        daysLeft,
        rowNotices.map((notice) => notice.stage),
      ),
      notices: rowNotices,
    };
  });
}

async function requireRow(tx: Tx, session: MobileSession, id: string): Promise<Row> {
  const row = await tx.customerSubscription.findUnique({ where: { id } });
  const scope = await branchScope(tx, session);
  if (!row || row.tenantId !== session.tenantId || (scope && row.locationId !== scope)) throw new NotFoundError("Subscription not found");
  return row;
}

/** Current periods (active and cancelled; renewed ones are history). */
export async function listSubscriptions(session: MobileSession): Promise<MobileSubscription[]> {
  const today = await shopToday(session.tenantId);
  return withTenantContext(session.tenantId, async (tx) => {
    const scope = await branchScope(tx, session);
    const rows = await tx.customerSubscription.findMany({
      where: { tenantId: session.tenantId, status: { not: "renewed" }, ...(scope ? { locationId: scope } : {}) },
      orderBy: { endDate: "asc" },
      take: 1000,
    });
    return decorate(tx, session.tenantId, rows, today);
  });
}

export async function getSubscription(session: MobileSession, id: string): Promise<MobileSubscription> {
  const today = await shopToday(session.tenantId);
  return withTenantContext(session.tenantId, async (tx) => {
    const [decorated] = await decorate(tx, session.tenantId, [await requireRow(tx, session, id)], today);
    return decorated!;
  });
}

export async function listServiceSuggestions(session: MobileSession): Promise<MobileSubscriptionServiceSuggestion[]> {
  return withTenantContext(session.tenantId, async (tx) => {
    const rows = await tx.customerSubscription.findMany({
      where: { tenantId: session.tenantId },
      orderBy: { localCreatedAt: "desc" },
      select: { serviceName: true, periodDays: true, amountCents: true },
      take: 500,
    });
    const latest = new Map<string, MobileSubscriptionServiceSuggestion>();
    for (const row of rows) if (!latest.has(row.serviceName)) latest.set(row.serviceName, row);
    return [...latest.values()];
  });
}

/** Idempotent on the phone-minted id: a retried submit never adds the subscription twice. */
export async function createSubscription(session: MobileSession, input: unknown): Promise<MobileSubscription> {
  const parsed = mobileSubscriptionSchema.parse(input);
  const id = parsed.id.startsWith("sub_") ? parsed.id : `sub_${parsed.id}`;
  const now = new Date();
  await withTenantContext(session.tenantId, async (tx) => {
    if (await tx.customerSubscription.findUnique({ where: { id }, select: { id: true } })) return;
    const customer = await tx.customer.findUnique({ where: { id: parsed.customerId }, select: { tenantId: true } });
    if (!customer || customer.tenantId !== session.tenantId) throw new NotFoundError("Customer not found");
    const scope = await branchScope(tx, session);
    await tx.customerSubscription.create({
      data: {
        id,
        tenantId: session.tenantId,
        deviceId: OWNER_APP_DEVICE_ID,
        customerId: parsed.customerId,
        locationId: scope ?? parsed.locationId ?? null,
        serviceName: parsed.serviceName,
        accountNumber: parsed.accountNumber ?? null,
        startDate: parsed.startDate,
        periodDays: parsed.periodDays,
        endDate: endDateFor(parsed.startDate, parsed.periodDays),
        amountCents: parsed.amountCents ?? null,
        status: "active",
        renewedFromId: null,
        notes: parsed.notes ?? null,
        createdBy: session.employeeId,
        localCreatedAt: now,
        localUpdatedAt: now,
        syncedAt: now,
      },
    });
  });
  return getSubscription(session, id);
}

export async function getRenewalDefaults(session: MobileSession, id: string): Promise<{ startDate: string; periodDays: number; amountCents: number | null }> {
  const today = await shopToday(session.tenantId);
  return withTenantContext(session.tenantId, async (tx) => {
    const row = await requireRow(tx, session, id);
    return { startDate: defaultRenewalStart(row.endDate, today), periodDays: row.periodDays, amountCents: row.amountCents };
  });
}

/** Old period → "renewed", new one added, both in one transaction. Idempotent on the new period's id. */
export async function renewSubscription(session: MobileSession, id: string, input: unknown): Promise<MobileSubscription> {
  const parsed = mobileSubscriptionRenewSchema.parse(input);
  const newId = parsed.id.startsWith("sub_") ? parsed.id : `sub_${parsed.id}`;
  const now = new Date();
  await withTenantContext(session.tenantId, async (tx) => {
    if (await tx.customerSubscription.findUnique({ where: { id: newId }, select: { id: true } })) return;
    const existing = await requireRow(tx, session, id);
    if (existing.status === "renewed") throw new HttpError(400, "This period has already been renewed.");
    await tx.customerSubscription.update({
      where: { id },
      data: { status: "renewed", deviceId: OWNER_APP_DEVICE_ID, localUpdatedAt: now, syncedAt: now },
    });
    await tx.customerSubscription.create({
      data: {
        id: newId,
        tenantId: session.tenantId,
        deviceId: OWNER_APP_DEVICE_ID,
        customerId: existing.customerId,
        locationId: existing.locationId,
        serviceName: existing.serviceName,
        accountNumber: existing.accountNumber,
        startDate: parsed.startDate,
        periodDays: parsed.periodDays,
        endDate: endDateFor(parsed.startDate, parsed.periodDays),
        amountCents: parsed.amountCents ?? null,
        status: "active",
        renewedFromId: id,
        notes: null,
        createdBy: session.employeeId,
        localCreatedAt: now,
        localUpdatedAt: now,
        syncedAt: now,
      },
    });
  });
  return getSubscription(session, newId);
}

export async function setSubscriptionStatus(session: MobileSession, id: string, status: "active" | "cancelled"): Promise<MobileSubscription> {
  const now = new Date();
  await withTenantContext(session.tenantId, async (tx) => {
    const existing = await requireRow(tx, session, id);
    if (existing.status === "renewed") throw new HttpError(400, "This period has been renewed — change the current one instead.");
    await tx.customerSubscription.update({ where: { id }, data: { status, deviceId: OWNER_APP_DEVICE_ID, localUpdatedAt: now, syncedAt: now } });
  });
  return getSubscription(session, id);
}

/** The same rules as DESKTOP's recordSubscriptionNotice: only a reminder the period has reached, and
 * never one already covered by the same or a later reminder (possibly sent from a till). */
export async function recordNotice(session: MobileSession, id: string, input: unknown): Promise<MobileSubscription> {
  const parsed = mobileSubscriptionNoticeSchema.parse(input);
  const noticeId = parsed.id.startsWith("subn_") ? parsed.id : `subn_${parsed.id}`;
  const today = await shopToday(session.tenantId);
  const now = new Date();
  const stage = parsed.stage as SubscriptionNoticeStage;
  await withTenantContext(session.tenantId, async (tx) => {
    if (await tx.customerSubscriptionNotice.findUnique({ where: { id: noticeId }, select: { id: true } })) return;
    const existing = await requireRow(tx, session, id);
    if (existing.status !== "active") throw new HttpError(400, "Reminders are only sent for a current, active subscription.");
    const current = stageFor(daysRemaining(existing.endDate, today));
    const index = (value: SubscriptionNoticeStage) => SUBSCRIPTION_NOTICE_STAGES.indexOf(value);
    if (current === "active" || index(current) < index(stage)) throw new HttpError(400, `It's too early for the "${SUBSCRIPTION_NOTICE_LABELS[stage]}" reminder.`);
    const sent = await tx.customerSubscriptionNotice.findMany({ where: { tenantId: session.tenantId, subscriptionId: id } });
    const covering = sent.find((notice) => index(notice.stage as SubscriptionNoticeStage) >= index(stage));
    if (covering) throw new HttpError(409, `The "${SUBSCRIPTION_NOTICE_LABELS[covering.stage as SubscriptionNoticeStage]}" reminder was already sent.`);
    await tx.customerSubscriptionNotice.create({
      data: {
        id: noticeId,
        tenantId: session.tenantId,
        deviceId: OWNER_APP_DEVICE_ID,
        subscriptionId: id,
        stage,
        channel: parsed.channel,
        recipient: parsed.recipient ?? null,
        sentBy: session.employeeId,
        sentAt: now.toISOString(),
        localCreatedAt: now,
        localUpdatedAt: now,
        syncedAt: now,
      },
    });
  });
  return getSubscription(session, id);
}
