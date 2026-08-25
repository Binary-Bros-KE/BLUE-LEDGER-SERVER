import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { HttpError, NotFoundError } from "../lib/http-error.js";
import { buildServiceCharges, type MobileServiceChargeInput, prepareMobileCart, sumServiceChargeFees } from "../lib/mobile-cart.js";
import { buildDeliveryJson, createDeliveryCostExpenseIfNeeded } from "../lib/mobile-delivery.js";
import { ensureEmployeeMobileSequence, mintMobileDocumentNumber } from "../lib/mobile-numbering.js";
import type { TenantTaxConfig } from "../lib/tax-breakdown.js";
import { withTenantContext } from "../lib/tenant-context.js";
import {
  type MobileInvoiceInput,
  mobileInvoiceSchema,
  type MobileMarkPaidInput,
  mobileMarkPaidSchema,
  type MobileRecordPaymentInput,
  mobileRecordPaymentSchema,
} from "../schemas/mobile.js";
import { computePaymentStatus } from "./share-service.js";
import { OWNER_APP_DEVICE_ID, resolveMobileLocation } from "./mobile-checkout-service.js";

/** Matches DESKTOP's own invoice-service.ts prefix exactly ("INV", 6 digits). */
const INVOICE_PREFIX = "INV";
const INVOICE_DIGITS = 6;

export type MobileInvoiceResult = { id: string };

type SalePayment = {
  id: string;
  paymentMethodId: string;
  paymentMethodName: string;
  amountCents: number;
  reference: string | null;
  receivedBy: string;
  receivedByName: string;
  receivedAt: string;
  notes: string | null;
};

async function requireActivePaymentMethod(
  tx: Prisma.TransactionClient,
  tenantId: string,
  paymentMethodId: string,
): Promise<{ id: string; name: string; requiresReference: boolean }> {
  const method = await tx.paymentMethod.findUnique({ where: { id: paymentMethodId } });
  if (!method || method.tenantId !== tenantId) throw new NotFoundError("Payment method not found");
  if (!method.isActive) throw new HttpError(400, `"${method.name}" is not active`);
  return { id: method.id, name: method.name, requiresReference: method.requiresReference };
}

async function requireInvoiceRow(tx: Prisma.TransactionClient, tenantId: string, id: string) {
  const row = await tx.sale.findUnique({ where: { id } });
  if (!row || row.tenantId !== tenantId) throw new NotFoundError("Invoice not found");
  if (!row.invoiceNumber) throw new HttpError(400, "This sale is not an invoice");
  return row;
}

/** Restocks every stock-tracked, non-locally-sourced item on an invoice — shared by updateInvoice
 * (restock-then-rededuct), cancelInvoice (self-approved direct cancel), and approveInvoiceCancel
 * (manager-approved cancel). A locally-sourced or untracked item was never actually deducted from
 * inventory at insert time, so crediting it back here would fabricate stock that was never taken —
 * matches DESKTOP's own restockAndMarkCancelled condition exactly. */
async function restockInvoiceItems(
  tx: Prisma.TransactionClient,
  tenantId: string,
  employeeId: string,
  items: Array<{ productId: string; quantity: number; isLocallySourced: boolean }>,
  locationId: string,
  referenceType: string,
  referenceId: string,
  now: Date,
): Promise<void> {
  const restockRows = items.filter((item) => !item.isLocallySourced);
  if (restockRows.length === 0) return;

  const trackedProducts = await tx.product.findMany({
    where: { id: { in: restockRows.map((i) => i.productId) }, trackStock: true },
    select: { id: true },
  });
  const trackedIds = new Set(trackedProducts.map((p) => p.id));
  const restockMovements = restockRows.filter((item) => trackedIds.has(item.productId));
  if (restockMovements.length === 0) return;

  await tx.stockMovement.createMany({
    data: restockMovements.map((item) => ({
      id: randomUUID(),
      tenantId,
      deviceId: OWNER_APP_DEVICE_ID,
      productId: item.productId,
      locationId,
      movementType: "return",
      quantityChange: item.quantity,
      referenceType,
      referenceId,
      performedBy: employeeId,
      allocationExplicit: false,
      localCreatedAt: now,
      localUpdatedAt: now,
    })),
  });
}

