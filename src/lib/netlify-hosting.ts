/**
 * Keeps the storefront's Netlify project in step with the shops we provision.
 *
 * Netlify only serves HTTPS for hostnames listed on the project (its primary domain + "domain
 * aliases"); anything else gets Netlify's default *.netlify.app certificate → a browser
 * ERR_CERT_COMMON_NAME_INVALID. So every shop hostname — its `<subdomain>.<STOREFRONT_BASE_DOMAIN>`
 * preview address and any custom domain — must be added as an alias. This does that through the
 * Netlify API whenever the admin dashboard provisions a store / changes its subdomain / connects or
 * removes a domain, so a new client needs no manual Netlify step.
 *
 * DNS is separate and unchanged: `*.shops.…` already CNAMEs to the Netlify project (grey-cloud /
 * "DNS only" in Cloudflare — Netlify needs direct traffic to issue certificates); a client's own
 * domain is pointed by them, as the dashboard's Connect Domain instructions say.
 *
 * Off until NETLIFY_API_TOKEN + NETLIFY_SITE_ID are set. Never throws: the database is the source of
 * truth for shops, so a hosting failure is REPORTED to the admin (with a retry button) rather than
 * failing the action.
 */
import { env } from "../env.js";

const API = "https://api.netlify.com/api/v1";

export type HostingResult = { ok: boolean; detail: string };

export function isHostingAutomationConfigured(): boolean {
  return Boolean(env.NETLIFY_API_TOKEN && env.NETLIFY_SITE_ID);
}

/** Local/dev hosts (localhost, ports, bare labels) never go to Netlify. */
function isPublicHostname(host: string): boolean {
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) && !host.includes("localhost");
}

/** The preview address for a subdomain, or null when the base domain is local. */
export function previewHostname(subdomain: string): string | null {
  const host = `${subdomain}.${env.STOREFRONT_BASE_DOMAIN}`.toLowerCase();
  return isPublicHostname(host) ? host : null;
}

async function netlify(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${env.NETLIFY_API_TOKEN}`,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
    signal: AbortSignal.timeout(15_000),
  });
}

/** The project's Let's Encrypt certificate: which hostnames it covers and any renewal error. */
async function readCertificate(site: string): Promise<{ domains: string[]; error: string | null } | null> {
  try {
    const res = await netlify(`/sites/${site}/ssl`);
    if (!res.ok) return null;
    const c = (await res.json()) as { domains?: string[]; renewal_error_message?: string | null };
    return { domains: (c.domains ?? []).map((d) => d.toLowerCase()), error: c.renewal_error_message?.trim() || null };
  } catch {
    return null;
  }
}

/**
 * Adds `add` and removes `remove` from the project's domain aliases (idempotent). Only ever touches
 * the hostnames passed in — the project's primary domain and any other aliases are left alone.
 */
export async function syncStoreHostnames(opts: {
  add?: (string | null | undefined)[];
  remove?: (string | null | undefined)[];
}): Promise<HostingResult> {
  const clean = (xs?: (string | null | undefined)[]) =>
    (xs ?? []).filter((h): h is string => Boolean(h)).map((h) => h.toLowerCase()).filter(isPublicHostname);
  const add = clean(opts.add);
  const remove = clean(opts.remove).filter((h) => !add.includes(h));
  if (add.length === 0 && remove.length === 0) return { ok: true, detail: "No public hostnames to sync" };

  if (!isHostingAutomationConfigured()) {
    return {
      ok: false,
      detail: `Netlify automation isn't configured on the server — add ${add.join(", ") || "the new domain"} as a domain alias in Netlify manually.`,
    };
  }

  const site = encodeURIComponent(env.NETLIFY_SITE_ID);
  try {
    const res = await netlify(`/sites/${site}`);
    if (!res.ok) return { ok: false, detail: `Netlify: couldn't read the site (${res.status})` };
    const data = (await res.json()) as { custom_domain?: string | null; domain_aliases?: string[] | null };
    const primary = (data.custom_domain ?? "").toLowerCase();
    const current = (data.domain_aliases ?? []).map((a) => a.toLowerCase());

    const added = add.filter((h) => h !== primary && !current.includes(h));
    const removed = remove.filter((h) => current.includes(h));
    const next = [...current.filter((a) => !removed.includes(a)), ...added];
    const changed = next.length !== current.length || next.some((a, i) => a !== current[i]);

    if (changed) {
      const upd = await netlify(`/sites/${site}`, { method: "PATCH", body: JSON.stringify({ domain_aliases: next }) });
      if (!upd.ok) {
        const body = await upd.text().catch(() => "");
        return { ok: false, detail: `Netlify: couldn't update domain aliases (${upd.status}) ${body.slice(0, 160)}` };
      }
    }

    const parts = [
      added.length ? `added ${added.join(", ")}` : "",
      removed.length ? `removed ${removed.join(", ")}` : "",
    ].filter(Boolean);
    const aliasNote = changed ? `Netlify updated (${parts.join("; ")}).` : "Netlify already had these domains.";

    // Netlify issues ONE certificate for every domain on the project and (re)provisions it by itself
    // after an alias change — there's no API call to force it. What we CAN do is report its state:
    // a single broken domain (e.g. a www with no DNS record) stalls the whole certificate, and
    // Netlify says so in renewal_error_message. Surfacing that turns "cert error in the browser"
    // into an actionable message in the dashboard.
    const cert = await readCertificate(site);
    const missing = add.filter((h) => cert && !cert.domains.includes(h));
    if (cert?.error) {
      return { ok: false, detail: `${aliasNote} HTTPS is blocked on Netlify: ${cert.error}` };
    }
    if (missing.length > 0) {
      return {
        ok: true,
        detail: `${aliasNote} HTTPS certificate not issued yet for ${missing.join(", ")} — Netlify usually adds it within minutes; press Sync again to re-check.`,
      };
    }
    return { ok: true, detail: `${aliasNote} HTTPS certificate covers ${add.length ? add.join(", ") : "the domains"}.` };
  } catch (err) {
    return { ok: false, detail: `Netlify unreachable: ${err instanceof Error ? err.message : String(err)}` };
  }
}
