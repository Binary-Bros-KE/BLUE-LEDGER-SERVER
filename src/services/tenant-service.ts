import type { License, Location, Outlet, Plan, Subscription, Tenant } from "@prisma/client";
import type { AuthenticatedAccount } from "../middleware/auth.js";
import { HttpError, NotFoundError } from "../lib/http-error.js";
import { withTenantContext } from "../lib/tenant-context.js";
import { prisma } from "../prisma.js";
import { tenantCreateSchema, tenantUpdateSchema } from "../schemas/tenant.js";

const WITH_RELATIONS = {
  include: { outlet: true, license: true, subscription: { include: { plan: true } } },
} as const;
export type TenantWithRelations = Tenant & {
  outlet: Outlet;
  license: License | null;
  subscription: (Subscription & { plan: Plan }) | null;
  locations: Location[];
};

/** `locations` is a synced, Row-Level-Security-protected table (see tenant-context.ts) — its
 * policy requires the `app.tenant_id` session GUC, which ONLY ever gets set inside
 * withTenantContext. A bare `prisma.location.findMany(...)` from this Account/JWT-authenticated
 * admin connection would silently return ZERO rows regardless of what real data exists, since RLS
 * fails closed by design. Confirmed live: a tenant with a real, sync-confirmed storefront (visible
 * on a second desktop device) showed "no storefronts" in the admin dashboard until this was added. */
async function findTenantLocations(tenantId: string): Promise<Location[]> {
  return withTenantContext(tenantId, (tx) =>
    tx.location.findMany({ where: { tenantId }, orderBy: { locationName: "asc" } }),
  );
}

/** Derives a valid, unique-enough Postgres database name from a tenant's slug. Actually
 * provisioning this database (CREATE DATABASE + running the tenant-app schema's migrations) is a
 * separate, not-yet-built step — this registry only reserves the name up front so it's stable and
 * known before that provisioning work exists. */
function deriveDbName(slug: string): string {
  return `bl_tenant_${slug.replace(/-/g, "_")}`;
}

/** MONTHLY → due again in a month; YEARLY → due again in a year (this is what a LIFETIME
 * subscription's ongoing maintenance renewal tracks); ONCE → no recurring due date at all (a
 * true one-and-done sale, nothing ever owed again). */
function computeNextDueDate(startDate: Date, billingCycle: "MONTHLY" | "YEARLY" | "ONCE"): Date | null {
  if (billingCycle === "MONTHLY") {
    const next = new Date(startDate);
    next.setMonth(next.getMonth() + 1);
    return next;
  }
  if (billingCycle === "YEARLY") {
    const next = new Date(startDate);
    next.setFullYear(next.getFullYear() + 1);
    return next;
  }
  return null;
}

async function findTenantRow(id: string): Promise<TenantWithRelations | null> {
  const tenant = await prisma.tenant.findUnique({ where: { id }, ...WITH_RELATIONS });
  if (!tenant) return null;
  const locations = await findTenantLocations(id);
  return { ...tenant, locations };
}

/** SUPER_ADMIN sees every client, across every outlet. A MARKETER only ever sees their own
 * outlet's — this is the actual security boundary, not just a UI filter. Outlet/license/subscription
 * are embedded so the dashboard can show everything about a tenant in one call.
 *
 * `locations` is deliberately left empty here, not fetched — the list view never shows per-tenant
 * storefront detail (only the detail page does, via getTenant/findTenantRow), and RLS means each
 * tenant's own locations would need its own separate withTenantContext-scoped query, one per row —
 * real cost for a value nothing on this page reads. */
export async function listTenants(actor: AuthenticatedAccount): Promise<TenantWithRelations[]> {
  const tenants =
    actor.role === "SUPER_ADMIN"
      ? await prisma.tenant.findMany({ orderBy: { createdAt: "desc" }, ...WITH_RELATIONS })
      : await prisma.tenant.findMany({
          where: { outletId: actor.outletId ?? "__no-outlet-assigned__" },
          orderBy: { createdAt: "desc" },
          ...WITH_RELATIONS,
        });
  return tenants.map((tenant) => ({ ...tenant, locations: [] }));
}

/** Same boundary, per-record — a MARKETER fetching another outlet's tenant by id gets 404, not
 * 403, so it doesn't confirm the id even exists. */
