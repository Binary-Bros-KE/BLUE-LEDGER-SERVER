import fs from "node:fs";
import path from "node:path";
import cors from "cors";
import express from "express";
import helmet from "helmet";
import morgan from "morgan"; 
import { env } from "./env.js";
import { errorHandler } from "./middleware/error-handler.js";
import { accountsRouter } from "./routes/accounts.js";
import { activationRouter } from "./routes/activation.js";
import { authRouter } from "./routes/auth.js";
import { billingMpesaRouter } from "./routes/billing-mpesa.js";
import { billingPesapalRouter } from "./routes/billing-pesapal.js";
import { mobileRouter } from "./routes/mobile.js";
import { mpesaRouter } from "./routes/mpesa.js";
import { outletsRouter } from "./routes/outlets.js";
import { plansRouter } from "./routes/plans.js";
import { shareRouter } from "./routes/share.js";
import { syncRouter } from "./routes/sync.js";
import { tenantsRouter } from "./routes/tenants.js";

export const app = express();

// Trust exactly one hop — the reverse proxy in front of this app (Caddy on the same VPS). Without
// this, Express refuses to trust the X-Forwarded-For header Caddy sets, which breaks
// express-rate-limit's ability to identify real client IPs (every request looks like it's coming
// from the proxy itself) and throws a ValidationError on every single request. `1` (not `true`) is
// deliberate — it trusts only the immediate connecting proxy, not an arbitrary chain, so a client
// can't spoof their own X-Forwarded-For and have it trusted.
app.set("trust proxy", 1);

app.use(helmet());
app.use(cors({ origin: env.CORS_ORIGINS }));
app.use(morgan("dev"));
// Default express.json() limit is 100kb — comfortably exceeded by a single sync push batch of
// nested documents (sales/quotations/purchases carry items/serviceCharges/delivery inline). The
// desktop client now chunks pushes into bounded batches (see sync-engine.ts's PUSH_BATCH_SIZE), so
// this is headroom for one unusually heavy batch, not a substitute for that chunking.
app.use(express.json({ limit: "10mb" }));

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

// electron-updater's "generic" provider feed — plain static files (the NSIS installer, its
// .blockmap, and latest.yml), no API logic needed at all. Requested by DESKTOP's main process via
// Node's own HTTP client, not a browser fetch, so helmet's CORS/CORP headers above never apply to
// it. Manually populated after each `npm run dist:win` — see RELEASES_DIR's own env.ts comment.
app.use("/releases", express.static(path.resolve(env.RELEASES_DIR)));

// Stable links for installing on a NEW machine (a browser, not electron-updater, on the client's
// own computer) — no USB drive needed. Every route below reads the relevant `latest*.yml`'s own
// `version:` line instead of hardcoding one, then builds the filename from the same
// `artifactName: "Blue-Ledger-POS-${version}-${arch}.${ext}"` pattern DESKTOP's package.json
// configures electron-builder with — so these links never go stale as new versions get uploaded.
// Windows x64/ia32 share one latest.yml (built together in one `dist:win` run); Mac x64/arm64 read
// latest-mac.yml separately (built on its own GitHub Actions run — see DESKTOP's build-mac.yml —
// so it can legitimately lag behind the Windows version between Mac rebuilds).
function releaseVersion(ymlFileName: string): string | null {
  try {
    const contents = fs.readFileSync(path.resolve(env.RELEASES_DIR, ymlFileName), "utf8");
    return /^version:\s*(\S+)\s*$/m.exec(contents)?.[1] ?? null;
  } catch {
    return null;
  }
}

function resolveInstaller(ymlFileName: string, arch: string, ext: string): string | null {
  const version = releaseVersion(ymlFileName);
  if (!version) return null;
  const fileName = `Blue-Ledger-POS-${version}-${arch}.${ext}`;
  return fs.existsSync(path.resolve(env.RELEASES_DIR, fileName)) ? fileName : null;
}

