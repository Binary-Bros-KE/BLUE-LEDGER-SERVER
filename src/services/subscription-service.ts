import type { Plan, Subscription } from "@prisma/client";
import { HttpError, NotFoundError } from "../lib/http-error.js";
import { prisma } from "../prisma.js";
import { subscriptionUpdateSchema } from "../schemas/subscription.js";

/** SUPER_ADMIN only — enforced at the route layer. Changes the commercial arrangement in place;
 * SubscriptionPayment is the append-only ledger that preserves history, not this row. */
export async function updateSubscription(tenantId: string, input: unknown): Promise<Subscription & { plan: Plan }> {
  const parsed = subscriptionUpdateSchema.parse(input);
  const existing = await prisma.subscription.findUnique({ where: { tenantId } });
  if (!existing) {
    throw new NotFoundError("This tenant has no subscription");
  }

  if (parsed.planId) {
    const plan = await prisma.plan.findUnique({ where: { id: parsed.planId } });
    if (!plan) {
      throw new HttpError(400, "Selected plan was not found");
    }
  }

  const updated = await prisma.subscription.update({
    where: { tenantId },
    data: parsed,
    include: { plan: true },
  });
  return updated;
}
