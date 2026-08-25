import { randomUUID } from "node:crypto";
import { ensureEmployeeMobileSequence, mintMobileDocumentNumber } from "../lib/mobile-numbering.js";
import { withTenantContext } from "../lib/tenant-context.js";
import { type MobileCreateCustomerInput, mobileCreateCustomerSchema } from "../schemas/mobile.js";
import { buildSharedStatement, type SharedStatementResult } from "./share-service.js";

/** Same synthetic deviceId used by every other Owner-App-originated write — see
 * mobile-checkout-service.ts's own doc comment for why. */
const OWNER_APP_DEVICE_ID = "owner-app";

/** Matches DESKTOP's own customer-service.ts prefix exactly ("CUST", 5 digits). */
const CUSTOMER_CODE_PREFIX = "CUST";
const CUSTOMER_CODE_DIGITS = 5;

export type MobileCustomer = { id: string; name: string; phone: string; customerCode: string };

const CUSTOMER_SELECT = { id: true, name: true, phone: true, customerCode: true } as const;

/** Backs the Owner App's "Generate Statement" customer picker AND the Checkout customer picker AND
 * the Customers tab — one list, same shape, reused everywhere a mobile screen needs "which customer
 * is this" (same convention DESKTOP's own customer.list() IPC handler serves every one of its own
 * equivalent pickers from). */
export async function listCustomers(tenantId: string): Promise<MobileCustomer[]> {
  return withTenantContext(tenantId, async (tx) =>
    tx.customer.findMany({
      where: { tenantId, status: "active" },
      select: CUSTOMER_SELECT,
      orderBy: { name: "asc" },
    }),
  );
}

/** The fast path for adding a customer mid-checkout — mirrors DESKTOP's own createCustomer
 * (customer-service.ts): name + phone only, customerType hardcoded to "retail", customerCode
 * auto-minted. Unlike DESKTOP, doesn't enforce phone uniqueness per tenant — mobile has no edit UI
 * to fix a rejected duplicate on the spot, and a duplicate phone is a soft data-quality issue a
 * Super Admin can merge later from DESKTOP, not something worth blocking a cashier's sale over. */
export async function createCustomer(tenantId: string, employeeId: string, input: unknown): Promise<MobileCustomer> {
  const parsed: MobileCreateCustomerInput = mobileCreateCustomerSchema.parse(input);
  const now = new Date();

  return withTenantContext(tenantId, async (tx) => {
    const employee = await tx.employee.findUniqueOrThrow({ where: { id: employeeId } });
    const mobileDeviceSequence = await ensureEmployeeMobileSequence(tx, tenantId, employeeId, employee.mobileDeviceSequence);
    const customerCode = await mintMobileDocumentNumber(tx, tenantId, mobileDeviceSequence, CUSTOMER_CODE_PREFIX, CUSTOMER_CODE_DIGITS);

    return tx.customer.create({
      data: {
        id: `customer_${randomUUID()}`,
        tenantId,
        deviceId: OWNER_APP_DEVICE_ID,
        customerCode,
        customerType: "retail",
        name: parsed.name,
        phone: parsed.phone,
        status: "active",
        locationId: employee.branchId,
        localCreatedAt: now,
        localUpdatedAt: now,
      },
      select: CUSTOMER_SELECT,
    });
  });
}

/** The owner viewing their own tenant's own customer's statement — a plain authenticated read via
 * the exact same view-model the Share feature renders (buildSharedStatement), not a public-token
 * lookup, same reasoning as mobile-sales-service.ts's getSale. */
export async function getStatement(tenantId: string, customerId: string): Promise<SharedStatementResult | null> {
  return buildSharedStatement(tenantId, customerId);
}