/** Creates a new invoice — goods/services are considered delivered now, payment can follow over
 * time. Mirrors DESKTOP's own invoice-service.ts createInvoice/insertInvoiceFromCart: real
 * server-side cart preparation (prepareMobileCart), immediate stock deduction (same
 * trackStock && !isLocallySourced condition as checkout), an optional initial payment, and the same
 * delivery-cost-expense side effect checkout has. */
export async function createInvoice(tenantId: string, employeeId: string, input: unknown): Promise<MobileInvoiceResult> {
  const parsed: MobileInvoiceInput = mobileInvoiceSchema.parse(input);

  return withTenantContext(
    tenantId,
    async (tx) => {
      const [tenant, employee, customer] = await Promise.all([
        tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { vatRatePercent: true, pricesTaxInclusive: true } }),
        tx.employee.findUniqueOrThrow({ where: { id: employeeId } }),
        tx.customer.findUnique({ where: { id: parsed.customerId } }),
      ]);
      if (!customer || customer.tenantId !== tenantId) throw new NotFoundError("Customer not found");

      const locationId = await resolveMobileLocation(tx, tenantId, employee.branchId, parsed.locationId);
      const tenantTaxConfig: TenantTaxConfig = { vatRatePercent: tenant.vatRatePercent, pricesTaxInclusive: tenant.pricesTaxInclusive };
      const cart = await prepareMobileCart(tx, tenantId, locationId, parsed.items, tenantTaxConfig, { checkStock: true });

      const deliveryFeeCents = parsed.delivery?.feeCents ?? 0;
      const serviceChargeFeeCents = sumServiceChargeFees(parsed.serviceCharges);
      const grandTotalCents = cart.grandTotalCents + deliveryFeeCents + serviceChargeFeeCents;

      let payments: SalePayment[] = [];
      let amountPaidCents = 0;
      const now = new Date();

      if (parsed.initialPayment) {
        const method = await requireActivePaymentMethod(tx, tenantId, parsed.initialPayment.paymentMethodId);
        if (method.requiresReference && !parsed.initialPayment.reference?.trim()) {
          throw new HttpError(400, `${method.name} requires a reference number`);
        }
        if (parsed.initialPayment.amountCents > grandTotalCents) {
          throw new HttpError(400, "The initial payment can't exceed the invoice total");
        }
        amountPaidCents = parsed.initialPayment.amountCents;
        payments = [
          {
            id: `payment_${randomUUID()}`,
            paymentMethodId: method.id,
            paymentMethodName: method.name,
            amountCents: amountPaidCents,
            reference: parsed.initialPayment.reference?.trim() || null,
            receivedBy: employeeId,
            receivedByName: `${employee.firstName} ${employee.lastName}`.trim(),
            receivedAt: now.toISOString(),
            notes: null,
          },
        ];
      }

      const balanceDueCents = grandTotalCents - amountPaidCents;
      // Credit limit is a record-keeping field only, by explicit product decision — see DESKTOP's own
      // insertInvoiceFromCart doc comment (a tester lost real form progress once when this blocked).
      const paymentStatus = computePaymentStatus({ balanceDueCents, amountPaidCents, dueDate: parsed.dueDate, cancelled: false });

      const mobileDeviceSequence = await ensureEmployeeMobileSequence(tx, tenantId, employeeId, employee.mobileDeviceSequence);
      const invoiceNumber = await mintMobileDocumentNumber(tx, tenantId, mobileDeviceSequence, INVOICE_PREFIX, INVOICE_DIGITS);
      const { json: deliveryJson, riderName } = await buildDeliveryJson(tx, tenantId, mobileDeviceSequence, parsed.delivery, now);
      const preparedServiceCharges = buildServiceCharges(parsed.serviceCharges, now);

      const saleId = `sale_${randomUUID()}`;
      await tx.sale.create({
        data: {
          id: saleId,
          tenantId,
          deviceId: OWNER_APP_DEVICE_ID,
          receiptNumber: null,
          locationId,
          employeeId,
          customerId: parsed.customerId,
          saleStatus: "completed",
          subtotalCents: cart.subtotalCents,
          discountAmountCents: cart.discountAmountCents,
          taxAmountCents: cart.taxAmountCents,
          grandTotalCents,
          paymentMethodId: null,
          paymentReference: null,
          amountReceivedCents: null,
          changeGivenCents: null,
          notes: null,
          completedAt: null,
          transactionType: parsed.transactionType,
          paymentStatus,
          invoiceNumber,
          invoiceDate: now.toISOString(),
          dueDate: parsed.dueDate,
          amountPaidCents,
          balanceDueCents,
          invoiceNotes: parsed.invoiceNotes?.trim() || null,
          includeTaxBreakdown: parsed.includeTaxBreakdown,
          payments,
          items: cart.items,
          serviceCharges: preparedServiceCharges,
          delivery: deliveryJson ?? Prisma.JsonNull,
          localCreatedAt: now,
          localUpdatedAt: now,
        },
      });

      if (cart.stockMovementRows.length > 0) {
        await tx.stockMovement.createMany({
          data: cart.stockMovementRows.map((movement) => ({
            id: movement.id,
            tenantId,
            deviceId: OWNER_APP_DEVICE_ID,
            productId: movement.productId,
            locationId,
            movementType: "sale",
            quantityChange: movement.quantityChange,
            referenceType: "invoice",
            referenceId: saleId,
            performedBy: employeeId,
            allocationExplicit: false,
            localCreatedAt: now,
            localUpdatedAt: now,
          })),
        });
      }

      if (parsed.delivery) {
        await createDeliveryCostExpenseIfNeeded(tx, tenantId, OWNER_APP_DEVICE_ID, mobileDeviceSequence, {
          documentNumber: invoiceNumber,
          customerName: customer.name,
          delivery: parsed.delivery,
          riderName,
          locationId,
          paymentMethodId: parsed.initialPayment?.paymentMethodId ?? null,
          now,
        });
      }

      return { id: saleId };
    },
    { timeoutMs: 15_000 },
  );
}

