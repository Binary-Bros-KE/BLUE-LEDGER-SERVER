import { withTenantContext } from "../lib/tenant-context.js";
import { prisma } from "../prisma.js";
import { computeTaxBreakdown, type TaxBreakdownEntry } from "../lib/tax-breakdown.js";

export type MobilePurchaseListItem = {
  id: string;
  purchaseNumber: string;
  supplierName: string;
  locationName: string;
  locationId: string;
  status: string;
  paymentStatus: string;
  grandTotalCents: number;
  amountPaidCents: number;
  orderedAt: string | null;
  receivedAt: string | null;
  createdAt: string;
  currency: string;
};

type RawPurchaseItem = {
  productId: string;
  orderedQuantity: number;
  receivedQuantity: number;
  unitCostCents: number;
  discountAmountCents: number;
  taxType: string;
  taxAmountCents: number;
  lineTotalCents: number;
};

type RawPurchasePayment = {
  paymentMethodName: string;
  amountCents: number;
  reference: string | null;
  paidByName: string;
  paidAt: string;
};

export type MobilePurchaseItem = {
  productName: string;
  sku: string | null;
  orderedQuantity: number;
  receivedQuantity: number;
  unitCostCents: number;
  discountAmountCents: number;
  taxAmountCents: number;
  lineTotalCents: number;
};

export type MobilePurchasePayment = {
  paymentMethodName: string;
  amountCents: number;
  reference: string | null;
  paidByName: string;
  paidAt: string;
};

export type MobilePurchaseDetail = {
  id: string;
  purchaseNumber: string;
  supplierName: string;
  supplierPhone: string | null;
  locationName: string;
  supplierInvoiceNumber: string | null;
  status: string;
  taxType: string;
  paymentStatus: string;
  orderedAt: string | null;
  receivedAt: string | null;
  notes: string | null;
  items: MobilePurchaseItem[];
  subtotalCents: number;
  discountAmountCents: number;
  taxAmountCents: number;
  taxBreakdown: TaxBreakdownEntry[];
  vatRatePercent: number;
  grandTotalCents: number;
  amountPaidCents: number;
  payments: MobilePurchasePayment[];
  currency: string;
};

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

/** No PDF/download/share capability exists for Purchases anywhere in this app (confirmed against
 * DESKTOP — a Purchase Order's only "document" is a locally-attached file, not a generated one), so
 * unlike Sales/Invoices/Quotations this is view-only: a lightweight list plus a full-detail fetch on
 * tap, no share-link minting. */
export async function listPurchases(tenantId: string, locationId: string | null): Promise<MobilePurchaseListItem[]> {
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { currency: true } });

  return withTenantContext(tenantId, async (tx) => {
    const purchases = await tx.purchase.findMany({
      where: { tenantId, ...(locationId ? { locationId } : {}) },
      orderBy: { localCreatedAt: "desc" },
      take: 200,
    });

    const [locations, suppliers] = await Promise.all([
      tx.location.findMany({ where: { tenantId }, select: { id: true, locationName: true } }),
      tx.supplier.findMany({ where: { tenantId }, select: { id: true, businessName: true } }),
    ]);
    const locationNameById = new Map(locations.map((l) => [l.id, l.locationName]));
    const supplierNameById = new Map(suppliers.map((s) => [s.id, s.businessName]));

    return purchases.map((purchase) => ({
      id: purchase.id,
      purchaseNumber: purchase.purchaseNumber,
      supplierName: supplierNameById.get(purchase.supplierId) ?? "—",
      locationName: locationNameById.get(purchase.locationId) ?? "—",
      locationId: purchase.locationId,
      status: purchase.status,
      paymentStatus: purchase.paymentStatus,
      grandTotalCents: purchase.grandTotalCents,
      amountPaidCents: purchase.amountPaidCents,
      orderedAt: purchase.orderedAt ? purchase.orderedAt.toISOString() : null,
      receivedAt: purchase.receivedAt ? purchase.receivedAt.toISOString() : null,
      createdAt: purchase.localCreatedAt.toISOString(),
      currency: tenant.currency,
    }));
  });
}

export async function getPurchase(tenantId: string, purchaseId: string): Promise<MobilePurchaseDetail | null> {
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { currency: true, vatRatePercent: true } });

  return withTenantContext(tenantId, async (tx) => {
    const purchase = await tx.purchase.findUnique({ where: { id: purchaseId } });
    if (!purchase) return null;

    const items = asArray<RawPurchaseItem>(purchase.items);
    const [location, supplier, products] = await Promise.all([
      tx.location.findUnique({ where: { id: purchase.locationId }, select: { locationName: true } }),
      tx.supplier.findUnique({ where: { id: purchase.supplierId }, select: { businessName: true, phone1: true } }),
      tx.product.findMany({ where: { id: { in: items.map((i) => i.productId) } }, select: { id: true, name: true, sku: true } }),
    ]);
    const productById = new Map(products.map((p) => [p.id, p]));

    return {
      id: purchase.id,
      purchaseNumber: purchase.purchaseNumber,
      supplierName: supplier?.businessName ?? "—",
      supplierPhone: supplier?.phone1 ?? null,
      locationName: location?.locationName ?? "—",
      supplierInvoiceNumber: purchase.supplierInvoiceNumber,
      status: purchase.status,
      taxType: purchase.taxType,
      paymentStatus: purchase.paymentStatus,
      orderedAt: purchase.orderedAt ? purchase.orderedAt.toISOString() : null,
      receivedAt: purchase.receivedAt ? purchase.receivedAt.toISOString() : null,
      notes: purchase.notes,
      items: items.map((item) => ({
        productName: productById.get(item.productId)?.name ?? "Unknown product",
        sku: productById.get(item.productId)?.sku ?? null,
        orderedQuantity: item.orderedQuantity,
        receivedQuantity: item.receivedQuantity,
        unitCostCents: item.unitCostCents,
        discountAmountCents: item.discountAmountCents,
        taxAmountCents: item.taxAmountCents,
        lineTotalCents: item.lineTotalCents,
      })),
      subtotalCents: purchase.subtotalCents,
      discountAmountCents: purchase.discountAmountCents,
      taxAmountCents: purchase.taxAmountCents,
      taxBreakdown: computeTaxBreakdown(
        items.map((item) => ({
          unitPriceCents: item.unitCostCents,
          quantity: item.orderedQuantity,
          discountAmountCents: item.discountAmountCents,
          taxType: item.taxType,
          taxAmountCents: item.taxAmountCents,
          lineTotalCents: item.lineTotalCents,
        })),
      ),
      vatRatePercent: tenant.vatRatePercent,
      grandTotalCents: purchase.grandTotalCents,
      amountPaidCents: purchase.amountPaidCents,
      payments: asArray<RawPurchasePayment>(purchase.payments).map((payment) => ({
        paymentMethodName: payment.paymentMethodName,
        amountCents: payment.amountCents,
        reference: payment.reference,
        paidByName: payment.paidByName,
        paidAt: payment.paidAt,
      })),
      currency: tenant.currency,
    };
  });
}
