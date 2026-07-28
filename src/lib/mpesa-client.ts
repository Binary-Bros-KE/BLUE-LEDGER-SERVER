/**
 * Thin wrapper around Safaricom's Daraja API — STK Push (Buy Goods / Till only, per explicit
 * product decision; Paybill is out of scope) for a single storefront's own credentials. No SDK
 * dependency — three plain `fetch` calls, matching this server's existing style (native fetch
 * throughout, no axios anywhere else in this codebase).
 */

const SANDBOX_BASE_URL = "https://sandbox.safaricom.co.ke";
const PRODUCTION_BASE_URL = "https://api.safaricom.co.ke";

export type MpesaEnvironment = "sandbox" | "production";

export type TillCredentials = {
  environment: string;
  consumerKey: string;
  consumerSecret: string;
  passkey: string;
  shortcode: string;
  tillNumber: string;
  accountReference: string;
};

function baseUrlFor(environment: string): string {
  return environment === "production" ? PRODUCTION_BASE_URL : SANDBOX_BASE_URL;
}

/** Kenyan MSISDN, normalized to the bare 2547XXXXXXXX/2541XXXXXXXX form Safaricom's API requires —
 * handles every shape a cashier might type or a customer record might store (0712345678,
 * 712345678, +254712345678, 254712345678). STK Push is Kenya-only, so no other country code is
 * ever valid input here. */
export function normalizeKenyanMsisdn(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  if (digits.startsWith("254")) return digits;
  if (digits.startsWith("0")) return `254${digits.slice(1)}`;
  return `254${digits}`;
}

function stkTimestamp(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

class MpesaApiError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "MpesaApiError";
  }
}

export async function getAccessToken(credentials: Pick<TillCredentials, "environment" | "consumerKey" | "consumerSecret">): Promise<string> {
  const auth = Buffer.from(`${credentials.consumerKey}:${credentials.consumerSecret}`).toString("base64");
  const url = `${baseUrlFor(credentials.environment)}/oauth/v1/generate?grant_type=client_credentials`;

  let response: Response;
  try {
    response = await fetch(url, { headers: { Authorization: `Basic ${auth}` } });
  } catch (err) {
    throw new MpesaApiError("Could not reach Safaricom to authenticate", err);
  }
  if (!response.ok) {
    throw new MpesaApiError(`Safaricom rejected the Till credentials (${response.status})`);
  }
  const body = (await response.json()) as { access_token?: string };
  if (!body.access_token) {
    throw new MpesaApiError("Safaricom did not return an access token");
  }
  return body.access_token;
}

export type StkPushResult = { merchantRequestId: string; checkoutRequestId: string };

/** Initiates one STK Push prompt on the customer's phone. Amount is passed in whole KES (Safaricom
 * doesn't accept cents) — callers convert from amountCents before calling this. */
