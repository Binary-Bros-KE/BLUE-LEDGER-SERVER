import { readFile } from "node:fs/promises";
import path from "node:path";
import { Prisma } from "@prisma/client";
import type { AuthenticatedAccount } from "../middleware/auth.js";
import { env } from "../env.js";
import {
  activityState,
  DESKTOP_SEEN_THROTTLE_MS,
  isOlderVersion,
  latest,
  ONLINE_WINDOW_MS,
  shouldRestamp,
  type ActivityState,
} from "../lib/activity-status.js";
import { NotFoundError } from "../lib/http-error.js";
import { withTenantContext } from "../lib/tenant-context.js";
import { prisma } from "../prisma.js";

/**
 * The admin Activity tab: is each business actually using Blue Ledger, and who in it. Built from what
 * the system already records — desktop check-ins (Device.lastSeen, every ~20s while the app is open),
 * who's signed in on each till and each person's last desktop/phone use (stamped by the heartbeat and
 * mobile-auth), and completed sales (who, when). See lib/activity-status.ts for the buckets.
 */

/** Called from the desktop heartbeat: the signed-in employee was just seen on a desktop. */
export async function stampDesktopSeen(tenantId: string, employeeId: string, now: Date = new Date()): Promise<void> {
  await withTenantContext(tenantId, async (tx) => {
    const employee = await tx.employee.findUnique({ where: { id: employeeId }, select: { tenantId: true, lastDesktopSeenAt: true } });
    if (!employee || employee.tenantId !== tenantId) return;
    if (shouldRestamp(employee.lastDesktopSeenAt, DESKTOP_SEEN_THROTTLE_MS, now)) {
      await tx.employee.update({ where: { id: employeeId }, data: { lastDesktopSeenAt: now } });
    }
  });
}

/** The version shops are being offered right now (the update feed's latest.yml). */
async function latestDesktopVersion(): Promise<string | null> {
  try {
    const yml = await readFile(path.resolve(env.RELEASES_DIR, "latest.yml"), "utf8");
    return /^version:\s*(\S+)/m.exec(yml)?.[1] ?? null;
  } catch {
    return null;
  }
}

/** "2026-11-21" in the business's own timezone. */
function dayKey(date: Date, timeZone: string): string {
  return date.toLocaleDateString("en-CA", { timeZone });
}

/** The last `days` day keys, oldest first, ending today (business timezone). */
function lastDays(days: number, timeZone: string, now: Date): string[] {
  const keys: string[] = [];
  for (let i = days - 1; i >= 0; i -= 1) keys.push(dayKey(new Date(now.getTime() - i * 86_400_000), timeZone));
  return keys;
}

type DailyRow = { day: string; count: number; value: bigint | number };

async function dailySales(tx: Prisma.TransactionClient, tenantId: string, timeZone: string, since: Date): Promise<Map<string, { count: number; valueCents: number }>> {
  const rows = await tx.$queryRaw<DailyRow[]>`
    SELECT to_char(("localCreatedAt" AT TIME ZONE 'UTC') AT TIME ZONE ${timeZone}, 'YYYY-MM-DD') AS day,
           COUNT(*)::int AS count,
           COALESCE(SUM("grandTotalCents"), 0) AS value
    FROM sales
    WHERE "tenantId" = ${tenantId} AND "saleStatus" = 'completed' AND "localCreatedAt" >= ${since}
    GROUP BY 1`;
  return new Map(rows.map((row) => [row.day, { count: row.count, valueCents: Number(row.value) }]));
}

async function lastSaleAt(tx: Prisma.TransactionClient, tenantId: string): Promise<Date | null> {
  const rows = await tx.$queryRaw<Array<{ at: Date | null }>>`
    SELECT MAX("localCreatedAt") AS at FROM sales WHERE "tenantId" = ${tenantId} AND "saleStatus" = 'completed'`;
  return rows[0]?.at ?? null;
}

const TENANT_SELECT = {
  id: true,
  name: true,
  timezone: true,
  createdAt: true,
  outlet: { select: { id: true, name: true } },
  license: { select: { status: true } },
  subscription: { select: { plan: { select: { name: true } } } },
  devices: {
    select: { id: true, deviceName: true, deviceType: true, appVersion: true, lastSeen: true, status: true, currentEmployeeId: true, currentEmployeeName: true, registeredAt: true },
  },
} satisfies Prisma.TenantSelect;

type TenantRow = Prisma.TenantGetPayload<{ select: typeof TENANT_SELECT }>;

function scopeWhere(actor: AuthenticatedAccount): Prisma.TenantWhereInput {
  return actor.role === "SUPER_ADMIN" ? {} : { outletId: actor.outletId ?? "__no-outlet-assigned__" };
}

export type TenantActivitySummary = {
  tenantId: string;
  name: string;
  outletId: string;
  outletName: string;
  licenseStatus: string | null;
  planName: string | null;
  createdAt: string;
  state: ActivityState;
  lastSeenAt: string | null;
  devices: { total: number; online: number; outdated: number; versions: Array<{ version: string; count: number }> };
  users: { total: number; active7d: number; onDesktopNow: number; onPhone7d: number };
  sales: { today: number; last7: number; prev7: number; last7ValueCents: number; lastSaleAt: string | null; daily14: number[] };
};