export type MobileEditableItem = {
  productId: string;
  quantity: number;
  unitPriceCents: number;
  discountAmountCents: number;
  isLocallySourced: boolean;
  localCostCents: number | null;
  localSupplierId: string | null;
};

export type MobileEditableDelivery = {
  riderId: string | null;
  recipientName: string;
  country: string;
  town: string;
  physicalAddress: string;
  notes: string;
  feeCents: number;
  costCents: number;
};

export type MobileInvoiceEditData = {
  customerId: string;
  transactionType: string;
  dueDate: string;
  invoiceNotes: string | null;
  includeTaxBreakdown: boolean;
  items: MobileEditableItem[];
  delivery: MobileEditableDelivery | null;
  serviceCharges: MobileServiceChargeInput[];
};

/** Raw, re-editable form of an invoice — deliberately NOT the same view-model SharedDocument/
 * buildSharedDocument produces (that's a DISPLAY shape: no productId, no taxType, no
 * isLocallySourced/localSupplierId — everything a re-edit needs to rebuild items[] for
 * updateInvoice's own mobileInvoiceSchema). Only returned for an invoice that's actually still
 * editable (matches updateInvoice's own requireEditableUnpaidInvoice check) — APP hides its Edit
 * button in this same case, so reaching here with an ineligible invoice would mean the UI and the
 * server disagree about state, not a normal path. */
