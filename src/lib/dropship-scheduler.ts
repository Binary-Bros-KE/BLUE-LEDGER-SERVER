import { prisma } from "../prisma.js";
import { mirrorConnection, syncCatalog } from "../services/dropship-service.js";

/** How often a reseller's stock is brought back in line with its supplier's live total. The
 * supplier's own number only moves when its devices sync (DESKTOP pushes every ~20s), so a few
 * seconds here keeps the reseller effectively live without hammering anything. */
const MIRROR_INTERVAL_MS = 10 * 1000;
/** How often an autoImport connection picks up products the supplier has added since. */
const CATALOG_INTERVAL_MS = 10 * 60 * 1000;

let running = false;

/**
 * Plain setInterval, same convention as billing-scheduler.ts. Only ever looks at ACTIVE connections
 * whose reseller has dropshippingEnabled — for every other tenant this is one empty indexed lookup
 * per tick and nothing more: none of their requests, syncs or ledgers are touched.
 *
 * Each connection is isolated: one failing (e.g. a deleted target location) records lastError on
 * its own row and never stops the others.
 */
export async function runDropshipSweep(): Promise<void> {
  if (running) return; // a slow pass is never overlapped by the next tick
  running = true;
  try {
    const connections = await prisma.dropshipConnection.findMany({
      where: { status: "active", reseller: { dropshippingEnabled: true } },
      select: { id: true, autoImport: true, lastCatalogSyncAt: true },
    });
    const now = Date.now();
    for (const connection of connections) {
      try {
        if (connection.autoImport && (!connection.lastCatalogSyncAt || now - connection.lastCatalogSyncAt.getTime() >= CATALOG_INTERVAL_MS)) {
          await syncCatalog(connection.id, { importMissing: true });
        }
        await mirrorConnection(connection.id);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[dropship-scheduler] connection ${connection.id} failed:`, err);
        await prisma.dropshipConnection
          .update({ where: { id: connection.id }, data: { lastError: message.slice(0, 1000) } })
          .catch(() => undefined);
      }
    }
  } catch (err) {
    console.error("[dropship-scheduler] sweep failed:", err);
  } finally {
    running = false;
  }
}

/** Called once at server boot (see index.ts). */
export function startDropshipScheduler(): void {
  void runDropshipSweep();
  setInterval(() => void runDropshipSweep(), MIRROR_INTERVAL_MS);
}