// electron-builder's nsis target, given multiple `arch` entries, builds a THIRD file alongside the
// two per-arch installers: one combined, arch-less installer (artifactName's `-${arch}` segment
// collapses to nothing) that auto-detects x64 vs ia32 Windows at install time. That's the ideal
// link for the no-questions-asked case — bigger download, but it always installs correctly
// regardless of the visitor's machine, so no guessing needed.
function resolveCombinedInstaller(ymlFileName: string, ext: string): string | null {
  const version = releaseVersion(ymlFileName);
  if (!version) return null;
  const fileName = `Blue-Ledger-POS-${version}.${ext}`;
  return fs.existsSync(path.resolve(env.RELEASES_DIR, fileName)) ? fileName : null;
}

function sendNoRelease(res: express.Response): void {
  res.status(503).send("No release is published yet for this platform — try again shortly, or contact support.");
}

app.get("/download/win64", (_req, res) => {
  const file = resolveInstaller("latest.yml", "x64", "exe");
  if (!file) return sendNoRelease(res);
  res.redirect(`/releases/${file}`);
});

app.get("/download/win32", (_req, res) => {
  const file = resolveInstaller("latest.yml", "ia32", "exe");
  if (!file) return sendNoRelease(res);
  res.redirect(`/releases/${file}`);
});

app.get("/download/mac/arm64", (_req, res) => {
  const file = resolveInstaller("latest-mac.yml", "arm64", "dmg");
  if (!file) return sendNoRelease(res);
  res.redirect(`/releases/${file}`);
});

app.get("/download/mac/x64", (_req, res) => {
  const file = resolveInstaller("latest-mac.yml", "x64", "dmg");
  if (!file) return sendNoRelease(res);
  res.redirect(`/releases/${file}`);
});

// Apple silently keeps "Intel" in Safari/Chrome's Mac UA string even on M-series chips (a
// long-standing web-compat shim), so there is no reliable way to auto-detect Mac chip architecture
// server-side — a plain picker page is more honest than guessing wrong and shipping the wrong build.
app.get("/download/mac", (_req, res) => {
  res.type("html").send(`<!doctype html>
<html><head><meta charset="utf-8" /><title>Download Blue Ledger POS for Mac</title>
<style>
  body { font-family: -apple-system, Arial, sans-serif; background: #0b1d4d; color: #fff; display: flex;
    align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
  .card { background: #12275f; border-radius: 16px; padding: 32px 36px; text-align: center; max-width: 360px; }
  h1 { font-size: 18px; margin: 0 0 20px; }
  a { display: block; background: #d4a934; color: #0b1d4d; font-weight: 700; text-decoration: none;
    padding: 12px 20px; border-radius: 8px; margin-top: 12px; }
  p { font-size: 12px; color: #b7c1e0; margin-top: 20px; }
</style></head>
<body><div class="card">
  <h1>Which Mac do you have?</h1>
  <a href="/download/mac/arm64">Apple Silicon (M1/M2/M3/M4)</a>
  <a href="/download/mac/x64">Intel Mac</a>
  <p>Apple menu (&#63743;) → About This Mac tells you which one, if you're not sure.</p>
</div></body></html>`);
});

type HistoryEntry = { version: string; combined: string | null; x64: string | null; ia32: string | null };

// Every build ever uploaded stays in RELEASES_DIR forever (nothing here ever prunes old files —
// see the upload step in the deploy runbook), so a specific past version has always been
// downloadable via a direct /releases/<exact filename> URL. The only real gap was discoverability:
// nothing let you find that filename without already knowing it. This scans for every distinct
// version actually present and renders one link per version, so a bad release can be rolled back
// on an affected machine without waiting on a rebuild.
function listWindowsReleaseHistory(): HistoryEntry[] {
  const dir = path.resolve(env.RELEASES_DIR);
  let files: string[];
  try {
    files = fs.readdirSync(dir);
  } catch {
    return [];
  }

  const versionPattern = /^Blue-Ledger-POS-(\d+\.\d+\.\d+)(?:-(x64|ia32))?\.exe$/;
  const versions = new Set<string>();
  for (const file of files) {
    const match = versionPattern.exec(file);
    if (match?.[1]) versions.add(match[1]);
  }

  return [...versions]
    .sort((a, b) => {
      const partsA = a.split(".").map(Number);
      const partsB = b.split(".").map(Number);
      for (let i = 0; i < 3; i++) {
        const diff = (partsB[i] ?? 0) - (partsA[i] ?? 0);
        if (diff !== 0) return diff;
      }
      return 0;
    })
    .map((version) => {
      const combined = `Blue-Ledger-POS-${version}.exe`;
      const x64 = `Blue-Ledger-POS-${version}-x64.exe`;
      const ia32 = `Blue-Ledger-POS-${version}-ia32.exe`;
      return {
        version,
        combined: files.includes(combined) ? combined : null,
        x64: files.includes(x64) ? x64 : null,
        ia32: files.includes(ia32) ? ia32 : null,
      };
    });
}

