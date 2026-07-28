import type { Outlet } from "@prisma/client";
import { ConflictError, NotFoundError } from "../lib/http-error.js";
import { prisma } from "../prisma.js";
import { outletCreateSchema, outletMpesaSettingsSaveSchema, outletUpdateSchema } from "../schemas/outlet.js";

// Every function here is only ever reached via a SUPER_ADMIN-gated router (see
// routes/outlets.ts) — no role checks needed inside the service itself.

export async function listOutlets(): Promise<Outlet[]> {
  return prisma.outlet.findMany({ orderBy: { name: "asc" } });
}

export async function getOutlet(id: string): Promise<Outlet> {
  const outlet = await prisma.outlet.findUnique({ where: { id } });
  if (!outlet) {
    throw new NotFoundError("Outlet not found");
  }
  return outlet;
}

export async function createOutlet(input: unknown): Promise<Outlet> {
  const parsed = outletCreateSchema.parse(input);
  return prisma.outlet.create({ data: parsed });
}

export async function updateOutlet(id: string, input: unknown): Promise<Outlet> {
  const parsed = outletUpdateSchema.parse(input);
  await getOutlet(id);
  return prisma.outlet.update({ where: { id }, data: parsed });
}

/** Blocked if any Account or Tenant still references this outlet — reassign them first. Prevents
 * an orphaned FK error from surfacing as a raw 500. */
export async function deleteOutlet(id: string): Promise<void> {
  await getOutlet(id);
  const [accountCount, tenantCount] = await Promise.all([
    prisma.account.count({ where: { outletId: id } }),
    prisma.tenant.count({ where: { outletId: id } }),
  ]);
  if (accountCount > 0 || tenantCount > 0) {
    throw new ConflictError(
      `Can't delete — ${accountCount} account(s) and ${tenantCount} client(s) are still assigned to this outlet`,
    );
  }
  await prisma.outlet.delete({ where: { id } });
}

/** Full settings INCLUDING the secret — only ever reachable via the SUPER_ADMIN-gated router, same
 * tier as every other Outlet action. Returns null if this outlet has no Till configured yet. */
export async function getOutletMpesaSettings(outletId: string) {
  await getOutlet(outletId);
  return prisma.outletMpesaSettings.findUnique({ where: { outletId } });
}

export async function saveOutletMpesaSettings(outletId: string, input: unknown) {
  const parsed = outletMpesaSettingsSaveSchema.parse(input);
  await getOutlet(outletId);
  return prisma.outletMpesaSettings.upsert({
    where: { outletId },
    create: { outletId, ...parsed },
    update: parsed,
  });
}
