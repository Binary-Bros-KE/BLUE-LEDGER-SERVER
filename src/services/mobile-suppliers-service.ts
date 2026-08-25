import { randomUUID } from "node:crypto";
import { ensureEmployeeMobileSequence, mintMobileDocumentNumber } from "../lib/mobile-numbering.js";
import { withTenantContext } from "../lib/tenant-context.js";
import { type MobileCreateSupplierInput, mobileCreateSupplierSchema } from "../schemas/mobile.js";

/** Same synthetic deviceId used by every other Owner-App-originated write — see
 * mobile-checkout-service.ts's own doc comment for why. */
const OWNER_APP_DEVICE_ID = "owner-app";

/** Matches DESKTOP's own supplier-service.ts prefix exactly ("SUP", 6 digits). */
const SUPPLIER_CODE_PREFIX = "SUP";
const SUPPLIER_CODE_DIGITS = 6;

export type MobileSupplier = { id: string; businessName: string; phone1: string };

const SUPPLIER_SELECT = { id: true, businessName: true, phone1: true } as const;

/** Backs Checkout's "Sourced from another shop" supplier picker AND — same list, no separate
 * Suppliers tab exists yet, unlike Customers/Riders (not requested). */
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
