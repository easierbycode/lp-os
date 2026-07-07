// Kill switches for third-party APIs the shell calls out to. Layered ABOVE
// key/credential gating: off wins even when a key is configured; on without a
// key keeps the existing "not configured" behavior. Flip one with
// EXTERNAL_API_<NAME>=on|off (true/false/1/0/yes/no also accepted); unset
// falls back to the registry default. Env is injected (never read here) so
// the module stays dependency-free like the packages.

export type ExternalApiName = "scrapecreators" | "ebay" | "barcodelookup";

export type EnvReader = (name: string) => string | undefined;

// barcodelookup defaults OFF: its API key expired 2026-07; the provider is
// registered ahead of the kiosk/UPC-lookup port so re-enabling after a new
// key is EXTERNAL_API_BARCODELOOKUP=on, not a code change.
const DEFAULTS: Record<ExternalApiName, boolean> = {
  scrapecreators: true,
  ebay: true,
  barcodelookup: false,
};

export const EXTERNAL_API_NAMES = Object.keys(DEFAULTS) as ExternalApiName[];

function parseToggle(raw: string | undefined): boolean | null {
  const v = (raw || "").trim().toLowerCase();
  if (["on", "true", "1", "yes"].includes(v)) return true;
  if (["off", "false", "0", "no"].includes(v)) return false;
  return null;
}

export function externalApiEnabled(
  env: EnvReader,
  name: ExternalApiName,
): boolean {
  return parseToggle(env(`EXTERNAL_API_${name.toUpperCase()}`)) ??
    DEFAULTS[name];
}

export class ExternalApiDisabledError extends Error {
  readonly api: ExternalApiName;
  constructor(api: ExternalApiName) {
    super(`${api} disabled`);
    this.api = api;
  }
}

/** Throws ExternalApiDisabledError when the switch is off. */
export function requireExternalApi(env: EnvReader, name: ExternalApiName) {
  if (!externalApiEnabled(env, name)) throw new ExternalApiDisabledError(name);
}

/** Flag states for /health and /api/health payloads. */
export function externalApiStates(
  env: EnvReader,
): Record<ExternalApiName, "on" | "off"> {
  const states = {} as Record<ExternalApiName, "on" | "off">;
  for (const name of EXTERNAL_API_NAMES) {
    states[name] = externalApiEnabled(env, name) ? "on" : "off";
  }
  return states;
}