export async function getInvoiceEditData(tenantId: string, id: string): Promise<MobileInvoiceEditData> {
  return withTenantContext(tenantId, async (tx) => {
    const row = await requireInvoiceRow(tx, tenantId, id);
    if (row.paymentStatus === "cancelled") throw new HttpError(400, "This invoice has been cancelled");
    if (row.amountPaidCents > 0) throw new HttpError(400, "This invoice has payments recorded against it and can no longer be edited");
    if (!row.customerId) throw new HttpError(400, "This invoice has no customer on record");

    const items = row.items as unknown as MobileEditableItem[];
    const delivery = row.delivery as unknown as (MobileEditableDelivery & { [key: string]: unknown }) | null;
    const serviceCharges = row.serviceCharges as unknown as Array<MobileServiceChargeInput & { id: string; createdAt: string }>;

    return {
      customerId: row.customerId,
      transactionType: row.transactionType,
      dueDate: row.dueDate ?? "",
      invoiceNotes: row.invoiceNotes,
      includeTaxBreakdown: row.includeTaxBreakdown,
      serviceCharges: serviceCharges.map((charge) => ({ name: charge.name, feeCents: charge.feeCents, costCents: charge.costCents })),
      items: items.map((item) => ({
        productId: item.productId,
        quantity: item.quantity,
        unitPriceCents: item.unitPriceCents,
        discountAmountCents: item.discountAmountCents,
        isLocallySourced: item.isLocallySourced,
        localCostCents: item.localCostCents,
        localSupplierId: item.localSupplierId,
      })),
      delivery: delivery
        ? {
            riderId: delivery.riderId,
            recipientName: delivery.recipientName,
            country: delivery.country,
            town: delivery.town,
            physicalAddress: delivery.physicalAddress,
            notes: delivery.notes,
            feeCents: delivery.feeCents,
            costCents: delivery.costCents,
          }
        : null,
    };
  });
}

/** A fully unpaid invoice can be freely re-priced/re-itemized from live product data — same
 * "nothing committed yet" reasoning as a draft quotation, except an invoice's own commitment line is
 * "has any payment been recorded" rather than a status field. Restocks every existing line first,
 * then re-deducts the new cart — same net effect as diffing old vs new quantities, matching
 * DESKTOP's own updateInvoice exactly. The invoice's own storefront is fixed at creation. */
export async function updateInvoice(tenantId: string, employeeId: string, id: string, input: unknown): Promise<MobileInvoiceResult> {
  const parsed: MobileInvoiceInput = mobileInvoiceSchema.parse(input);

  return withTenantContext(
    tenantId,
    async (tx) => {
      const row = await requireInvoiceRow(tx, tenantId, id);
      if (row.paymentStatus === "cancelled") throw new HttpError(400, "This invoice has been cancelled");
      if (row.amountPaidCents > 0) throw new HttpError(400, "This invoice has payments recorded against it and can no longer be edited");

      const [tenant, customer] = await Promise.all([
        tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { vatRatePercent: true, pricesTaxInclusive: true } }),
        tx.customer.findUnique({ where: { id: parsed.customerId } }),
      ]);
      if (!customer || customer.tenantId !== tenantId) throw new NotFoundError("Customer not found");

      const tenantTaxConfig: TenantTaxConfig = { vatRatePercent: tenant.vatRatePercent, pricesTaxInclusive: tenant.pricesTaxInclusive };
      const cart = await prepareMobileCart(tx, tenantId, row.locationId, parsed.items, tenantTaxConfig, { checkStock: false });
      const deliveryFeeCents = parsed.delivery?.feeCents ?? 0;
      const serviceChargeFeeCents = sumServiceChargeFees(parsed.serviceCharges);
      const grandTotalCents = cart.grandTotalCents + deliveryFeeCents + serviceChargeFeeCents;
      const paymentStatus = computePaymentStatus({ balanceDueCents: grandTotalCents, amountPaidCents: 0, dueDate: parsed.dueDate, cancelled: false });
      const now = new Date();

      // Restock every existing (stock-tracked, non-locally-sourced) line first — same restock
      // condition insertInvoiceFromCart's own deduction uses — then re-deduct the NEW cart. Both
      // happen in the SAME transaction, so a new cart that needs more stock than's available throws
      // and the whole edit rolls back with nothing left half-adjusted, matching DESKTOP exactly.
      const existingItems = row.items as unknown as Array<{ productId: string; quantity: number; isLocallySourced: boolean }>;
      await restockInvoiceItems(tx, tenantId, employeeId, existingItems, row.locationId, "invoice_edit", id, now);

      const mobileDeviceSequence = await ensureEmployeeMobileSequence(tx, tenantId, employeeId, (await tx.employee.findUniqueOrThrow({ where: { id: employeeId } })).mobileDeviceSequence);
      const { json: deliveryJson } = await buildDeliveryJson(tx, tenantId, mobileDeviceSequence, parsed.delivery, now);
      const preparedServiceCharges = buildServiceCharges(parsed.serviceCharges, now);

      await tx.sale.update({
        where: { id },
        data: {
          customerId: parsed.customerId,
          transactionType: parsed.transactionType,
          dueDate: parsed.dueDate,
          subtotalCents: cart.subtotalCents,
          discountAmountCents: cart.discountAmountCents,
          taxAmountCents: cart.taxAmountCents,
          grandTotalCents,
          balanceDueCents: grandTotalCents,
          paymentStatus,
          invoiceNotes: parsed.invoiceNotes?.trim() || null,
          includeTaxBreakdown: parsed.includeTaxBreakdown,
          items: cart.items,
          serviceCharges: preparedServiceCharges,
          delivery: deliveryJson ?? Prisma.JsonNull,
          localUpdatedAt: now,
        },
      });

      // Re-check stock for the NEW cart now that old items are restocked (checkStock:false above was
      // deliberate — the restock above must land first so the new cart is validated against
      // post-restock availability, not pre-restock).
      const revalidated = await prepareMobileCart(tx, tenantId, row.locationId, parsed.items, tenantTaxConfig, { checkStock: true });
      if (revalidated.stockMovementRows.length > 0) {
        await tx.stockMovement.createMany({
          data: revalidated.stockMovementRows.map((movement) => ({
            id: movement.id,
            tenantId,
            deviceId: OWNER_APP_DEVICE_ID,
            productId: movement.productId,
            locationId: row.locationId,
            movementType: "sale",
            quantityChange: movement.quantityChange,
            referenceType: "invoice",
            referenceId: id,
            performedBy: employeeId,
            allocationExplicit: false,
            localCreatedAt: now,
            localUpdatedAt: now,
          })),
        });
      }

      return { id };
    },
    { timeoutMs: 15_000 },
  );
}

