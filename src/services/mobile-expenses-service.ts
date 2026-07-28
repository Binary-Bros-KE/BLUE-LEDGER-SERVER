import { withTenantContext } from "../lib/tenant-context.js";
import { prisma } from "../prisma.js";

export type MobileExpenseListItem = {
  id: string;
  expenseNumber: string;
  expenseDate: string;
  categoryName: string;
  amountCents: number;
  paymentMethodName: string | null;
  locationName: string;
  reference: string | null;
  description: string | null;
  status: string;
  currency: string;
};

/** Expense is a flat single-payment record with no line items or payment history (unlike Sale/
 * Purchase) — so unlike those, there's no separate "view more" fetch: this list item already
 * carries everything the detail view needs, the modal just renders the row already in hand. No PDF/
 * download/share capability exists for Expenses either (same as Purchases). */
export async function listExpenses(tenantId: string, locationId: string | null): Promise<MobileExpenseListItem[]> {
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { currency: true } });

  return withTenantContext(tenantId, async (tx) => {
    const expenses = await tx.expense.findMany({
      where: {
        tenantId,
        status: "active",
        // General expenses (no storefront) always count regardless of the active filter, matching
        // DESKTOP's own established convention (findExpenseTotalCentsInRange).
        ...(locationId ? { OR: [{ storefrontId: locationId }, { storefrontId: null }] } : {}),
      },
      orderBy: { expenseDate: "desc" },
      take: 200,
    });

    const categoryIds = [...new Set(expenses.map((e) => e.categoryId))];
    const paymentMethodIds = [...new Set(expenses.map((e) => e.paymentMethodId))];
    const [categories, paymentMethods, locations] = await Promise.all([
      tx.expenseCategory.findMany({ where: { id: { in: categoryIds } }, select: { id: true, name: true } }),
      tx.paymentMethod.findMany({ where: { id: { in: paymentMethodIds } }, select: { id: true, name: true } }),
      tx.location.findMany({ where: { tenantId }, select: { id: true, locationName: true } }),
    ]);
    const categoryNameById = new Map(categories.map((c) => [c.id, c.name]));
    const paymentMethodNameById = new Map(paymentMethods.map((p) => [p.id, p.name]));
    const locationNameById = new Map(locations.map((l) => [l.id, l.locationName]));

    return expenses.map((expense) => ({
      id: expense.id,
      expenseNumber: expense.expenseNumber,
      expenseDate: expense.expenseDate,
      categoryName: categoryNameById.get(expense.categoryId) ?? "—",
      amountCents: expense.amountCents,
      paymentMethodName: paymentMethodNameById.get(expense.paymentMethodId) ?? null,
      locationName: expense.storefrontId ? (locationNameById.get(expense.storefrontId) ?? "—") : "General",
      reference: expense.reference,
      description: expense.description,
      status: expense.status,
      currency: tenant.currency,
    }));
  });
}
