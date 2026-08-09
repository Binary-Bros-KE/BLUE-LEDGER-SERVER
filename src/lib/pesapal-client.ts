/**
 * Thin wrapper around Pesapal's API 3.0 (JSON) — hosted checkout for Card/PayPal, one merchant
 * account for the whole platform (see env.ts's own comment on why these are env vars, unlike
 * M-Pesa's per-Outlet OutletMpesaSettings). No SDK dependency — plain `fetch` calls, matching this
 * server's existing style (mpesa-client.ts does the same).
 */

import { env } from "../env.js";

const SANDBOX_BASE_URL = "https://cybqa.pesapal.com/pesapalv3";
const PRODUCTION_BASE_URL = "https://pay.pesapal.com/v3";

function baseUrl(): string {
  return env.PESAPAL_DEBUG ? SANDBOX_BASE_URL : PRODUCTION_BASE_URL;
}

class PesapalApiError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "PesapalApiError";
  }
}

// Pesapal's token is valid ~5 minutes per their docs — cached in-memory rather than re-authenticating
// on every call, same spirit as re-deriving the M-Pesa access token per request but cheaper given how
// much more frequently status checks happen here (passive polling every 3s from DESKTOP).
let cachedToken: { token: string; expiresAt: number } | null = null;
const TOKEN_TTL_MS = 4 * 60 * 1000;

export async function getAccessToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now()) {
    return cachedToken.token;
  }

  let response: Response;
  try {
    response = await fetch(`${baseUrl()}/api/Auth/RequestToken`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        consumer_key: env.PESAPAL_CONSUMER_KEY,
        consumer_secret: env.PESAPAL_CONSUMER_SECRET,
      }),
    });
  } catch (err) {
    throw new PesapalApiError("Could not reach Pesapal to authenticate", err);
  }

  const body = (await response.json().catch(() => ({}))) as { token?: string; error?: unknown; message?: string };
  if (!response.ok || !body.token) {
    throw new PesapalApiError(body.message ?? `Pesapal rejected the consumer credentials (${response.status})`);
  }

  cachedToken = { token: body.token, expiresAt: Date.now() + TOKEN_TTL_MS };
  return body.token;
}

