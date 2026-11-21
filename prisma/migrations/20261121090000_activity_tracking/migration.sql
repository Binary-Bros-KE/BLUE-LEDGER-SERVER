-- Activity tab: who's signed in on each till, and when each person was last seen on desktop / phone.
ALTER TABLE "devices" ADD COLUMN "currentEmployeeId" TEXT;
ALTER TABLE "devices" ADD COLUMN "currentEmployeeName" TEXT;
ALTER TABLE "employees" ADD COLUMN "lastDesktopSeenAt" TIMESTAMP(3);
ALTER TABLE "employees" ADD COLUMN "lastMobileSeenAt" TIMESTAMP(3);