export type ActivityOverview = {
  generatedAt: string;
  latestDesktopVersion: string | null;
  tenants: TenantActivitySummary[];
};

const DAY_MS = 86_400_000;

async function summarize(tenant: TenantRow, latestVersion: string | null, now: Date): Promise<TenantActivitySummary> {
  const timeZone = tenant.timezone || "Africa/Nairobi";
  const days = lastDays(14, timeZone, now);
  const { employees, daily, lastSale } = await withTenantContext(tenant.id, async (tx) => ({
    employees: await tx.employee.findMany({
      where: { tenantId: tenant.id, status: "active" },
      select: { id: true, lastDesktopSeenAt: true, lastMobileSeenAt: true },
    }),
    daily: await dailySales(tx, tenant.id, timeZone, new Date(now.getTime() - 15 * DAY_MS)),
    lastSale: await lastSaleAt(tx, tenant.id),
  }));

  const activeDevices = tenant.devices.filter((device) => device.status === "ACTIVE");
  const online = activeDevices.filter((device) => device.lastSeen && now.getTime() - device.lastSeen.getTime() <= ONLINE_WINDOW_MS);
  const versionCounts = new Map<string, number>();
  for (const device of activeDevices) {
    const version = device.appVersion ?? "unknown";
    versionCounts.set(version, (versionCounts.get(version) ?? 0) + 1);
  }
  const weekAgo = now.getTime() - 7 * DAY_MS;
  const daily14 = days.map((day) => daily.get(day)?.count ?? 0);
  const lastDevice = latest(...activeDevices.map((device) => device.lastSeen));
  const lastPhone = latest(...employees.map((employee) => employee.lastMobileSeenAt));
  const lastSeen = latest(lastDevice, lastPhone, lastSale);

  return {
    tenantId: tenant.id,
    name: tenant.name,
    outletId: tenant.outlet.id,
    outletName: tenant.outlet.name,
    licenseStatus: tenant.license?.status ?? null,
    planName: tenant.subscription?.plan.name ?? null,
    createdAt: tenant.createdAt.toISOString(),
    state: activityState(lastSeen, now),
    lastSeenAt: lastSeen?.toISOString() ?? null,
    devices: {
      total: activeDevices.length,
      online: online.length,
      outdated: activeDevices.filter((device) => isOlderVersion(device.appVersion, latestVersion)).length,
      versions: [...versionCounts.entries()].map(([version, count]) => ({ version, count })).sort((a, b) => b.count - a.count),
    },
    users: {
      total: employees.length,
      active7d: employees.filter((employee) => (latest(employee.lastDesktopSeenAt, employee.lastMobileSeenAt)?.getTime() ?? 0) >= weekAgo).length,
      onDesktopNow: new Set(online.map((device) => device.currentEmployeeId).filter(Boolean)).size,
      onPhone7d: employees.filter((employee) => (employee.lastMobileSeenAt?.getTime() ?? 0) >= weekAgo).length,
    },
    sales: {
      today: daily14[13] ?? 0,
      last7: daily14.slice(7).reduce((sum, n) => sum + n, 0),
      prev7: daily14.slice(0, 7).reduce((sum, n) => sum + n, 0),
      last7ValueCents: days.slice(7).reduce((sum, day) => sum + (daily.get(day)?.valueCents ?? 0), 0),
      lastSaleAt: lastSale?.toISOString() ?? null,
      daily14,
    },
  };
}

/** Every business the account can see, with its activity summary — most recently active first. */
export async function getActivityOverview(actor: AuthenticatedAccount, now: Date = new Date()): Promise<ActivityOverview> {
  const [tenants, latestVersion] = await Promise.all([
    prisma.tenant.findMany({ where: scopeWhere(actor), select: TENANT_SELECT }),
    latestDesktopVersion(),
  ]);
  const summaries: TenantActivitySummary[] = [];
  // A few at a time: each is its own short tenant-scoped transaction (sales are row-level isolated).
  for (let i = 0; i < tenants.length; i += 5) {
    summaries.push(...(await Promise.all(tenants.slice(i, i + 5).map((tenant) => summarize(tenant, latestVersion, now)))));
  }
  summaries.sort((a, b) => (b.lastSeenAt ?? "").localeCompare(a.lastSeenAt ?? "") || a.name.localeCompare(b.name));
  return { generatedAt: now.toISOString(), latestDesktopVersion: latestVersion, tenants: summaries };
}