async function authedFetch<T>(path: string, init: RequestInit): Promise<T> {
  const token = await getAccessToken();
  let response: Response;
  try {
    response = await fetch(`${baseUrl()}${path}`, {
      ...init,
      headers: {
        ...init.headers,
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
    });
  } catch (err) {
    throw new PesapalApiError(`Could not reach Pesapal (${path})`, err);
  }
  const body = (await response.json().catch(() => ({}))) as T & { error?: { message?: string } | string; message?: string };
  if (!response.ok) {
    const errMessage =
      typeof (body as { error?: unknown }).error === "object"
        ? ((body as { error?: { message?: string } }).error?.message ?? undefined)
        : (body as { error?: string }).error;
    throw new PesapalApiError(errMessage ?? (body as { message?: string }).message ?? `Pesapal request failed (${response.status})`);
  }
  return body;
}

export type RegisterIpnResult = { ipn_id: string; url: string };

/** One-time setup call — registers where Pesapal should POST payment notifications. Must be re-run
 * any time SERVER_PUBLIC_URL changes (moving servers, new domain); the resulting ipn_id goes into
 * PESAPAL_IPN_ID and is referenced on every subsequent order submission. See
 * routes/billing-pesapal.ts's own admin/register-ipn route. */
export async function registerIPN(ipnUrl: string): Promise<RegisterIpnResult> {
  return authedFetch<RegisterIpnResult>("/api/URLSetup/RegisterIPN", {
    method: "POST",
    body: JSON.stringify({ url: ipnUrl, ipn_notification_type: "GET" }),
  });
}

export async function getRegisteredIPNs(): Promise<RegisterIpnResult[]> {
  return authedFetch<RegisterIpnResult[]>("/api/URLSetup/GetIpnList", { method: "GET" });
}

export type SubmitOrderParams = {
  merchantReference: string;
  amountCents: number;
  currency: string;
  description: string;
  callbackUrl: string;
  billingAddress: {
    email_address?: string;
    phone_number?: string;
    country_code?: string;
    first_name?: string;
    last_name?: string;
  };
  /** Only present for the "Setup Auto Billing" flow — including these is what makes Pesapal's hosted
   * checkout page show the optional "setup future recurring payments" checkbox at all. A plain "Pay
   * Now" order omits both entirely, so that checkout page never shows it (see PayNowModal.tsx's own
   * comment on why these two flows are kept genuinely separate on the Pesapal side, not just in UI). */
  accountNumber?: string;
  subscriptionDetails?: { start_date: string; frequency: "MONTHLY" | "YEARLY" };
};

export type SubmitOrderResult = { order_tracking_id: string; merchant_reference: string; redirect_url: string };

/** Amount is passed in whole currency units (Pesapal doesn't accept cents) — callers convert from
 * amountCents before calling this, same convention as mpesa-client.ts's amountKes. */
export async function submitOrder(params: SubmitOrderParams): Promise<SubmitOrderResult> {
  const body: Record<string, unknown> = {
    id: params.merchantReference,
    currency: params.currency,
    amount: Math.round(params.amountCents / 100),
    description: params.description,
    callback_url: params.callbackUrl,
    notification_id: env.PESAPAL_IPN_ID,
    billing_address: params.billingAddress,
  };
  if (params.accountNumber) body.account_number = params.accountNumber;
  if (params.subscriptionDetails) body.subscription_details = params.subscriptionDetails;

  const result = await authedFetch<{
    order_tracking_id?: string;
    merchant_reference?: string;
    redirect_url?: string;
    error?: { message?: string };
    status?: string;
  }>("/api/Transactions/SubmitOrderRequest", {
    method: "POST",
    body: JSON.stringify(body),
  });

  if (!result.order_tracking_id || !result.redirect_url) {
    throw new PesapalApiError(result.error?.message ?? "Pesapal did not return a checkout redirect URL");
  }

  return {
    order_tracking_id: result.order_tracking_id,
    merchant_reference: result.merchant_reference ?? params.merchantReference,
    redirect_url: result.redirect_url,
  };
}

export type TransactionStatusResult = {
  status_code: number;
  payment_status_description: string;
  payment_method?: string;
  amount?: number;
  currency?: string;
  confirmation_code?: string;
  created_date?: string;
  merchant_reference?: string;
  subscription_transaction_info?: { correlation_id?: string; status?: string; account_reference?: string } | null;
};

/** Actively asks Pesapal "what actually happened to this order" — used by both the IPN handler
 * (Pesapal's IPN carries no status itself, only an OrderTrackingId — this is the required follow-up
 * call, unlike M-Pesa's callback which carries the result inline) and the manual "Check Status Now"
 * action. */
export async function getTransactionStatus(orderTrackingId: string): Promise<TransactionStatusResult> {
  return authedFetch<TransactionStatusResult>(`/api/Transactions/GetTransactionStatus?orderTrackingId=${encodeURIComponent(orderTrackingId)}`, {
    method: "GET",
  });
}

/** Pesapal's own documented status_code values: 0=INVALID, 1=COMPLETED, 2=FAILED, 3=REVERSED. Mapped
 * to the same style of status vocabulary billing-mpesa-service.ts uses, so callers (PayNowModal.tsx)
 * don't need two different sets of strings depending on which method the tenant picked. */
export function mapPesapalStatus(statusCode: number): "pending" | "success" | "failed" | "reversed" | "invalid" {
  if (statusCode === 1) return "success";
  if (statusCode === 2) return "failed";
  if (statusCode === 3) return "reversed";
  if (statusCode === 0) return "invalid";
  return "pending";
}

export function friendlyPesapalMessageFor(status: string): string {
  switch (status) {
    case "success":
      return "Success";
    case "failed":
      return "Payment failed";
    case "reversed":
      return "Payment was reversed";
    case "invalid":
      return "Invalid or cancelled transaction";
    default:
      return "Waiting for payment to complete...";
  }
}
