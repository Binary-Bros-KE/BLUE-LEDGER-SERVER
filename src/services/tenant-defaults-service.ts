import { randomUUID } from "node:crypto";
import { hashSecret } from "../lib/password-hash.js";
import { withTenantContext } from "../lib/tenant-context.js";

/**
 * A brand-new tenant's starter data, created in the cloud the moment the tenant is — so a
 * mobile-only business can sign in to the Owner App straight away, without a desktop ever being
 * activated first (that used to be the only place these existed).
 *
 * Everything here mirrors DESKTOP's own boot seeds EXACTLY (role-service.ts DEFAULT_SYSTEM_ROLES,
 * employee-service.ts ensureDefaultSystemEmployee, location-service.ts ensureMainStoreLocation,
 * payment-method-service.ts, expense-category-service.ts) — same names, codes and permissions. That
 * is what keeps a desktop installed later from creating a second copy: its own seeds share these
 * natural keys (role name, employee code, location code, payment-method code, category name), so
 * sync recognises them as the same rows and links them instead of inserting duplicates
 * (sync-service.ts NATURAL_KEY_FIELDS). DESKTOP dates its seeds as the oldest possible version, so
 * whatever is set up here (or changed afterwards from the phone — a new PIN, an assigned storefront)
 * is what the desktop ends up with, not the other way round.
 *
 * One addition DESKTOP doesn't seed: a first storefront named after the business, with the System
 * Administrator assigned to it — the phone has no "create storefront" screen, and selling needs one.
 *
 * Idempotent per table ("seed only when the tenant has none at all", same rule as DESKTOP), so it is
 * safe to re-run — loginMobile calls it again for tenants created before this existed.
 */

const SEED_DEVICE_ID = "cloud-setup";

const DEFAULT_SYSTEM_EMPLOYEE_CODE = "SYSTEM";
const DEFAULT_SYSTEM_PIN = "000000";

/** DESKTOP shared/types/role.ts PERMISSION_MODULES — module -> every action it supports. */
const PERMISSION_MODULE_ACTIONS: Record<string, string[]> = {
  dashboard: ["view"],
  products: ["view", "create", "edit", "delete", "export"],
  categories: ["view", "create", "edit", "delete"],
  inventory: ["view", "create", "edit", "export"],
  main_store: ["view", "create", "edit", "export"],
  stock_transfers: ["view", "create", "approve", "export"],
  sales: ["view", "create", "edit", "delete", "approve", "export"],
  quotations: ["view", "create", "edit", "delete", "export"],
  purchases: ["view", "create", "edit", "delete", "approve", "export"],
  customers: ["view", "create", "edit", "delete", "export"],
  suppliers: ["view", "create", "edit", "delete", "export"],
  riders: ["view", "create", "edit", "delete", "export"],
  stock_requests: ["view", "create", "approve", "export"],
  purchase_requisitions: ["view", "create", "approve"],
  expenses: ["view", "create", "edit", "delete", "export"],
  expense_categories: ["view", "create", "edit", "delete"],
  local_purchases: ["view", "create", "edit", "delete", "export"],
  borrows: ["view", "create", "edit", "export"],
  employees: ["view", "create", "edit", "delete", "export"],
  salaries: ["view", "create", "edit", "delete", "export"],
  roles: ["view", "create", "edit", "delete"],
  reports: ["view", "export"],
  settings: ["view", "edit"],
  business_profile: ["view", "edit"],
  locations: ["view", "create", "edit", "delete"],
  payment_methods: ["view", "create", "edit", "delete"],
  approvals: ["view", "approve"],
  cloud_sync: ["view", "edit"],
  data_import: ["view", "edit"],
  owner_app: ["view"],
  online_store: ["view", "edit"],
  administration: ["view", "edit"],
};

function fullAccess(modules: string[]): Record<string, string[]> {
  return Object.fromEntries(modules.map((key) => [key, [...(PERMISSION_MODULE_ACTIONS[key] ?? [])]]));
}

/** DESKTOP role-service.ts DEFAULT_SYSTEM_ROLES. */
const DEFAULT_ROLES: Array<{ roleName: string; description: string; permissions: Record<string, string[]>; isSuperAdmin: boolean }> = [
  {
    roleName: "Super Admin",
    description:
      "Cross-branch oversight. Leave this employee's branch unassigned so they see every storefront's data instead of being limited to one.",
    permissions: fullAccess(Object.keys(PERMISSION_MODULE_ACTIONS)),
    isSuperAdmin: true,
  },
  {
    roleName: "Manager",
    description: "Runs daily operations across sales, inventory, and staff.",
    permissions: {
      ...fullAccess([
        "dashboard",
        "products",
        "categories",
        "inventory",
        "stock_transfers",
        "sales",
        "quotations",
        "purchases",
        "customers",
        "suppliers",
        "riders",
        "expenses",
        "expense_categories",
        "local_purchases",
        "borrows",
        "salaries",
        "reports",
        "employees",
        "approvals",
      ]),
      stock_requests: ["view", "create"],
    },
    isSuperAdmin: false,
  },
  {
    roleName: "Cashier",
    description: "Handles checkout and customer-facing sales.",
    permissions: {
      dashboard: ["view"],
      products: ["view"],
      categories: ["view"],
      sales: ["view", "create", "edit", "delete"],
      quotations: ["view", "create", "edit"],
      customers: ["view", "create"],
      riders: ["view", "create", "edit"],
      payment_methods: ["view"],
      stock_transfers: ["view"],
      salaries: ["view"],
      stock_requests: ["view", "create"],
      local_purchases: ["view", "create", "edit", "delete"],
    },
    isSuperAdmin: false,
  },
  {
    roleName: "Storekeeper",
    description: "Manages stock levels, receiving, and transfers between locations.",
    permissions: {
      dashboard: ["view"],
      products: ["view", "create", "edit"],
      categories: ["view"],
      inventory: ["view", "create", "edit"],
      main_store: ["view", "create", "edit", "export"],
      stock_transfers: ["view", "create", "approve"],
      purchases: ["view", "create"],
      suppliers: ["view", "create"],
      salaries: ["view"],
      stock_requests: ["view", "approve"],
      borrows: ["view", "create", "edit", "export"],
    },
    isSuperAdmin: false,
  },
];