export async function getTenant(id: string, actor: AuthenticatedAccount): Promise<TenantWithRelations> {
  const tenant = await findTenantRow(id);
  if (!tenant || (actor.role !== "SUPER_ADMIN" && tenant.outletId !== actor.outletId)) {
    throw new NotFoundError("Tenant not found");
  }
  return tenant;
}

/** Both roles can create — that's the MARKETER's actual job. Their outlet is always forced to
 * their own account's outlet, regardless of what the request body claims; only SUPER_ADMIN's
 * submitted outletId is trusted. Creates the Tenant, its TRIAL License, and its Subscription
 * together in one transaction — a tenant never exists without both. */
export async function createTenant(input: unknown, actor: AuthenticatedAccount): Promise<TenantWithRelations> {
  const parsed = tenantCreateSchema.parse(input);
  const outletId = actor.role === "SUPER_ADMIN" ? parsed.outletId : actor.outletId;
  if (!outletId) {
    throw new HttpError(400, "No outlet is assigned to your account — contact a super admin");
  }

  const plan = await prisma.plan.findUnique({ where: { id: parsed.planId } });
  if (!plan || plan.outletId !== outletId) {
    throw new HttpError(400, "Selected plan doesn't belong to this outlet");
  }

  const nextDueDate = computeNextDueDate(parsed.startDate, parsed.billingCycle);
  const hasMaintenance = parsed.maintenanceFeeCents !== null;
  const supportStatus = parsed.billingCycle === "ONCE" && !hasMaintenance ? "LIFETIME" : "ACTIVE";

  const tenant = await prisma.$transaction(async (tx) => {
    const created = await tx.tenant.create({
      data: {
        name: parsed.name,
        slug: parsed.slug,
        outletId,
        businessType: parsed.businessType,
        timezone: parsed.timezone,
        currency: parsed.currency,
        ownerName: parsed.ownerName,
        contactEmail: parsed.contactEmail,
        contactPhone: parsed.contactPhone,
        notes: parsed.notes,
        dbName: deriveDbName(parsed.slug),
      },
    });

    await tx.license.create({
      data: { tenantId: created.id, status: "TRIAL" },
    });

    await tx.subscription.create({
      data: {
        tenantId: created.id,
        planId: parsed.planId,
        subscriptionType: parsed.subscriptionType,
        billingCycle: parsed.billingCycle,
        startDate: parsed.startDate,
        nextDueDate,
        priceCents: parsed.priceCents,
        maintenanceFeeCents: parsed.maintenanceFeeCents,
        maintenanceExpiry: hasMaintenance ? nextDueDate : null,
        supportExpiry: nextDueDate,
        supportStatus,
      },
    });

    return created;
  });

  return getTenant(tenant.id, actor);
}

/** SUPER_ADMIN only — enforced by requireSuperAdmin at the route layer (routes/tenants.ts).
 * Core tenant profile fields only — see subscription-service.ts / license actions for the rest. */
export async function updateTenant(id: string, input: unknown): Promise<TenantWithRelations> {
  const parsed = tenantUpdateSchema.parse(input);
  const existing = await prisma.tenant.findUnique({ where: { id } });
  if (!existing) {
    throw new NotFoundError("Tenant not found");
  }
  await prisma.tenant.update({ where: { id }, data: parsed });
  const updated = await findTenantRow(id);
  if (!updated) {
    throw new NotFoundError("Tenant not found");
  }
  return updated;
}

/** SUPER_ADMIN only — enforced by requireSuperAdmin at the route layer. */
export async function deleteTenant(id: string): Promise<void> {
  const existing = await prisma.tenant.findUnique({ where: { id } });
  if (!existing) {
    throw new NotFoundError("Tenant not found");
  }
  // License/Subscription/SubscriptionPayment/Device all reference this tenant with no cascade —
  // manual cleanup, same convention as the desktop app's own delete paths.
  await prisma.$transaction([
    prisma.subscriptionPayment.deleteMany({ where: { tenantId: id } }),
    prisma.device.deleteMany({ where: { tenantId: id } }),
    prisma.subscription.deleteMany({ where: { tenantId: id } }),
    prisma.license.deleteMany({ where: { tenantId: id } }),
    // NOTE: this only removes the registry rows. It deliberately does not drop the tenant's actual
    // application database — that's a destructive, separate action for once provisioning exists.
    prisma.tenant.delete({ where: { id } }),
  ]);
}
