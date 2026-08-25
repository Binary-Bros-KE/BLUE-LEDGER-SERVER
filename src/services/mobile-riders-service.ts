import { randomUUID } from "node:crypto";
import { withTenantContext } from "../lib/tenant-context.js";
import { type MobileCreateRiderInput, mobileCreateRiderSchema } from "../schemas/mobile.js";

/** Same synthetic deviceId used by every other Owner-App-originated write — see
 * mobile-checkout-service.ts's own doc comment for why. */
const OWNER_APP_DEVICE_ID = "owner-app";

export type MobileRider = { id: string; name: string; phone: string; vehicleDescription: string | null };

const RIDER_SELECT = { id: true, name: true, phone: true, vehicleDescription: true } as const;

/** Backs the Checkout delivery modal's rider picker AND the Riders tab — riders have no code/
 * numbering scheme (unlike customers), so this is simpler than mobile-customers-service.ts. */
export async function listRiders(tenantId: string): Promise<MobileRider[]> {
  return withTenantContext(tenantId, async (tx) =>
    tx.rider.findMany({
      where: { tenantId, status: "active" },
      select: RIDER_SELECT,
      orderBy: { name: "asc" },
    }),
  );
}

/** The fast path for adding a rider mid-checkout — mirrors DESKTOP's own QuickCreateRiderModal
 * (ExtraChargesSection.tsx): name + phone required, vehicle description optional, altPhone/company
 * left blank (editable later from DESKTOP's Riders screen). */
export async function createRider(tenantId: string, input: unknown): Promise<MobileRider> {
  const parsed: MobileCreateRiderInput = mobileCreateRiderSchema.parse(input);
  const now = new Date();

  return withTenantContext(tenantId, async (tx) =>
    tx.rider.create({
      data: {
        id: `rider_${randomUUID()}`,
        tenantId,
        deviceId: OWNER_APP_DEVICE_ID,
        name: parsed.name,
        phone: parsed.phone,
        altPhone: null,
        company: null,
        vehicleDescription: parsed.vehicleDescription ?? null,
        status: "active",
        localCreatedAt: now,
        localUpdatedAt: now,
      },
      select: RIDER_SELECT,
    }),
  );
}
