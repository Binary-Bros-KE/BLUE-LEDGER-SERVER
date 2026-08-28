import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { NotFoundError } from "./http-error.js";
import { mintMobileDocumentNumber } from "./mobile-numbering.js";

/** Matches DESKTOP's own delivery-note-service.ts generateDeliveryNoteNumber exactly ("DN", 6
 * digits). */
const DELIVERY_NOTE_PREFIX = "DN";
const DELIVERY_NOTE_DIGITS = 6;

/** Matches DESKTOP's own expense-service.ts generateExpenseNumber exactly ("EXP", 6 digits). */
const EXPENSE_PREFIX = "EXP";
const EXPENSE_DIGITS = 6;

/** Deliberately a plain constant, not tenant-configurable — mirrors DESKTOP's own
 * expense-service.ts DELIVERY_COST_CATEGORY_NAME verbatim, so a delivery cost recorded from either
 * device always lands in the SAME category, never two differently-named ones per origin. */
const DELIVERY_COST_CATEGORY_NAME = "Delivery Costs";

export type MobileDeliveryInput = {
  riderId?: string;
  recipientName: string;
  country: string;
  town: string;
  physicalAddress: string;
  notes: string;
  feeCents: number;
  costCents: number;
};

/** Embedded JSON snapshot, not a separate synced table — mirrors SERVER's own Sale.delivery/
 * Quotation.delivery column doc comments exactly (the shape DESKTOP's push already flattens its
 * local delivery_notes row into). Validates the rider (if given) and mints a real DN number — shared
 * by checkout, invoice create/update, and quotation create/update so all four never disagree on the
 * shape or numbering scheme. Returns riderName too, since createDeliveryCostExpenseIfNeeded below
 * (and the caller's own document) both want it without a second lookup. */
export async function buildDeliveryJson(
  tx: Prisma.TransactionClient,
  tenantId: string,
  mobileDeviceSequence: number,
  delivery: MobileDeliveryInput | undefined,
  now: Date,
): Promise<{ json: Prisma.InputJsonValue | null; riderName: string | null }> {
  if (!delivery) return { json: null, riderName: null };

  let riderName: string | null = null;
  if (delivery.riderId) {
    const rider = await tx.rider.findUnique({ where: { id: delivery.riderId } });
    if (!rider || rider.tenantId !== tenantId || rider.status !== "active") throw new NotFoundError("Selected rider was not found");
    riderName = rider.name;
  }

  const deliveryNoteNumber = await mintMobileDocumentNumber(tx, tenantId, mobileDeviceSequence, DELIVERY_NOTE_PREFIX, DELIVERY_NOTE_DIGITS);
  return {
    json: {
      id: randomUUID(),
      deliveryNoteNumber,
      riderId: delivery.riderId ?? null,
      recipientName: delivery.recipientName,
      country: delivery.country,
      town: delivery.town,
      physicalAddress: delivery.physicalAddress,
      notes: delivery.notes,
      feeCents: delivery.feeCents,
      costCents: delivery.costCents,
      isDelivered: false,
      deliveredAt: null,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    },
    riderName,
  };
}

/** Mirrors DESKTOP's own expense-service.ts resolveDeliveryExpensePaymentMethodId verbatim: falls
 * back to the tenant's "Cash" payment method (how a delivery cost — paid to a rider/courier, out of
 * pocket — is almost always actually settled), then to whatever active payment method exists at all,
 * for the cases createDeliveryCostExpenseIfNeeded has no document payment to go on (an invoice with
 * no payment yet, a quotation-to-invoice conversion, duplicateInvoice). Every tenant has "Cash"
 * seeded at bootstrap, so the final `null` should never actually happen in practice. */
async function resolveDeliveryExpensePaymentMethodId(
  tx: Prisma.TransactionClient,
  tenantId: string,
  paymentMethodId: string | null,
): Promise<string | null> {
  if (paymentMethodId) return paymentMethodId;
  const cash = await tx.paymentMethod.findFirst({ where: { tenantId, code: "CASH", isActive: true } });
  if (cash) return cash.id;
  const anyActive = await tx.paymentMethod.findFirst({ where: { tenantId, isActive: true }, orderBy: { sortOrder: "asc" } });
  return anyActive?.id ?? null;
}

/** Mirrors DESKTOP's own expense-service.ts createDeliveryCostExpenseIfNeeded verbatim: a
 * delivery's costCents (what THIS shop paid the rider/courier, distinct from feeCents — what the
 * CUSTOMER paid, already folded into the document's own grand total) auto-creates a real Expense
 * record. Books UNCONDITIONALLY once there's a real cost, regardless of the invoice's own payment
 * status — a deliberate client decision: recording a delivery cost means money has already gone out
 * the moment it's recorded, whether or not the customer has paid the invoice yet. Falls back via
 * resolveDeliveryExpensePaymentMethodId when the document itself has no payment method to point to.
 * A quotation never calls this at all (nothing has shipped yet), matching DESKTOP's own
 * quotation-service.ts — the cost only becomes a real expense once/if the quotation converts. */
export async function createDeliveryCostExpenseIfNeeded(
  tx: Prisma.TransactionClient,
  tenantId: string,
  deviceId: string,
  mobileDeviceSequence: number,
  params: {
    documentNumber: string;
    customerName: string | null;
    delivery: MobileDeliveryInput;
    riderName: string | null;
    locationId: string;
    paymentMethodId: string | null;
    now: Date;
  },
): Promise<void> {
  if (params.delivery.costCents <= 0) return;
  const paymentMethodId = await resolveDeliveryExpensePaymentMethodId(tx, tenantId, params.paymentMethodId);
  if (!paymentMethodId) return;

  let category = await tx.expenseCategory.findFirst({ where: { tenantId, name: DELIVERY_COST_CATEGORY_NAME } });
  if (!category) {
    category = await tx.expenseCategory.create({
      data: {
        id: `expense_category_${randomUUID()}`,
        tenantId,
        deviceId,
        name: DELIVERY_COST_CATEGORY_NAME,
        description: null,
        status: "active",
        localCreatedAt: params.now,
        localUpdatedAt: params.now,
      },
    });
  }

  const expenseNumber = await mintMobileDocumentNumber(tx, tenantId, mobileDeviceSequence, EXPENSE_PREFIX, EXPENSE_DIGITS);
  const descriptionLines = [
    `Sale: ${params.documentNumber}`,
    `Customer: ${params.customerName ?? "Walk-in Customer"}`,
    `Delivered To: ${params.delivery.recipientName}`,
  ];
  const addressParts = [params.delivery.physicalAddress, params.delivery.town, params.delivery.country].filter(Boolean);
  if (addressParts.length > 0) descriptionLines.push(`Address: ${addressParts.join(", ")}`);
  if (params.riderName) descriptionLines.push(`Rider: ${params.riderName}`);
  if (params.delivery.notes) descriptionLines.push(`Notes: ${params.delivery.notes}`);

  await tx.expense.create({
    data: {
      id: `expense_${randomUUID()}`,
      tenantId,
      deviceId,
      kind: "general",
      expenseNumber,
      expenseDate: params.now.toISOString().slice(0, 10),
      categoryId: category.id,
      amountCents: params.delivery.costCents,
      paidBy: null,
      paymentMethodId,
      storefrontId: params.locationId,
      reference: null,
      description: descriptionLines.join("\n"),
      status: "active",
      isRecurring: false,
      recurrenceFrequency: null,
      nextDueDate: null,
      lastReminderSent: null,
      localCreatedAt: params.now,
      localUpdatedAt: params.now,
    },
  });
}