async function applyPayment(
  tx: Prisma.TransactionClient,
  tenantId: string,
  employeeId: string,
  saleId: string,
  payment: { paymentMethodId: string; amountCents: number; reference: string | null; notes: string | null },
): Promise<MobileInvoiceResult> {
  const row = await requireInvoiceRow(tx, tenantId, saleId);
  if (row.paymentStatus === "cancelled") throw new HttpError(400, "This invoice has been cancelled");
  if (row.balanceDueCents <= 0) throw new HttpError(400, "This invoice is already fully paid");
  if (payment.amountCents > row.balanceDueCents) {
    throw new HttpError(400, `Amount exceeds the outstanding balance of ${(row.balanceDueCents / 100).toFixed(2)}`);
  }

  const method = await requireActivePaymentMethod(tx, tenantId, payment.paymentMethodId);
  if (method.requiresReference && !payment.reference) {
    throw new HttpError(400, `${method.name} requires a reference number`);
  }

  const employee = await tx.employee.findUniqueOrThrow({ where: { id: employeeId } });
  const existingPayments = row.payments as unknown as SalePayment[];
  const now = new Date();
  const newPayment: SalePayment = {
    id: `payment_${randomUUID()}`,
    paymentMethodId: method.id,
    paymentMethodName: method.name,
    amountCents: payment.amountCents,
    reference: payment.reference,
    receivedBy: employeeId,
    receivedByName: `${employee.firstName} ${employee.lastName}`.trim(),
    receivedAt: now.toISOString(),
    notes: payment.notes,
  };
  const payments = [...existingPayments, newPayment];

  const amountPaidCents = payments.reduce((sum, entry) => sum + entry.amountCents, 0);
  const balanceDueCents = row.grandTotalCents - amountPaidCents;
  const paymentStatus = computePaymentStatus({ balanceDueCents, amountPaidCents, dueDate: row.dueDate, cancelled: false });

  await tx.sale.update({
    where: { id: saleId },
    data: { payments, amountPaidCents, balanceDueCents, paymentStatus, localUpdatedAt: now },
  });

  return { id: saleId };
}