export async function initiateStkPush(params: {
  credentials: TillCredentials;
  accessToken: string;
  phone: string;
  amountKes: number;
  callbackUrl: string;
}): Promise<StkPushResult> {
  const { credentials, accessToken, phone, amountKes, callbackUrl } = params;
  const timestamp = stkTimestamp(new Date());
  const password = Buffer.from(`${credentials.shortcode}${credentials.passkey}${timestamp}`).toString("base64");
  const msisdn = normalizeKenyanMsisdn(phone);

  const body = {
    BusinessShortCode: credentials.shortcode,
    Password: password,
    Timestamp: timestamp,
    TransactionType: "CustomerBuyGoodsOnline",
    Amount: amountKes,
    PartyA: msisdn,
    PartyB: credentials.tillNumber,
    PhoneNumber: msisdn,
    CallBackURL: callbackUrl,
    AccountReference: credentials.accountReference || "Blue Ledger POS",
    TransactionDesc: "POS sale",
  };

  let response: Response;
  try {
    response = await fetch(`${baseUrlFor(credentials.environment)}/mpesa/stkpush/v1/processrequest`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new MpesaApiError("Could not reach Safaricom to send the STK push", err);
  }

  const responseBody = (await response.json().catch(() => ({}))) as {
    MerchantRequestID?: string;
    CheckoutRequestID?: string;
    errorMessage?: string;
    ResponseDescription?: string;
  };

  if (!response.ok || !responseBody.CheckoutRequestID) {
    throw new MpesaApiError(responseBody.errorMessage ?? responseBody.ResponseDescription ?? `Safaricom rejected the STK push (${response.status})`);
  }

  return { merchantRequestId: responseBody.MerchantRequestID ?? "", checkoutRequestId: responseBody.CheckoutRequestID };
}

export type StkQueryResult = { resultCode: number; resultDescription: string };

/** Actively asks Safaricom "what actually happened to this CheckoutRequestID" — the authoritative
 * check the user specifically wanted alongside (not instead of) the passive callback, since a
 * callback can be delayed, dropped, or arrive after the cashier's own app already moved on. */
export async function queryStkStatus(params: {
  credentials: TillCredentials;
  accessToken: string;
  checkoutRequestId: string;
}): Promise<StkQueryResult> {
  const { credentials, accessToken, checkoutRequestId } = params;
  const timestamp = stkTimestamp(new Date());
  const password = Buffer.from(`${credentials.shortcode}${credentials.passkey}${timestamp}`).toString("base64");

  const body = {
    BusinessShortCode: credentials.shortcode,
    Password: password,
    Timestamp: timestamp,
    CheckoutRequestID: checkoutRequestId,
  };

  let response: Response;
  try {
    response = await fetch(`${baseUrlFor(credentials.environment)}/mpesa/stkpushquery/v1/query`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new MpesaApiError("Could not reach Safaricom to check payment status", err);
  }

  const responseBody = (await response.json().catch(() => ({}))) as {
    ResultCode?: string | number;
    ResultDesc?: string;
    errorMessage?: string;
  };

  // Safaricom returns HTTP 500 with a real, meaningful ResultCode/errorMessage for a query made
  // "too soon" (customer hasn't responded yet) — that's a legitimate "still pending" answer, not a
  // transport failure, so this deliberately does NOT throw on a non-ok response the way the other
  // two calls do; the caller decides what a given code means.
  if (responseBody.ResultCode === undefined) {
    throw new MpesaApiError(responseBody.errorMessage ?? "Safaricom did not return a result for this query");
  }

  return {
    resultCode: typeof responseBody.ResultCode === "string" ? parseInt(responseBody.ResultCode, 10) : responseBody.ResultCode,
    resultDescription: responseBody.ResultDesc ?? "",
  };
}

/** Shared by every STK flow this codebase has (sales mpesa-service.ts, platform billing-mpesa-
 * service.ts) — both the passive callback and the manual active-query check funnel through this
 * for both, so no two flows can ever disagree about what a given ResultCode means. Every code below
 * is Safaricom's own documented STK callback ResultCode. 2001 ("The initiator information is
 * invalid") is what Safaricom actually returns for a wrong PIN entry in practice — split out from
 * the generic "failed" bucket so the user sees "Wrong PIN" specifically, not a vague failure. */
export function mapResultCodeToStatus(resultCode: number): string {
  if (resultCode === 0) return "success";
  if (resultCode === 1) return "insufficient";
  if (resultCode === 1032) return "cancelled";
  if (resultCode === 2001) return "wrong_pin";
  if (resultCode === 1037) return "timeout";
  return "failed";
}

/** Clean, standardized wording — never Safaricom's own raw ResultDesc text, which is stored for
 * audit purposes only and never surfaced to an end user. */
export function friendlyMessageFor(status: string): string {
  switch (status) {
    case "success":
      return "Success";
    case "insufficient":
      return "Insufficient funds";
    case "cancelled":
      return "Cancelled by user";
    case "wrong_pin":
      return "Wrong credentials (M-Pesa PIN)";
    case "timeout":
      return "Timeout";
    case "failed":
      return "Payment failed";
    default:
      return "Waiting for the customer to enter their M-Pesa PIN...";
  }
}
