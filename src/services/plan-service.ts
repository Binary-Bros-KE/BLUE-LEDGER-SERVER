import type { Plan } from "@prisma/client";
import type { AuthenticatedAccount } from "../middleware/auth.js";
import { ConflictError, HttpError, NotFoundError } from "../lib/http-error.js";
import { prisma } from "../prisma.js";
import { planCreateSchema, planUpdateSchema } from "../schemas/plan.js";

/** SUPER_ADMIN sees every plan, across every outlet; a MARKETER only sees their own outlet's
 * catalog — they need this list to pick a plan while creating a client, but never get a nav
 * tab/mutate rights (enforced at the route layer, see routes/plans.ts). */
export async function listPlans(actor: AuthenticatedAccount): Promise<Plan[]> {
  if (actor.role === "SUPER_ADMIN") {
    return prisma.plan.findMany({ orderBy: { createdAt: "desc" } });
  }
  return prisma.plan.findMany({
    where: { outletId: actor.outletId ?? "__no-outlet-assigned__" },
    orderBy: { createdAt: "desc" },
  });
}

async function findPlanRow(id: string): Promise<Plan | null> {
  return prisma.plan.findUnique({ where: { id } });
}

/** Unscoped — only ever called from create/update/delete, which are SUPER_ADMIN-only at the route
 * layer already. Never expose this to a plain GET /:id without scoping (see getPlanForActor). */
async function getPlanRow(id: string): Promise<Plan> {
  const plan = await findPlanRow(id);
  if (!plan) {
    throw new NotFoundError("Plan not found");
  }
  return plan;
}

/** Same boundary as listPlans, per-record — a MARKETER fetching another outlet's plan by id gets
 * 404, not 403 or a leaked price list. */
export async function getPlanForActor(id: string, actor: AuthenticatedAccount): Promise<Plan> {
  const plan = await findPlanRow(id);
  if (!plan || (actor.role !== "SUPER_ADMIN" && plan.outletId !== actor.outletId)) {
    throw new NotFoundError("Plan not found");
  }
  return plan;
}

/** Both roles can create — a MARKETER building out their own outlet's plan catalog is the actual
 * job, same reasoning as tenant creation. Their outletId is always forced to their own account's
 * outlet regardless of what the request body claims; only SUPER_ADMIN's submitted outletId is
 * trusted. Update/delete stay SUPER_ADMIN-only (enforced at the route layer) — a marketer can add a
 * new plan but not edit or retire an existing one. */
export async function createPlan(input: unknown, actor: AuthenticatedAccount): Promise<Plan> {
  const parsed = planCreateSchema.parse(input);
  const outletId = actor.role === "SUPER_ADMIN" ? parsed.outletId : actor.outletId;
  if (!outletId) {
    throw new HttpError(400, "No outlet is assigned to your account — contact a super admin");
  }
  const outlet = await prisma.outlet.findUnique({ where: { id: outletId } });
  if (!outlet) {
    throw new HttpError(400, "Selected outlet was not found");
  }
  return prisma.plan.create({ data: { ...parsed, outletId } });
}

export async function updatePlan(id: string, input: unknown): Promise<Plan> {
  const parsed = planUpdateSchema.parse(input);
  await getPlanRow(id);
  return prisma.plan.update({ where: { id }, data: parsed });
}

/** Blocked if any Subscription still references it — retire it (status: INACTIVE) instead of
 * deleting once it's actually been sold to someone. */
export async function deletePlan(id: string): Promise<void> {
  await getPlanRow(id);
  const subscriptionCount = await prisma.subscription.count({ where: { planId: id } });
  if (subscriptionCount > 0) {
    throw new ConflictError(
      `Can't delete — ${subscriptionCount} client(s) are subscribed to this plan. Set it to Inactive instead.`,
    );
  }
  await prisma.plan.delete({ where: { id } });
}