/** Appends a payment to the invoice's history and recalculates the outstanding balance and status. */
export async function recordPayment(tenantId: string, employeeId: string, saleId: string, input: unknown): Promise<MobileInvoiceResult> {
  const parsed: MobileRecordPaymentInput = mobileRecordPaymentSchema.parse(input);
  return withTenantContext(tenantId, (tx) =>
    applyPayment(tx, tenantId, employeeId, saleId, {
      paymentMethodId: parsed.paymentMethodId,
      amountCents: parsed.amountCents,
      reference: parsed.reference?.trim() || null,
      notes: parsed.notes?.trim() || null,
    }),
  );
}

/** Records a final payment for the exact remaining balance, keeping the payment ledger complete. */
export async function markPaid(tenantId: string, employeeId: string, saleId: string, input: unknown): Promise<MobileInvoiceResult> {
  const parsed: MobileMarkPaidInput = mobileMarkPaidSchema.parse(input);
  return withTenantContext(tenantId, async (tx) => {
    const row = await requireInvoiceRow(tx, tenantId, saleId);
    return applyPayment(tx, tenantId, employeeId, saleId, {
      paymentMethodId: parsed.paymentMethodId,
      amountCents: row.balanceDueCents,
      reference: parsed.reference?.trim() || null,
      notes: parsed.notes?.trim() || null,
    });
  });
}

/** Creates a fresh unpaid invoice with the same customer, items, and terms — for recurring billing.
 * No storefront prompt needed even for a branch-less employee — the duplicate belongs at the SAME
 * storefront as the original, matching DESKTOP's own duplicateInvoice exactly. */
export async function duplicateInvoice(tenantId: string, employeeId: string, saleId: string): Promise<MobileInvoiceResult> {
  return withTenantContext(
    tenantId,
    async (tx) => {
      const original = await requireInvoiceRow(tx, tenantId, saleId);
      if (!original.customerId) throw new HttpError(400, "The original invoice has no customer to bill");

      const termDays =
        original.invoiceDate && original.dueDate
          ? Math.round((new Date(original.dueDate).getTime() - new Date(original.invoiceDate).getTime()) / 86_400_000)
          : 30;
      const newInvoiceDate = new Date();
      const newDueDate = new Date(newInvoiceDate);
      newDueDate.setDate(newDueDate.getDate() + (termDays > 0 ? termDays : 30));

      const originalItems = original.items as unknown as Array<{
        productId: string;
        quantity: number;
        unitPriceCents: number;
        discountAmountCents: number;
        isLocallySourced: boolean;
        localCostCents: number | null;
        localSupplierId: string | null;
      }>;
      const originalServiceCharges = original.serviceCharges as unknown as MobileServiceChargeInput[];

      return createInvoice(tenantId, employeeId, {
        customerId: original.customerId,
        transactionType: original.transactionType,
        dueDate: newDueDate.toISOString().slice(0, 10),
        invoiceNotes: original.invoiceNotes ?? undefined,
        includeTaxBreakdown: original.includeTaxBreakdown,
        // Carried over from the original, not re-decided — same reasoning as DESKTOP's own
        // duplicateInvoice: without pinning unitPriceCents, prepareMobileCart would silently re-price
        // every line from the product's CURRENT price instead of the original invoice's price.
        items: originalItems.map((item) => ({
          productId: item.productId,
          quantity: item.quantity,
          discountAmountCents: item.discountAmountCents,
          unitPriceCents: item.unitPriceCents,
          isLocallySourced: item.isLocallySourced,
          localCostCents: item.localCostCents ?? undefined,
          localSupplierId: item.localSupplierId ?? undefined,
        })),
        initialPayment: null,
        serviceCharges: originalServiceCharges.map((charge) => ({ name: charge.name, feeCents: charge.feeCents, costCents: charge.costCents })),
        locationId: original.locationId,
      });
    },
    { timeoutMs: 15_000 },
  );
}

const PENDING_APPROVAL = "pending_approval";

async function assertNoPendingCancellation(tx: Prisma.TransactionClient, tenantId: string, saleId: string): Promise<void> {
  const pending = await tx.invoiceCancellation.findFirst({ where: { tenantId, saleId, status: PENDING_APPROVAL } });
  if (pending) throw new HttpError(400, "This invoice already has a cancellation request awaiting approval");
}

