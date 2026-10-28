import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { ConflictError, HttpError, NotFoundError } from "../lib/http-error.js";
import { ensureEmployeeMobileSequence, mintMobileDocumentNumber } from "../lib/mobile-numbering.js";
import { withTenantContext } from "../lib/tenant-context.js";
import type { MobileSession } from "../middleware/mobile-auth.js";
import { prisma } from "../prisma.js";
import {
  type MobileExpenseInput,
  mobileCreateExpenseCategorySchema,
  mobileCreateExpenseSchema,
  mobileExpenseInputSchema,
} from "../schemas/mobile.js";
import { OWNER_APP_DEVICE_ID } from "./mobile-checkout-service.js";

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
  /** Raw ids — pre-fill the Edit Expense sheet. */
  categoryId: string;
  paymentMethodId: string;
  storefrontId: string | null;
  paidBy: string | null;
  /** Set for an expense another action created (a purchase's shipping cost, a delivery cost). */
  sourceType: string | null;
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
      categoryId: expense.categoryId,
      paymentMethodId: expense.paymentMethodId,
      storefrontId: expense.storefrontId,
      paidBy: expense.paidBy,
      sourceType: expense.sourceType,
    }));
  });
}

// ---------------------------------------------------------------------------------------------
// Write actions — DESKTOP's own expense-service.ts createExpense / updateExpense / archiveExpense,
// same validation (category, storefront, active payment method + required reference, branch scope).
// Rows land in DESKTOP's exact shape, stamped deviceId "owner-app" with fresh localUpdatedAt AND
// syncedAt so DESKTOP's pull sees the change; expenses are conflict-aware on DESKTOP. A synced
// expense is never hard-deleted (DESKTOP's own rule) — "delete" here is always an archive.
// ---------------------------------------------------------------------------------------------

/** DESKTOP's generateExpenseNumber ("EXP", 6 digits) — "EXP-M3-000012" vs "EXP-D1-…". */
const EXPENSE_PREFIX = "EXP";
const EXPENSE_DIGITS = 6;

export type MobileExpenseCategory = { id: string; name: string };