/** DESKTOP payment-method-service.ts DEFAULT_PAYMENT_METHODS. */
const DEFAULT_PAYMENT_METHODS = [
  { name: "Cash", code: "CASH", requiresReference: false },
  { name: "M-Pesa", code: "MPESA", requiresReference: true },
  { name: "Card", code: "CARD", requiresReference: true },
  { name: "Bank Transfer", code: "BANK_TRANSFER", requiresReference: true },
  { name: "Cheque", code: "CHEQUE", requiresReference: true },
  { name: "PayPal", code: "PAYPAL", requiresReference: true },
];

/** DESKTOP expense-category-service.ts DEFAULT_EXPENSE_CATEGORIES. */
const DEFAULT_EXPENSE_CATEGORIES = ["Utilities", "Transport", "Marketing", "Salary", "Repairs", "Miscellaneous"];

const FIRST_STOREFRONT_CODE = "STOREFRONT-1";

/** Location columns DESKTOP's own insertLocationRow leaves at their defaults. */
function locationDefaults() {
  return {
    displayName: null,
    logoPath: null,
    logoRatio: null,
    phone: null,
    alternativePhone: null,
    email: null,
    country: null,
    county: null,
    city: null,
    physicalAddress: null,
    managerName: null,
    managerPhone: null,
    managerEmail: null,
    openingTime: null,
    closingTime: null,
    allowNegativeStock: false,
    isInventoryLocation: true,
    status: "active",
    receiptHeader: null,
    receiptFooter: null,
    invoiceHeader: null,
    invoiceFooter: null,
    quotationHeader: null,
    quotationFooter: null,
    showProductImagesOnInvoices: false,
    showProductImagesOnQuotations: false,
    defaultIncludeBusinessInfo: true,
  };
}

export async function seedTenantDefaults(tenantId: string, businessName: string): Promise<void> {
  const now = new Date();
  const stamp = { tenantId, deviceId: SEED_DEVICE_ID, localCreatedAt: now, localUpdatedAt: now, syncedAt: now };

  await withTenantContext(tenantId, async (tx) => {
    if ((await tx.role.count({ where: { tenantId } })) === 0) {
      await tx.role.createMany({
        data: DEFAULT_ROLES.map((role) => ({
          id: `role_${randomUUID()}`,
          ...stamp,
          roleName: role.roleName,
          description: role.description,
          permissionsJson: role.permissions,
          isSystemRole: true,
          isSuperAdmin: role.isSuperAdmin,
        })),
      });
    }

    if (!(await tx.location.findFirst({ where: { tenantId, locationType: "distribution_center" } }))) {
      await tx.location.create({
        data: {
          id: `location_${randomUUID()}`,
          ...stamp,
          ...locationDefaults(),
          locationCode: "MAIN-STORE",
          locationName: "Main Store",
          locationType: "distribution_center",
          description: "Central stock — receives and distributes products to storefronts.",
          canReceiveStock: true,
          canSellStock: false,
          canTransferStock: true,
        },
      });
    }

    let storefront = await tx.location.findFirst({
      where: { tenantId, locationType: { notIn: ["distribution_center", "warehouse"] } },
      select: { id: true },
    });
    if (!storefront) {
      storefront = await tx.location.create({
        data: {
          id: `location_${randomUUID()}`,
          ...stamp,
          ...locationDefaults(),
          locationCode: FIRST_STOREFRONT_CODE,
          locationName: businessName,
          locationType: "retail_store",
          description: null,
          canReceiveStock: true,
          canSellStock: true,
          canTransferStock: true,
        },
        select: { id: true },
      });
    }

    if ((await tx.employee.count({ where: { tenantId } })) === 0) {
      const superAdminRole = await tx.role.findFirst({ where: { tenantId, roleName: "Super Admin" }, select: { id: true } });
      await tx.employee.create({
        data: {
          id: `employee_${randomUUID()}`,
          ...stamp,
          employeeCode: DEFAULT_SYSTEM_EMPLOYEE_CODE,
          firstName: "System",
          middleName: null,
          lastName: "Administrator",
          jobTitle: "System Administrator",
          // Works at the first storefront, so Checkout and every other "where?" picker has its answer.
          branchId: storefront.id,
          roleId: superAdminRole?.id ?? null,
          username: "system",
          status: "active",
          pinHash: hashSecret(DEFAULT_SYSTEM_PIN),
        },
      });
    }

    if ((await tx.paymentMethod.count({ where: { tenantId } })) === 0) {
      await tx.paymentMethod.createMany({
        data: DEFAULT_PAYMENT_METHODS.map((method, index) => ({
          id: `payment_method_${randomUUID()}`,
          ...stamp,
          name: method.name,
          code: method.code,
          description: null,
          isSystemMethod: true,
          isActive: true,
          requiresReference: method.requiresReference,
          sortOrder: index,
        })),
      });
    }

    if ((await tx.expenseCategory.count({ where: { tenantId } })) === 0) {
      await tx.expenseCategory.createMany({
        data: DEFAULT_EXPENSE_CATEGORIES.map((name) => ({
          id: `expense_category_${randomUUID()}`,
          ...stamp,
          name,
          description: null,
          status: "active",
        })),
      });
    }
  });
}
