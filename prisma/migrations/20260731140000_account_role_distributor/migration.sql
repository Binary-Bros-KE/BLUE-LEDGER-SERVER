-- AlterEnum
-- Added alongside MARKETER, not a replacement — existing accounts stored with role='MARKETER' are
-- untouched. This just makes 'DISTRIBUTOR' a valid value going forward.
ALTER TYPE "AccountRole" ADD VALUE 'DISTRIBUTOR';