export async function listExpenseCategories(tenantId: string): Promise<MobileExpenseCategory[]> {
  return withTenantContext(tenantId, (tx) =>
    tx.expenseCategory.findMany({ where: { tenantId, status: "active" }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
  );
}

export async function createExpenseCategory(tenantId: string, input: unknown): Promise<MobileExpenseCategory> {
  const { name } = mobileCreateExpenseCategorySchema.parse(input);
  const now = new Date();
  return withTenantContext(tenantId, async (tx) => {
    // expense_categories reconcile by name across devices (sync NATURAL_KEY_FIELDS) — a duplicate
    // name would just be merged into the existing one anyway, so refuse it up front.
    const duplicate = await tx.expenseCategory.findFirst({
      where: { tenantId, name: { equals: name, mode: "insensitive" } },
      select: { id: true },
    });
    if (duplicate) throw new ConflictError(`An expense category named "${name}" already exists`);
    return tx.expenseCategory.create({
      data: {
        id: `expense_category_${randomUUID()}`,
        tenantId,
        deviceId: OWNER_APP_DEVICE_ID,
        name,
        description: null,
        status: "active",
        localCreatedAt: now,
        localUpdatedAt: now,
      },
      select: { id: true, name: true },
    });
  });
}

/** DESKTOP's assertCategoryExists + assertStorefrontBelongsToTenant + assertValidPaymentMethod +
 * assertExpenseStorefrontAssignmentAllowed, in one place. */
async function validateExpenseInput(
  tx: Prisma.TransactionClient,
  tenantId: string,
  parsed: MobileExpenseInput,
  branchScope: string | null,
): Promise<void> {
  const [category, storefront, method] = await Promise.all([
    tx.expenseCategory.findUnique({ where: { id: parsed.categoryId }, select: { tenantId: true } }),
    tx.location.findUnique({ where: { id: parsed.storefrontId }, select: { tenantId: true } }),
    tx.paymentMethod.findUnique({ where: { id: parsed.paymentMethodId } }),
  ]);
  if (!category || category.tenantId !== tenantId) throw new NotFoundError("Expense category not found");
  if (!storefront || storefront.tenantId !== tenantId) throw new NotFoundError("Selected storefront was not found");
  if (branchScope && parsed.storefrontId !== branchScope) throw new HttpError(403, "You can only record expenses for your own storefront");
  if (!method || method.tenantId !== tenantId) throw new NotFoundError("Payment method not found");
  if (!method.isActive) throw new HttpError(400, `"${method.name}" is not active`);
  if (method.requiresReference && !parsed.reference) throw new HttpError(400, `${method.name} requires a transaction/reference number`);
}

async function loadActorScope(tx: Prisma.TransactionClient, session: MobileSession) {
  const actor = await tx.employee.findUniqueOrThrow({ where: { id: session.employeeId } });
  return {
    id: actor.id,
    // Same "First Last" DESKTOP's ExpenseFormModal records as Paid By.
    fullName: `${actor.firstName} ${actor.lastName}`.trim(),
    branchScope: session.isSuperAdmin ? null : actor.branchId,
    /** Assigned location, Super Admins included — they work AT it, like Checkout. */
    assignedLocationId: actor.branchId,
    mobileDeviceSequence: actor.mobileDeviceSequence,
  };
}

/** Someone assigned to a STOREFRONT (Super Admins included) books expenses there only — the same
 * fixed Storefront the app shows. Assigned to the Main Store (expenses never go there) = no limit. */
async function assertAssignedStorefront(tx: Prisma.TransactionClient, assignedLocationId: string | null, storefrontId: string): Promise<void> {
  if (!assignedLocationId || assignedLocationId === storefrontId) return;
  const assigned = await tx.location.findUnique({ where: { id: assignedLocationId }, select: { locationType: true } });
  if (assigned && assigned.locationType !== "distribution_center" && assigned.locationType !== "warehouse") {
    throw new HttpError(403, "Expenses can only be recorded for your own storefront");
  }
}

async function loadExpense(tx: Prisma.TransactionClient, tenantId: string, expenseId: string, branchScope: string | null) {
  const expense = await tx.expense.findUnique({ where: { id: expenseId } });
  if (!expense || expense.tenantId !== tenantId) throw new NotFoundError("Expense not found");
  if (branchScope && expense.storefrontId !== branchScope) throw new HttpError(403, "You can only manage expenses for your own storefront");
  return expense;
}

export async function createExpense(session: MobileSession, input: unknown): Promise<{ id: string; expenseNumber: string }> {
  const parsed = mobileCreateExpenseSchema.parse(input);
  const expenseId = parsed.id.startsWith("expense_") ? parsed.id : `expense_${parsed.id}`;
  const now = new Date();
  const { tenantId } = session;

  return withTenantContext(tenantId, async (tx) => {
    const existing = await tx.expense.findUnique({ where: { id: expenseId }, select: { id: true, expenseNumber: true } });
    if (existing) return existing;

    const actor = await loadActorScope(tx, session);
    await validateExpenseInput(tx, tenantId, parsed, actor.branchScope);
    await assertAssignedStorefront(tx, actor.assignedLocationId, parsed.storefrontId);
    const sequence = await ensureEmployeeMobileSequence(tx, tenantId, actor.id, actor.mobileDeviceSequence);
    const expenseNumber = await mintMobileDocumentNumber(tx, tenantId, sequence, EXPENSE_PREFIX, EXPENSE_DIGITS);

    await tx.expense.create({
      data: {
        id: expenseId,
        tenantId,
        deviceId: OWNER_APP_DEVICE_ID,
        kind: "general",
        expenseNumber,
        expenseDate: parsed.expenseDate,
        categoryId: parsed.categoryId,
        amountCents: parsed.amountCents,
        // Always whoever records it — never typed, same as DESKTOP (whatever the client sends is ignored).
        paidBy: actor.fullName || null,
        paymentMethodId: parsed.paymentMethodId,
        storefrontId: parsed.storefrontId,
        reference: parsed.reference,
        description: parsed.description,
        status: "active",
        isRecurring: false,
        localCreatedAt: now,
        localUpdatedAt: now,
      },
    });
    return { id: expenseId, expenseNumber };
  });
}

export async function updateExpense(session: MobileSession, expenseId: string, input: unknown): Promise<{ id: string }> {
  const parsed = mobileExpenseInputSchema.parse(input);
  const now = new Date();
  const { tenantId } = session;

  return withTenantContext(tenantId, async (tx) => {
    const actor = await loadActorScope(tx, session);
    const existing = await loadExpense(tx, tenantId, expenseId, actor.branchScope);
    if (existing.status === "archived") throw new HttpError(400, "Archived expenses can't be edited — restore it first");
    await validateExpenseInput(tx, tenantId, parsed, actor.branchScope);
    // An expense never moves storefront when the editor works at a fixed one.
    if (parsed.storefrontId !== existing.storefrontId) await assertAssignedStorefront(tx, actor.assignedLocationId, parsed.storefrontId);

    await tx.expense.update({
      where: { id: expenseId },
      data: {
        expenseDate: parsed.expenseDate,
        categoryId: parsed.categoryId,
        amountCents: parsed.amountCents,
        // Paid By is left as originally recorded — editing later isn't making the payment (DESKTOP).
        paymentMethodId: parsed.paymentMethodId,
        storefrontId: parsed.storefrontId,
        reference: parsed.reference,
        description: parsed.description,
        deviceId: OWNER_APP_DEVICE_ID,
        localUpdatedAt: now,
        syncedAt: now,
      },
    });
    return { id: expenseId };
  });
}

/** DESKTOP's archiveExpense — the only removal once a record exists in the cloud. */
export async function archiveExpense(session: MobileSession, expenseId: string): Promise<{ id: string }> {
  const now = new Date();
  return withTenantContext(session.tenantId, async (tx) => {
    const actor = await loadActorScope(tx, session);
    await loadExpense(tx, session.tenantId, expenseId, actor.branchScope);
    await tx.expense.update({
      where: { id: expenseId },
      data: { status: "archived", deviceId: OWNER_APP_DEVICE_ID, localUpdatedAt: now, syncedAt: now },
    });
    return { id: expenseId };
  });
}