app.get("/download/history", (_req, res) => {
  const releases = listWindowsReleaseHistory();
  const rows = releases
    .map(
      (r, i) => `
    <tr${i === 0 ? ' class="latest"' : ""}>
      <td>${r.version}${i === 0 ? ' <span class="badge">latest</span>' : ""}</td>
      <td>${r.combined ? `<a href="/releases/${r.combined}">Combined (32+64-bit)</a>` : "—"}</td>
      <td>${r.x64 ? `<a href="/releases/${r.x64}">64-bit</a>` : "—"}</td>
      <td>${r.ia32 ? `<a href="/releases/${r.ia32}">32-bit</a>` : "—"}</td>
    </tr>`,
    )
    .join("");

  res.type("html").send(`<!doctype html>
<html><head><meta charset="utf-8" /><title>Blue Ledger POS — Release History</title>
<style>
  body { font-family: -apple-system, Arial, sans-serif; background: #0b1d4d; color: #fff; margin: 0;
    padding: 40px 20px; }
  .card { background: #12275f; border-radius: 16px; padding: 28px 32px; max-width: 640px; margin: 0 auto; }
  h1 { font-size: 18px; margin: 0 0 6px; }
  p.sub { font-size: 12px; color: #b7c1e0; margin: 0 0 20px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th { text-align: left; color: #b7c1e0; font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em;
    padding: 6px 8px; border-bottom: 1px solid #22346e; }
  td { padding: 8px; border-bottom: 1px solid #1a2a5c; }
  tr.latest td { font-weight: 700; }
  .badge { background: #d4a934; color: #0b1d4d; font-size: 10px; font-weight: 700; padding: 2px 6px;
    border-radius: 4px; margin-left: 4px; }
  a { color: #d4a934; text-decoration: none; }
  a:hover { text-decoration: underline; }
</style></head>
<body><div class="card">
  <h1>Blue Ledger POS — Windows Release History</h1>
  <p class="sub">Every version ever published, newest first. Use this to roll an affected machine back to a
    known-working version if a new release causes a problem — install directly over the existing app,
    no uninstall needed.</p>
  <table>
    <thead><tr><th>Version</th><th>Combined</th><th>64-bit</th><th>32-bit</th></tr></thead>
    <tbody>${rows || '<tr><td colspan="4">No releases found.</td></tr>'}</tbody>
  </table>
</div></body></html>`);
});

app.get("/download", (req, res) => {
  const ua = req.headers["user-agent"] ?? "";
  if (/Macintosh/i.test(ua)) {
    res.redirect("/download/mac");
    return;
  }
  // The combined installer works on both 32-bit and 64-bit Windows, so the no-questions-asked link
  // never has to guess. /download/win64 and /download/win32 stay available as smaller, precise
  // downloads for anyone who already knows which one they need.
  const file = resolveCombinedInstaller("latest.yml", "exe");
  if (!file) return sendNoRelease(res);
  res.redirect(`/releases/${file}`);
});

app.use("/auth", authRouter);
app.use("/tenants", tenantsRouter);
app.use("/accounts", accountsRouter);
app.use("/outlets", outletsRouter);
app.use("/plans", plansRouter);
app.use("/activation", activationRouter);
app.use("/sync", syncRouter);
app.use("/mobile", mobileRouter);
app.use("/share", shareRouter);
app.use("/mpesa", mpesaRouter);
app.use("/billing-mpesa", billingMpesaRouter);
app.use("/billing-pesapal", billingPesapalRouter);

// Must be registered last — Express only treats a 4-arg function as an error handler.
app.use(errorHandler);
