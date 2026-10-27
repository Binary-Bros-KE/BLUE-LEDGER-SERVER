import { randomUUID } from "node:crypto";
import { ConflictError, NotFoundError } from "../lib/http-error.js";
import { ensureEmployeeMobileSequence, mintMobileDocumentNumber } from "../lib/mobile-numbering.js";
import { withTenantContext } from "../lib/tenant-context.js";
import { type MobileCreateSupplierInput, mobileCreateSupplierSchema, mobileSupplierBalanceAdjustSchema, mobileUpdateSupplierSchema } from "../schemas/mobile.js";

/** Same synthetic deviceId used by every other Owner-App-originated write — see
 * mobile-checkout-service.ts's own doc comment for why. */
const OWNER_APP_DEVICE_ID = "owner-app";

/** Matches DESKTOP's own supplier-service.ts prefix exactly ("SUP", 6 digits). */
const SUPPLIER_CODE_PREFIX = "SUP";
const SUPPLIER_CODE_DIGITS = 6;

export type MobileSupplier = { id: string; businessName: string; phone1: string };

const SUPPLIER_SELECT = { id: true, businessName: true, phone1: true } as const;

/** Backs Checkout's "Sourced from another shop" supplier picker and every other supplier picker
 * (New Purchase) — the Suppliers tab itself uses listSuppliersWithBalances below. */
export async function listSuppliers(tenantId: string): Promise<MobileSupplier[]> {
  return withTenantContext(tenantId, async (tx) =>
    tx.supplier.findMany({
      where: { tenantId, status: "active" },
      select: SUPPLIER_SELECT,
      orderBy: { businessName: "asc" },
    }),
  );
}

/** The fast path for adding a supplier mid-checkout — mirrors DESKTOP's own QuickCreateSupplierModal:
 * businessName + phone1 required, contactPerson optional, paymentOption hardcoded to "cash". */
export async function createSupplier(tenantId: string, employeeId: string, input: unknown): Promise<MobileSupplier> {
  const parsed: MobileCreateSupplierInput = mobileCreateSupplierSchema.parse(input);
  const now = new Date();

  return withTenantContext(tenantId, async (tx) => {
    const employee = await tx.employee.findUniqueOrThrow({ where: { id: employeeId } });
    const mobileDeviceSequence = await ensureEmployeeMobileSequence(tx, tenantId, employeeId, employee.mobileDeviceSequence);
    const supplierCode = await mintMobileDocumentNumber(tx, tenantId, mobileDeviceSequence, SUPPLIER_CODE_PREFIX, SUPPLIER_CODE_DIGITS);

    return tx.supplier.create({
      data: {
        id: `supplier_${randomUUID()}`,
        tenantId,
        deviceId: OWNER_APP_DEVICE_ID,
        supplierCode,
        businessName: parsed.businessName,
        contactPerson: parsed.contactPerson ?? null,
        phone1: parsed.phone1,
        paymentOption: "cash",
        status: "active",
        localCreatedAt: now,
        localUpdatedAt: now,
      },
      select: SUPPLIER_SELECT,
    });
  });
}

// ---------------------------------------------------------------------------------------------
// Supplier balances — a supplier's balance is the running sum of its SupplierBalanceEntry rows
// (DESKTOP's own append-only ledger: purchase_received grows it, payment shrinks it, both written by
// purchases — see mobile-purchases-service.ts). The only entry a person creates directly is a
// "manual_adjustment" (DESKTOP's supplier-balance-service.ts adjustSupplierBalance): an opening
// balance carried over from an old system, a correction, or money settled outside a purchase.
// Signed: positive = more owed to the supplier, negative = less.
// ---------------------------------------------------------------------------------------------

export type MobileSupplierWithBalance = MobileSupplier & { supplierCode: string; balanceCents: number };

export type MobileSupplierBalanceEntry = {
  id: string;
  entryType: string;
  amountCents: number;
  notes: string | null;
  /** The purchase number when the entry came from a purchase. */
  reference: string | null;
  performedByName: string | null;
  createdAt: string;
};

/** Suppliers tab list — biggest balance owed first. */
export async function listSuppliersWithBalances(tenantId: string): Promise<MobileSupplierWithBalance[]> {
  return withTenantContext(tenantId, async (tx) => {
    const [suppliers, sums] = await Promise.all([
      tx.supplier.findMany({ where: { tenantId, status: "active" }, select: { ...SUPPLIER_SELECT, supplierCode: true } }),
      tx.supplierBalanceEntry.groupBy({ by: ["supplierId"], where: { tenantId }, _sum: { amountCents: true } }),
    ]);
    const balanceBySupplier = new Map(sums.map((row) => [row.supplierId, row._sum.amountCents ?? 0]));
    return suppliers
      .map((sup) => ({ ...sup, balanceCents: balanceBySupplier.get(sup.id) ?? 0 }))
      .sort((a, b) => b.balanceCents - a.balanceCents || a.businessName.localeCompare(b.businessName));
  });
}