export type TenantActivityDetail = {
  tenantId: string;
  name: string;
  timezone: string;
  latestDesktopVersion: string | null;
  devices: Array<{
    id: string;
    name: string;
    type: string;
    appVersion: string | null;
    outdated: boolean;
    lastSeenAt: string | null;
    state: ActivityState;
    currentEmployeeName: string | null;
    status: string;
    registeredAt: string;
  }>;
  users: Array<{
    id: string;
    name: string;
    employeeCode: string;
    roleName: string | null;
    status: string;
    lastDesktopSeenAt: string | null;
    lastMobileSeenAt: string | null;
    lastLoginAt: string | null;
    lastSaleAt: string | null;
    lastSeenAt: string | null;
    state: ActivityState;
    sales30d: number;
    sales30dValueCents: number;
  }>;
  daily30: Array<{ day: string; count: number; valueCents: number }>;
};

/** One business in detail: every till, every person, 30 days of sales. */
export async function getTenantActivity(tenantId: string, actor: AuthenticatedAccount, now: Date = new Date()): Promise<TenantActivityDetail> {
  const [tenant, latestVersion] = await Promise.all([
    prisma.tenant.findFirst({ where: { id: tenantId, ...scopeWhere(actor) }, select: TENANT_SELECT }),
    latestDesktopVersion(),
  ]);
  if (!tenant) throw new NotFoundError("Tenant not found");
  const timeZone = tenant.timezone || "Africa/Nairobi";
  const since = new Date(now.getTime() - 31 * DAY_MS);

  const { employees, roles, daily, perEmployee } = await withTenantContext(tenant.id, async (tx) => ({
    employees: await tx.employee.findMany({
      where: { tenantId: tenant.id },
      select: { id: true, firstName: true, lastName: true, employeeCode: true, roleId: true, status: true, lastLogin: true, lastDesktopSeenAt: true, lastMobileSeenAt: true },
    }),
    roles: await tx.role.findMany({ where: { tenantId: tenant.id }, select: { id: true, roleName: true } }),
    daily: await dailySales(tx, tenant.id, timeZone, since),
    perEmployee: await tx.$queryRaw<Array<{ employeeId: string; count: number; value: bigint | number; lastAt: Date | null; allTimeLast: Date | null }>>`
      SELECT "employeeId",
             COUNT(*) FILTER (WHERE "localCreatedAt" >= ${since})::int AS count,
             COALESCE(SUM("grandTotalCents") FILTER (WHERE "localCreatedAt" >= ${since}), 0) AS value,
             MAX("localCreatedAt") FILTER (WHERE "localCreatedAt" >= ${since}) AS "lastAt",
             MAX("localCreatedAt") AS "allTimeLast"
      FROM sales
      WHERE "tenantId" = ${tenant.id} AND "saleStatus" = 'completed'
      GROUP BY "employeeId"`,
  }));

  const roleName = new Map(roles.map((role) => [role.id, role.roleName]));
  const salesBy = new Map(perEmployee.map((row) => [row.employeeId, row]));

  const users = employees
    .map((employee) => {
      const sales = salesBy.get(employee.id);
      const lastSale = sales?.allTimeLast ?? null;
      const lastSeen = latest(employee.lastDesktopSeenAt, employee.lastMobileSeenAt, lastSale);
      return {
        id: employee.id,
        name: `${employee.firstName} ${employee.lastName}`.trim(),
        employeeCode: employee.employeeCode,
        roleName: employee.roleId ? (roleName.get(employee.roleId) ?? null) : null,
        status: employee.status,
        lastDesktopSeenAt: employee.lastDesktopSeenAt?.toISOString() ?? null,
        lastMobileSeenAt: employee.lastMobileSeenAt?.toISOString() ?? null,
        lastLoginAt: employee.lastLogin?.toISOString() ?? null,
        lastSaleAt: lastSale?.toISOString() ?? null,
        lastSeenAt: lastSeen?.toISOString() ?? null,
        state: activityState(lastSeen, now),
        sales30d: sales?.count ?? 0,
        sales30dValueCents: Number(sales?.value ?? 0),
      };
    })
    .sort((a, b) => (b.lastSeenAt ?? "").localeCompare(a.lastSeenAt ?? "") || a.name.localeCompare(b.name));

  const devices = tenant.devices
    .map((device) => ({
      id: device.id,
      name: device.deviceName,
      type: device.deviceType,
      appVersion: device.appVersion,
      outdated: isOlderVersion(device.appVersion, latestVersion),
      lastSeenAt: device.lastSeen?.toISOString() ?? null,
      state: activityState(device.lastSeen, now),
      // Only meaningful while the till is actually online.
      currentEmployeeName:
        device.lastSeen && now.getTime() - device.lastSeen.getTime() <= ONLINE_WINDOW_MS ? device.currentEmployeeName : null,
      status: device.status,
      registeredAt: device.registeredAt.toISOString(),
    }))
    .sort((a, b) => (b.lastSeenAt ?? "").localeCompare(a.lastSeenAt ?? ""));

  return {
    tenantId: tenant.id,
    name: tenant.name,
    timezone: timeZone,
    latestDesktopVersion: latestVersion,
    devices,
    users,
    daily30: lastDays(30, timeZone, now).map((day) => ({ day, count: daily.get(day)?.count ?? 0, valueCents: daily.get(day)?.valueCents ?? 0 })),
  };
}
