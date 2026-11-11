/** A request has one decision; stale/offline copies cannot reopen or reverse it. */
export function stockRequestDecisionConflict(
  existing: { status?: unknown; localUpdatedAt?: Date } | null,
  incoming: { status?: unknown; localUpdatedAt?: unknown },
): boolean {
  if (
    !existing ||
    (existing.status !== "approved" && existing.status !== "rejected")
  )
    return false;
  if (incoming.status !== existing.status) return true;
  const incomingAt =
    typeof incoming.localUpdatedAt === "string"
      ? Date.parse(incoming.localUpdatedAt)
      : NaN;
  return (
    !Number.isFinite(incomingAt) ||
    Boolean(
      existing.localUpdatedAt && incomingAt < existing.localUpdatedAt.getTime(),
    )
  );
}
