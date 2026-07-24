import { withTenantContext } from "../lib/tenant-context.js";
import { prisma } from "../prisma.js";

/** Employee directory + payslip history for the Owner App's Employees tab. Employee.roleId/
 * branchId and Salary.paymentMethodId are opaque strings (no real FK — same convention as every
 * other synced entity), resolved to display names via one-time maps, same pattern already used in
 * mobile-metrics-service.ts for Product/Customer references. */

export type MobileSessionInfo = { employeeName: string; roleName: string | null; currency: string };

/** Backs the Owner App's sidebar footer (name + role) and gives every tab the tenant's currency
 * without each one needing its own round trip — a small, dedicated lookup rather than folding this
 * into the JWT payload itself, since a name/role change should be reflected without waiting for the
 * 7-day token to be re-issued. */
export async function getMe(tenantId: string, employeeId: string): Promise<MobileSessionInfo> {
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { currency: true } });
  return withTenantContext(tenantId, async (tx) => {
    const employee = await tx.employee.findUniqueOrThrow({ where: { id: employeeId } });
    const role = employee.roleId ? await tx.role.findUnique({ where: { id: employee.roleId } }) : null;
    return {
      employeeName: `${employee.firstName} ${employee.lastName}`.trim(),
      roleName: role?.roleName ?? null,
      currency: tenant.currency,
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
