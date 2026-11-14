// square.ts — the one Square call the self-serve kiosk needs: CreatePayment
// for a Cash App Pay token from the Web Payments SDK. Plain fetch (no Square
// SDK dependency); fetch is injectable so tests never touch the network.
//
// Config comes from env only. The access token never leaves the server:
// squarePublicConfig() is what the kiosk page receives.

export type SquareEnvironment = "sandbox" | "production";

export type SquareConfig = {
  environment: SquareEnvironment;
  applicationId: string;
  locationId: string;
  accessToken: string;
  /** Optional Square-Version header; Square uses the app's default if unset. */
  apiVersion?: string;
};

export const SQUARE_SDK_URLS: Record<SquareEnvironment, string> = {
  sandbox: "https://sandbox.web.squarecdn.com/v1/square.js",
  production: "https://web.squarecdn.com/v1/square.js",
};

export const SQUARE_API_BASES: Record<SquareEnvironment, string> = {
  sandbox: "https://connect.squareupsandbox.com",
  production: "https://connect.squareup.com",
};

/** Reads SQUARE_* env. Returns null (Square off) unless all three ids are set. */
export function squareConfigFromEnv(
  get: (name: string) => string | undefined,
): SquareConfig | null {
  const value = (name: string) => (get(name) ?? "").trim();
  const applicationId = value("SQUARE_APPLICATION_ID");
  const locationId = value("SQUARE_LOCATION_ID");
  const accessToken = value("SQUARE_ACCESS_TOKEN");
  if (!applicationId || !locationId || !accessToken) return null;
  const environment: SquareEnvironment =
    value("SQUARE_ENVIRONMENT") === "production" ? "production" : "sandbox";
  const apiVersion = value("SQUARE_VERSION") || undefined;
  return { environment, applicationId, locationId, accessToken, apiVersion };
}

export function squarePublicConfig(cfg: SquareConfig) {
  return {
    environment: cfg.environment,
    applicationId: cfg.applicationId,
    locationId: cfg.locationId,
    sdkUrl: SQUARE_SDK_URLS[cfg.environment],
  };
}

export type CreatePaymentInput = {
  sourceId: string;
  idempotencyKey: string;
  amountCents: number;
  referenceId?: string;
  note?: string;
};

export type CreatePaymentResult =
  | {
    ok: true;
    paymentId: string;
    status: string;
    receiptUrl: string | null;
    receiptNumber: string | null;
  }
  | { ok: false; code: string; message: string };

/** Thrown when the charge outcome is unknown (network failure, 5xx). */
export class SquareUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SquareUnavailableError";
  }
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * POST /v2/payments with autocomplete. A 4xx answer is definitive (nothing
 * charged); a network error or 5xx throws SquareUnavailableError because the
 * money may or may not have moved.
 */
export async function createSquarePayment(
  cfg: SquareConfig,
  input: CreatePaymentInput,
  fetchImpl: FetchLike = fetch,
): Promise<CreatePaymentResult> {
  const headers: Record<string, string> = {
    "authorization": `Bearer ${cfg.accessToken}`,
    "content-type": "application/json",
    "accept": "application/json",
  };
  if (cfg.apiVersion) headers["square-version"] = cfg.apiVersion;
  const body = {
    source_id: input.sourceId,
    idempotency_key: input.idempotencyKey,
    amount_money: { amount: input.amountCents, currency: "USD" },
    location_id: cfg.locationId,
    autocomplete: true,
    ...(input.referenceId
      ? { reference_id: input.referenceId.slice(0, 40) }
      : {}),
    ...(input.note ? { note: input.note.slice(0, 500) } : {}),
  };

  let res: Response;
  try {
    res = await fetchImpl(`${SQUARE_API_BASES[cfg.environment]}/v2/payments`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    throw new SquareUnavailableError(
      `Square request failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  // deno-lint-ignore no-explicit-any
  let data: any = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }

  if (res.status >= 500) {
    throw new SquareUnavailableError(`Square answered ${res.status}`);
  }
  const payment = data?.payment;
  if (res.ok && payment && typeof payment.id === "string") {
    if (payment.status === "COMPLETED") {
      return {
        ok: true,
        paymentId: payment.id,
        status: payment.status,
        receiptUrl: typeof payment.receipt_url === "string"
          ? payment.receipt_url
          : null,
        receiptNumber: typeof payment.receipt_number === "string"
          ? payment.receipt_number
          : null,
      };
    }
    return {
      ok: false,
      code: String(payment.status || "NOT_COMPLETED"),
      message: `Payment ${
        String(payment.status || "was not completed").toLowerCase()
      }`,
    };
  }
  if (res.ok) {
    throw new SquareUnavailableError("Square answered without a payment");
  }
  const first = Array.isArray(data?.errors) ? data.errors[0] : null;
  if (!res.ok && !first && res.status !== 400 && res.status !== 402) {
    // e.g. 401 bad token: definitive (nothing charged) but a setup problem.
    return {
      ok: false,
      code: `HTTP_${res.status}`,
      message: `Square answered ${res.status}`,
    };
  }
  return {
    ok: false,
    code: String(first?.code || "UNKNOWN"),
    message: String(first?.detail || first?.code || "Payment was declined"),
  };
}