/** DESKTOP's listSupplierBalanceEntries — most recent first. */
export async function listSupplierBalanceEntries(tenantId: string, supplierId: string): Promise<MobileSupplierBalanceEntry[]> {
  return withTenantContext(tenantId, async (tx) => {
    const supplier = await tx.supplier.findUnique({ where: { id: supplierId }, select: { tenantId: true } });
    if (!supplier || supplier.tenantId !== tenantId) throw new NotFoundError("Supplier not found");

    const entries = await tx.supplierBalanceEntry.findMany({ where: { tenantId, supplierId }, orderBy: { localCreatedAt: "desc" }, take: 200 });
    const purchaseIds = [...new Set(entries.filter((e) => e.referenceType === "purchase" && e.referenceId).map((e) => e.referenceId as string))];
    const employeeIds = [...new Set(entries.map((e) => e.performedBy).filter((id): id is string => Boolean(id)))];
    const [purchases, employees] = await Promise.all([
      tx.purchase.findMany({ where: { id: { in: purchaseIds } }, select: { id: true, purchaseNumber: true } }),
      tx.employee.findMany({ where: { id: { in: employeeIds } }, select: { id: true, firstName: true, lastName: true } }),
    ]);
    const purchaseNumberById = new Map(purchases.map((p) => [p.id, p.purchaseNumber]));
    const employeeNameById = new Map(employees.map((e) => [e.id, `${e.firstName} ${e.lastName}`.trim()]));

    return entries.map((e) => ({
      id: e.id,
      entryType: e.entryType,
      amountCents: e.amountCents,
      notes: e.notes,
      reference: e.referenceId ? (purchaseNumberById.get(e.referenceId) ?? null) : null,
      performedByName: e.performedBy ? (employeeNameById.get(e.performedBy) ?? null) : null,
      createdAt: e.localCreatedAt.toISOString(),
    }));
  });
}

/** DESKTOP's adjustSupplierBalance. Idempotent on the client-minted `id` (the entry's own id). */
export async function adjustSupplierBalance(tenantId: string, employeeId: string, supplierId: string, input: unknown): Promise<{ id: string; balanceCents: number }> {
  const parsed = mobileSupplierBalanceAdjustSchema.parse(input);
  const entryId = parsed.id.startsWith("supplier_balance_") ? parsed.id : `supplier_balance_${parsed.id}`;
  const now = new Date();

  return withTenantContext(tenantId, async (tx) => {
    const supplier = await tx.supplier.findUnique({ where: { id: supplierId }, select: { tenantId: true } });
    if (!supplier || supplier.tenantId !== tenantId) throw new NotFoundError("Supplier not found");

    const existing = await tx.supplierBalanceEntry.findUnique({ where: { id: entryId }, select: { id: true } });
    if (!existing) {
      await tx.supplierBalanceEntry.create({
        data: {
          id: entryId,
          tenantId,
          deviceId: OWNER_APP_DEVICE_ID,
          supplierId,
          entryType: "manual_adjustment",
          amountCents: parsed.amountCents,
          referenceType: null,
          referenceId: null,
          notes: parsed.notes,
          performedBy: employeeId,
          // Immutable row — same localCreatedAt-for-both convention as StockMovement.
          localCreatedAt: now,
          localUpdatedAt: now,
        },
      });
    }
    const sum = await tx.supplierBalanceEntry.aggregate({ where: { tenantId, supplierId }, _sum: { amountCents: true } });
    return { id: entryId, balanceCents: sum._sum.amountCents ?? 0 };
  });
}

// ---------------------------------------------------------------------------------------------
// Edit — DESKTOP's supplier-service.ts updateSupplier (+ setSupplierStatus via `status`).
// ---------------------------------------------------------------------------------------------

export type MobileSupplierDetail = {
  id: string;
  supplierCode: string;
  businessName: string;
  contactPerson: string | null;
  phone1: string;
  phone2: string | null;
  email: string | null;
  kraPin: string | null;
  town: string | null;
  physicalAddress: string | null;
  paymentOption: string;
  mpesaName: string | null;
  mpesaNumber: string | null;
  bankName: string | null;
  bankAccountName: string | null;
  bankAccountNumber: string | null;
  creditLimitCents: number | null;
  notes: string | null;
  status: string;
};

export async function getSupplierDetail(tenantId: string, supplierId: string): Promise<MobileSupplierDetail> {
  return withTenantContext(tenantId, async (tx) => {
    const s = await tx.supplier.findUnique({ where: { id: supplierId } });
    if (!s || s.tenantId !== tenantId) throw new NotFoundError("Supplier not found");
    return {
      id: s.id,
      supplierCode: s.supplierCode,
      businessName: s.businessName,
      contactPerson: s.contactPerson,
      phone1: s.phone1,
      phone2: s.phone2,
      email: s.email,
      kraPin: s.kraPin,
      town: s.town,
      physicalAddress: s.physicalAddress,
      paymentOption: s.paymentOption,
      mpesaName: s.mpesaName,
      mpesaNumber: s.mpesaNumber,
      bankName: s.bankName,
      bankAccountName: s.bankAccountName,
      bankAccountNumber: s.bankAccountNumber,
      creditLimitCents: s.creditLimitCents,
      notes: s.notes,
      status: s.status,
    };
  });
}

/** DESKTOP's assertUniqueBusinessName rule (case-insensitive here), excluding itself. */
export async function updateSupplier(tenantId: string, supplierId: string, input: unknown): Promise<{ id: string }> {
  const parsed = mobileUpdateSupplierSchema.parse(input);
  const now = new Date();
  return withTenantContext(tenantId, async (tx) => {
    const existing = await tx.supplier.findUnique({ where: { id: supplierId }, select: { tenantId: true } });
    if (!existing || existing.tenantId !== tenantId) throw new NotFoundError("Supplier not found");
    const duplicate = await tx.supplier.findFirst({
      where: { tenantId, businessName: { equals: parsed.businessName, mode: "insensitive" }, id: { not: supplierId } },
      select: { id: true },
    });
    if (duplicate) throw new ConflictError(`A supplier named "${parsed.businessName}" already exists`);
    await tx.supplier.update({
      where: { id: supplierId },
      data: { ...parsed, deviceId: OWNER_APP_DEVICE_ID, localUpdatedAt: now, syncedAt: now },
    });
    return { id: supplierId };
  });
}
