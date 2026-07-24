/**
 * One-off bootstrap: creates (or updates the password of) the very first SUPER_ADMIN account.
 * There's no self-signup flow by design — every other Account is created BY a super admin, through
 * the Accounts tab, once this one exists. Safe to re-run: upserts by email.
 *
 * Usage: SUPER_ADMIN_EMAIL=you@company.com SUPER_ADMIN_PASSWORD=... npx tsx prisma/seed-super-admin.ts
 */
import bcrypt from "bcryptjs";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main(): Promise<void> {
  const email = process.env.SUPER_ADMIN_EMAIL;
  const password = process.env.SUPER_ADMIN_PASSWORD;
  const name = process.env.SUPER_ADMIN_NAME ?? "Super Admin";

  if (!email || !password) {
    console.error("Set SUPER_ADMIN_EMAIL and SUPER_ADMIN_PASSWORD before running this script.");
    process.exit(1);
  }

  const passwordHash = await bcrypt.hash(password, 10);

  const account = await prisma.account.upsert({
    where: { email: email.toLowerCase() },
    update: { passwordHash, role: "SUPER_ADMIN", isActive: true },
    create: {
      name,
      email: email.toLowerCase(),
      passwordHash,
      role: "SUPER_ADMIN",
      outletId: null,
      isActive: true,
    },
  });

  console.log(`Super admin ready: ${account.email} (id: ${account.id})`);
}

main()
  .catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => void prisma.$disconnect());