/** The "Cancel Invoice" button — self-approved, effective immediately. Still creates a real
 * invoice_cancellations row (status inserted straight as "approved") rather than skipping the table
 * entirely, matching DESKTOP's own cancelInvoiceDirect — this and requestInvoiceCancel/
 * approveInvoiceCancel below share one audit trail. Gated by the SAME "approvals":"approve"
 * permission DESKTOP requires (not "sales":"edit") — cancelling outright with no approval step is
 * only as safe as approving someone else's request would be. */
export async function cancelInvoice(tenantId: string, employeeId: string, saleId: string, reason: string | undefined): Promise<MobileInvoiceResult> {
  return withTenantContext(
    tenantId,
    async (tx) => {
      const row = await requireInvoiceRow(tx, tenantId, saleId);
      if (row.paymentStatus === "cancelled") throw new HttpError(400, "This invoice is already cancelled");
      await assertNoPendingCancellation(tx, tenantId, saleId);

      const items = row.items as unknown as Array<{ productId: string; quantity: number; isLocallySourced: boolean }>;
      const now = new Date();
      const cancellationId = `invoice_cancel_${randomUUID()}`;

      await restockInvoiceItems(tx, tenantId, employeeId, items, row.locationId, "invoice_cancellation", cancellationId, now);

      await tx.invoiceCancellation.create({
        data: {
          id: cancellationId,
          tenantId,
          deviceId: OWNER_APP_DEVICE_ID,
          saleId,
          status: "approved",
          reason: reason?.trim() || "Cancelled by staff",
          notes: null,
          requestedBy: employeeId,
          requestedAt: now,
          approvedBy: employeeId,
          approvedAt: now,
          localCreatedAt: now,
          localUpdatedAt: now,
        },
      });
      await tx.sale.update({ where: { id: saleId }, data: { paymentStatus: "cancelled", localUpdatedAt: now } });

      return { id: saleId };
    },
    { timeoutMs: 15_000 },
  );
}

/** A cashier's request to cancel an invoice — gated by "sales":"edit" (the permission a normal
 * Cashier already has), not "approvals":"approve". Nothing changes — stock and money both stay
 * exactly as they are — until a manager approves it. Matches DESKTOP's own requestInvoiceCancel. */
export async function requestInvoiceCancel(tenantId: string, employeeId: string, saleId: string, reason: string, notes: string | undefined): Promise<MobileInvoiceResult> {
  return withTenantContext(tenantId, async (tx) => {
    const row = await requireInvoiceRow(tx, tenantId, saleId);
    if (row.paymentStatus === "cancelled") throw new HttpError(400, "This invoice is already cancelled");
    await assertNoPendingCancellation(tx, tenantId, saleId);

    const now = new Date();
    await tx.invoiceCancellation.create({
      data: {
        id: `invoice_cancel_${randomUUID()}`,
        tenantId,
        deviceId: OWNER_APP_DEVICE_ID,
        saleId,
        status: PENDING_APPROVAL,
        reason: reason.trim(),
        notes: notes?.trim() || null,
        requestedBy: employeeId,
        requestedAt: now,
        approvedBy: null,
        approvedAt: null,
        localCreatedAt: now,
        localUpdatedAt: now,
      },
    });
    return { id: saleId };
  });
}

export type MobilePendingCancellation = {
  id: string;
  saleId: string;
  invoiceNumber: string | null;
  saleGrandTotalCents: number;
  locationName: string;
  reason: string;
  notes: string | null;
  requestedByName: string;
  requestedAt: string;
  currency: string;
};

/** Backs the Owner App's Approvals tab — every invoice-cancellation request still awaiting a
 * decision, tenant-wide (not location-filtered — an approver needs to see requests from every
 * storefront, same as DESKTOP's own ApprovalsRoute). */
