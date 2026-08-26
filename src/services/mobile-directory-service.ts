import { withTenantContext } from "../lib/tenant-context.js";
import { prisma } from "../prisma.js";

/** Employee directory + payslip history for the Owner App's Employees tab. Employee.roleId/
 * branchId and Salary.paymentMethodId are opaque strings (no real FK — same convention as every
 * other synced entity), resolved to display names via one-time maps, same pattern already used in
 * mobile-metrics-service.ts for Product/Customer references. */

export type MobileSessionInfo = {
  employeeName: string;
  roleName: string | null;
  currency: string;
  /** Module -> allowed actions, same shape as DESKTOP's own PermissionsMap — lets APP gate its own
   * tabs/actions (Products/Checkout/Receipts and beyond) against the SAME permissions a Super Admin
   * already grants via DESKTOP's Roles & Permissions screen, no separate mobile-specific permission
   * UI needed. A module absent here means no access, same convention as DESKTOP. */
  permissions: Record<string, string[]>;
  /** This employee's own assigned branch — null for a branch-less (Super Admin-style) employee.
   * Lets the Checkout tab resolve "which storefront am I selling from" automatically, with no picker:
   * mobile-checkout-service.ts already rejects a checkout whose locationId isn't this employee's own
   * branchId (no branch-less mobile-checkout path exists yet), so APP surfacing it up front avoids a
   * confusing round trip to the server just to find out. */
  branchId: string | null;
  branchName: string | null;
  /** Tenant-wide tax defaults — Checkout's cart preview needs these (alongside each product's own
   * pricesTaxInclusive override, see MobileProductListItem) to compute the REAL tax-inclusive total
   * client-side, the same computeLineTax/resolveProductTaxConfig math mobile-checkout-service.ts
   * uses authoritatively at submit time. */
  vatRatePercent: number;
  pricesTaxInclusive: boolean;
  /** Server-authoritative — see Role.isSuperAdmin's own doc comment. Lets APP gate its Working Hours
   * tab (and any other Super-Admin-exclusive UI) without a name-based guess. */
  isSuperAdmin: boolean;
};

/** Backs the Owner App's sidebar footer (name + role) and gives every tab the tenant's currency
 * without each one needing its own round trip — a small, dedicated lookup rather than folding this
 * into the JWT payload itself, since a name/role/permission change should be reflected without
 * waiting for the 7-day token to be re-issued. */
export async function getMe(tenantId: string, employeeId: string): Promise<MobileSessionInfo> {
  const tenant = await prisma.tenant.findUniqueOrThrow({
    where: { id: tenantId },
    select: { currency: true, vatRatePercent: true, pricesTaxInclusive: true },
  });
  return withTenantContext(tenantId, async (tx) => {
    const employee = await tx.employee.findUniqueOrThrow({ where: { id: employeeId } });
    const role = employee.roleId ? await tx.role.findUnique({ where: { id: employee.roleId } }) : null;
    const branch = employee.branchId ? await tx.location.findUnique({ where: { id: employee.branchId } }) : null;
    return {
      employeeName: `${employee.firstName} ${employee.lastName}`.trim(),
      roleName: role?.roleName ?? null,
      currency: tenant.currency,
      permissions: (role?.permissionsJson as Record<string, string[]> | undefined) ?? {},
      branchId: employee.branchId,
      branchName: branch?.locationName ?? null,
      vatRatePercent: tenant.vatRatePercent,
      pricesTaxInclusive: tenant.pricesTaxInclusive,
      isSuperAdmin: role?.isSuperAdmin ?? false,
    };
  });
}

export type EmployeeSummary = {
  id: string;
  employeeCode: string;
  firstName: string;
  middleName: string | null;
  lastName: string;
  gender: string | null;
  dateOfBirth: string | null;
  phone: string | null;
  alternativePhone: string | null;
  email: string | null;
  department: string | null;
  jobTitle: string | null;
  hireDate: string | null;
  status: string;
  roleName: string | null;
  branchName: string | null;
};

export async function listEmployees(tenantId: string): Promise<EmployeeSummary[]> {
  return withTenantContext(tenantId, async (tx) => {
    const [employees, roles, locations] = await Promise.all([
      tx.employee.findMany({ where: { tenantId }, orderBy: { firstName: "asc" } }),
      tx.role.findMany({ where: { tenantId }, select: { id: true, roleName: true } }),
      tx.location.findMany({ where: { tenantId }, select: { id: true, locationName: true } }),
    ]);

    const roleNameById = new Map(roles.map((r) => [r.id, r.roleName]));
    const locationNameById = new Map(locations.map((l) => [l.id, l.locationName]));

    return employees.map((e) => ({
      id: e.id,
      employeeCode: e.employeeCode,
      firstName: e.firstName,
      middleName: e.middleName,
      lastName: e.lastName,
      gender: e.gender,
      dateOfBirth: e.dateOfBirth,
      phone: e.phone,
      alternativePhone: e.alternativePhone,
      email: e.email,
      department: e.department,
      jobTitle: e.jobTitle,
      hireDate: e.hireDate,
      status: e.status,
      roleName: e.roleId ? (roleNameById.get(e.roleId) ?? null) : null,
      branchName: e.branchId ? (locationNameById.get(e.branchId) ?? null) : null,
    }));
  });
}

export type SalaryLineItem = { name: string; amountCents: number };

export type SalarySummary = {
  id: string;
  payslipNumber: string;
  payPeriod: string;
  basicSalaryCents: number;
  allowances: SalaryLineItem[];
  deductions: SalaryLineItem[];
  allowancesCents: number;
  deductionsCents: number;
  netPayCents: number;
  paymentMethodName: string | null;
  paymentReference: string | null;
  status: string;
  notes: string | null;
  createdAt: string;
};

function asLineItems(value: unknown): SalaryLineItem[] {
  return Array.isArray(value) ? (value as SalaryLineItem[]) : [];
}

export async function getEmployeeSalaries(tenantId: string, employeeId: string): Promise<SalarySummary[]> {
  return withTenantContext(tenantId, async (tx) => {
    const [salaries, paymentMethods] = await Promise.all([
      tx.salary.findMany({ where: { tenantId, employeeId }, orderBy: { localCreatedAt: "desc" } }),
      tx.paymentMethod.findMany({ where: { tenantId }, select: { id: true, name: true } }),
    ]);

    const paymentMethodNameById = new Map(paymentMethods.map((p) => [p.id, p.name]));

    return salaries.map((s) => ({
      id: s.id,
      payslipNumber: s.payslipNumber,
      payPeriod: s.payPeriod,
      basicSalaryCents: s.basicSalaryCents,
      allowances: asLineItems(s.allowancesJson),
      deductions: asLineItems(s.deductionsJson),
      allowancesCents: s.allowancesCents,
      deductionsCents: s.deductionsCents,
      netPayCents: s.netPayCents,
      paymentMethodName: s.paymentMethodId ? (paymentMethodNameById.get(s.paymentMethodId) ?? null) : null,
      paymentReference: s.paymentReference,
      status: s.status,
      notes: s.notes,
      createdAt: s.localCreatedAt.toISOString(),
    }));
  });
}
