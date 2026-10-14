import {
  getRuntimeMode,
  isSet,
  type RuntimeEnv,
  type RuntimeMode
} from './getRuntimeMode.js';

/**
 * Boot guard for the runtime mode (ADR-08), called from `bootstrap.ts`.
 *
 * - development: no requirement (mocks decide per provider).
 * - demo: any real credential aborts the boot, so a demo can never send real
 *   WhatsApp messages or issue real fiscal documents.
 * - production: fails closed. Missing WhatsApp credentials, missing SIFEN
 *   settings or no real SIFEN provider abort the boot (G-1): a silent mock
 *   would mean quotes "sent" that nobody receives and invoices "issued" that
 *   do not exist.
 *
 * Error messages name variables only, never their values.
 */

/** Real credentials that must not exist in demo mode (ADR-08 item 2). */
export const DEMO_FORBIDDEN_CREDENTIALS = [
  'WHATSAPP_ACCESS_TOKEN',
  'WHATSAPP_APP_SECRET',
  'WHATSAPP_PHONE_NUMBER_ID',
  'SIFEN_CERT_PATH',
  'SIFEN_CERT_PASSWORD',
  'SIFEN_CSC'
] as const;

/** WhatsApp Cloud API settings required in production (project CLAUDE.md section 3). */
export const REQUIRED_WHATSAPP_CREDENTIALS = [
  'WHATSAPP_ACCESS_TOKEN',
  'WHATSAPP_PHONE_NUMBER_ID',
  'WHATSAPP_APP_SECRET',
  'WHATSAPP_WEBHOOK_VERIFY_TOKEN'
] as const;

/** SIFEN settings required in production (architecture doc section 7). */
export const REQUIRED_SIFEN_CREDENTIALS = [
  'SIFEN_ENVIRONMENT',
  'SIFEN_CERT_PATH',
  'SIFEN_CERT_PASSWORD',
  'SIFEN_CSC_ID',
  'SIFEN_CSC'
] as const;

export const SIFEN_ENVIRONMENTS = ['test', 'production'] as const;

export class RuntimeConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RuntimeConfigError';
  }
}

export interface RuntimeConfigOptions {
  /**
   * Whether a real `FiscalDocumentProvider` is available. None exists yet
   * (the SIFEN SOAP provider is a later phase), so production cannot boot
   * until it is wired here (G-1, confirmed).
   */
  realFiscalProviderAvailable?: boolean;
}

const missing = (env: RuntimeEnv, names: readonly string[]): string[] =>
  names.filter((name) => !isSet(env[name]));

/** Production WhatsApp check: every Cloud API credential must be present. */
export function assertMessagingConfig(env: RuntimeEnv = process.env): void {
  const absent = missing(env, REQUIRED_WHATSAPP_CREDENTIALS);
  if (absent.length > 0) {
    throw new RuntimeConfigError(
      `wholesale: production mode requires WhatsApp credentials; missing ${absent.join(', ')}. ` +
        'Set them, or set WHOLESALE_DEMO_MODE=true (without real credentials) for a demo.'
    );
  }
}

/** Production SIFEN check: settings present and a real provider available. */
export function assertFiscalConfig(
  env: RuntimeEnv = process.env,
  options: RuntimeConfigOptions = {}
): void {
  const absent = missing(env, REQUIRED_SIFEN_CREDENTIALS);
  if (absent.length > 0) {
    throw new RuntimeConfigError(
      `wholesale: production mode requires SIFEN settings; missing ${absent.join(', ')}.`
    );
  }
  const environment = (env.SIFEN_ENVIRONMENT ?? '').trim();
  if (!(SIFEN_ENVIRONMENTS as readonly string[]).includes(environment)) {
    throw new RuntimeConfigError(
      `wholesale: SIFEN_ENVIRONMENT must be one of ${SIFEN_ENVIRONMENTS.join(', ')}.`
    );
  }
  if (options.realFiscalProviderAvailable !== true) {
    throw new RuntimeConfigError(
      'wholesale: production mode requires a real SIFEN provider, and none is available yet (G-1). ' +
        'Use WHOLESALE_DEMO_MODE=true (without real credentials) for a demo.'
    );
  }
}

/** Throws a `RuntimeConfigError` when the environment is unsafe for its mode. */
export function assertRuntimeConfig(
  env: RuntimeEnv = process.env,
  options: RuntimeConfigOptions = {}
): RuntimeMode {
  const mode = getRuntimeMode(env);
  if (mode === 'demo') {
    const present = DEMO_FORBIDDEN_CREDENTIALS.filter((name) => isSet(env[name]));
    if (present.length > 0) {
      throw new RuntimeConfigError(
        `wholesale: demo mode (WHOLESALE_DEMO_MODE=true) must not have real credentials; remove ${present.join(', ')}.`
      );
    }
  } else if (mode === 'production') {
    assertMessagingConfig(env);
    assertFiscalConfig(env, options);
  }
  return mode;
}