export async function listPendingInvoiceCancellations(tenantId: string): Promise<MobilePendingCancellation[]> {
  const { prisma } = await import("../prisma.js");
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { currency: true } });

  return withTenantContext(tenantId, async (tx) => {
    const pending = await tx.invoiceCancellation.findMany({
      where: { tenantId, status: PENDING_APPROVAL },
      orderBy: { requestedAt: "asc" },
    });
    if (pending.length === 0) return [];

    const saleIds = [...new Set(pending.map((p) => p.saleId))];
    const employeeIds = [...new Set(pending.map((p) => p.requestedBy))];
    const [sales, employees] = await Promise.all([
      tx.sale.findMany({ where: { id: { in: saleIds } }, select: { id: true, invoiceNumber: true, grandTotalCents: true, locationId: true } }),
      tx.employee.findMany({ where: { id: { in: employeeIds } }, select: { id: true, firstName: true, lastName: true } }),
    ]);
    const saleById = new Map(sales.map((s) => [s.id, s]));
    const locationIds = [...new Set(sales.map((s) => s.locationId))];
    const locations = await tx.location.findMany({ where: { id: { in: locationIds } }, select: { id: true, locationName: true } });
    const locationNameById = new Map(locations.map((l) => [l.id, l.locationName]));
    const employeeNameById = new Map(employees.map((e) => [e.id, `${e.firstName} ${e.lastName}`.trim()]));

    return pending
      .map((row) => {
        const sale = saleById.get(row.saleId);
        if (!sale) return null;
        return {
          id: row.id,
          saleId: row.saleId,
          invoiceNumber: sale.invoiceNumber,
          saleGrandTotalCents: sale.grandTotalCents,
          locationName: locationNameById.get(sale.locationId) ?? "—",
          reason: row.reason,
          notes: row.notes,
          requestedByName: employeeNameById.get(row.requestedBy) ?? "—",
          requestedAt: row.requestedAt.toISOString(),
          currency: tenant.currency as string,
        };
      })
      .filter((row): row is MobilePendingCancellation => row !== null);
  });
}

async function requirePendingCancellation(tx: Prisma.TransactionClient, tenantId: string, id: string) {
  const row = await tx.invoiceCancellation.findUnique({ where: { id } });
  if (!row || row.tenantId !== tenantId) throw new NotFoundError("Cancellation request not found");
  if (row.status !== PENDING_APPROVAL) throw new HttpError(400, "This request has already been decided");
  return row;
}

/** Manager approval: restocks every eligible item and marks both the request and the invoice
 * decided, matching DESKTOP's own approveInvoiceCancel. Gated by "approvals":"approve" at the
 * route level. */
export async function approveInvoiceCancel(tenantId: string, employeeId: string, id: string, notes: string | undefined): Promise<MobileInvoiceResult> {
  return withTenantContext(
    tenantId,
    async (tx) => {
      const cancellationRow = await requirePendingCancellation(tx, tenantId, id);
      const saleRow = await requireInvoiceRow(tx, tenantId, cancellationRow.saleId);

      const items = saleRow.items as unknown as Array<{ productId: string; quantity: number; isLocallySourced: boolean }>;
      const now = new Date();
      await restockInvoiceItems(tx, tenantId, employeeId, items, saleRow.locationId, "invoice_cancellation", id, now);

      await tx.sale.update({ where: { id: cancellationRow.saleId }, data: { paymentStatus: "cancelled", localUpdatedAt: now } });
      await tx.invoiceCancellation.update({
        where: { id },
        data: { status: "approved", approvedBy: employeeId, approvedAt: now, notes: notes?.trim() || cancellationRow.notes, localUpdatedAt: now },
      });

      return { id: cancellationRow.saleId };
    },
    { timeoutMs: 15_000 },
  );
}

/** Manager rejection: the invoice and its stock are untouched — only the request itself is marked
 * decided, matching DESKTOP's own rejectInvoiceCancel. */
export async function rejectInvoiceCancel(tenantId: string, employeeId: string, id: string, notes: string | undefined): Promise<MobileInvoiceResult> {
  return withTenantContext(tenantId, async (tx) => {
    const cancellationRow = await requirePendingCancellation(tx, tenantId, id);
    const now = new Date();
    await tx.invoiceCancellation.update({
      where: { id },
      data: { status: "rejected", approvedBy: employeeId, approvedAt: now, notes: notes?.trim() || cancellationRow.notes, localUpdatedAt: now },
    });
    return { id: cancellationRow.saleId };
  });
}
