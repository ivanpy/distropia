/**
 * Runtime mode resolver (ADR-08).
 *
 * This is the only place that reads `NODE_ENV` and `WHOLESALE_DEMO_MODE`.
 * Every provider factory (messaging, taxpayer registry, fiscal documents)
 * must decide through it, never by reading those variables itself.
 *
 * | Mode          | Condition                                             |
 * |---------------|-------------------------------------------------------|
 * | `development` | `NODE_ENV !== 'production'`                           |
 * | `demo`        | `NODE_ENV === 'production'` and `WHOLESALE_DEMO_MODE === 'true'` |
 * | `production`  | `NODE_ENV === 'production'` and any other demo value  |
 *
 * The demo flag is matched exactly (`'true'`): anything else in production
 * resolves to real production, which fails closed without credentials.
 */
export type RuntimeMode = 'development' | 'demo' | 'production';

export type RuntimeEnv = Record<string, string | undefined>;

export function getRuntimeMode(env: RuntimeEnv = process.env): RuntimeMode {
  if (env.NODE_ENV !== 'production') {
    return 'development';
  }
  return env.WHOLESALE_DEMO_MODE === 'true' ? 'demo' : 'production';
}

/** Mock providers (DNIT, SIFEN, messaging inbox) exist only outside real production. */
export const mocksEnabled = (mode: RuntimeMode = getRuntimeMode()): boolean =>
  mode !== 'production';

/** True when the variable holds a non-blank value. */
export const isSet = (value: string | undefined): boolean =>
  typeof value === 'string' && value.trim() !== '';

/**
 * WhatsApp messaging mock (ADR-08 table):
 * - development: mock when `WHATSAPP_MOCK_ENABLED=true` or no access token;
 * - demo: always mock;
 * - production: never mock, whatever `WHATSAPP_MOCK_ENABLED` says.
 */
export function isMessagingMockEnabled(env: RuntimeEnv = process.env): boolean {
  const mode = getRuntimeMode(env);
  if (mode === 'production') {
    return false;
  }
  if (mode === 'demo') {
    return true;
  }
  return env.WHATSAPP_MOCK_ENABLED === 'true' || !isSet(env.WHATSAPP_ACCESS_TOKEN);
}
