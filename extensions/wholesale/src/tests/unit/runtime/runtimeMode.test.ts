/**
 * ADR-08: runtime modes (development / demo / production) and the boot guard.
 *
 * Every case passes an explicit env object, so the suite never depends on
 * (nor mutates) the real process environment, except the bootstrap cases at
 * the end, which save and restore the variables they touch.
 */
import {
  getRuntimeMode,
  isMessagingMockEnabled,
  mocksEnabled
} from '../../../services/runtime/getRuntimeMode.js';
import {
  assertRuntimeConfig,
  DEMO_FORBIDDEN_CREDENTIALS,
  REQUIRED_SIFEN_CREDENTIALS,
  REQUIRED_WHATSAPP_CREDENTIALS,
  RuntimeConfigError
} from '../../../services/runtime/assertRuntimeConfig.js';
import bootstrap from '../../../bootstrap.js';

type Env = Record<string, string | undefined>;

const WHATSAPP: Env = {
  WHATSAPP_ACCESS_TOKEN: 'token',
  WHATSAPP_PHONE_NUMBER_ID: 'phone-id',
  WHATSAPP_APP_SECRET: 'secret',
  WHATSAPP_WEBHOOK_VERIFY_TOKEN: 'verify'
};
const SIFEN: Env = {
  SIFEN_ENVIRONMENT: 'test',
  SIFEN_CERT_PATH: '/certs/issuer.p12',
  SIFEN_CERT_PASSWORD: 'cert-password',
  SIFEN_CSC_ID: '0001',
  SIFEN_CSC: 'csc'
};

describe('getRuntimeMode', () => {
  it.each<[string | undefined, string | undefined, string]>([
    [undefined, undefined, 'development'],
    ['development', undefined, 'development'],
    ['test', undefined, 'development'],
    ['development', 'true', 'development'],
    ['test', 'true', 'development'],
    ['production', undefined, 'production'],
    ['production', 'false', 'production'],
    ['production', 'TRUE', 'production'],
    ['production', '1', 'production'],
    ['production', '', 'production'],
    ['production', 'true', 'demo']
  ])('NODE_ENV=%s WHOLESALE_DEMO_MODE=%s -> %s', (nodeEnv, demo, expected) => {
    expect(
      getRuntimeMode({ NODE_ENV: nodeEnv, WHOLESALE_DEMO_MODE: demo })
    ).toBe(expected);
  });

  it('enables mocks everywhere except production', () => {
    expect(mocksEnabled('development')).toBe(true);
    expect(mocksEnabled('demo')).toBe(true);
    expect(mocksEnabled('production')).toBe(false);
  });
});

describe('isMessagingMockEnabled', () => {
  it.each<[string, Env, boolean]>([
    ['development without a token', { NODE_ENV: 'development' }, true],
    [
      'development with an empty token',
      { NODE_ENV: 'development', WHATSAPP_ACCESS_TOKEN: '  ' },
      true
    ],
    [
      'development with a token and the mock flag',
      { NODE_ENV: 'development', WHATSAPP_ACCESS_TOKEN: 't', WHATSAPP_MOCK_ENABLED: 'true' },
      true
    ],
    [
      'development with a token and no mock flag',
      { NODE_ENV: 'development', WHATSAPP_ACCESS_TOKEN: 't' },
      false
    ],
    ['demo, always', { NODE_ENV: 'production', WHOLESALE_DEMO_MODE: 'true' }, true],
    [
      'production, even with the mock flag and no token',
      { NODE_ENV: 'production', WHATSAPP_MOCK_ENABLED: 'true' },
      false
    ]
  ])('%s -> %s', (_label, env, expected) => {
    expect(isMessagingMockEnabled(env)).toBe(expected);
  });
});

describe('assertRuntimeConfig', () => {
  describe('development', () => {
    it.each<[string, Env]>([
      ['no credentials', { NODE_ENV: 'development' }],
      ['real credentials', { NODE_ENV: 'development', ...WHATSAPP, ...SIFEN }],
      ['demo flag ignored outside production', { NODE_ENV: 'test', WHOLESALE_DEMO_MODE: 'true', ...WHATSAPP }]
    ])('passes with %s', (_label, env) => {
      expect(assertRuntimeConfig(env)).toBe('development');
    });
  });

  describe('demo', () => {
    const demo: Env = { NODE_ENV: 'production', WHOLESALE_DEMO_MODE: 'true' };

    it('passes without real credentials', () => {
      expect(assertRuntimeConfig(demo)).toBe('demo');
    });

    it('treats empty or blank credentials as absent', () => {
      expect(
        assertRuntimeConfig({ ...demo, WHATSAPP_ACCESS_TOKEN: '', SIFEN_CSC: '   ' })
      ).toBe('demo');
    });

    it('ignores non-secret settings that ADR-08 does not list', () => {
      expect(
        assertRuntimeConfig({
          ...demo,
          WHATSAPP_WEBHOOK_VERIFY_TOKEN: 'verify',
          SIFEN_CSC_ID: '0001',
          SIFEN_ENVIRONMENT: 'test',
          WHATSAPP_MOCK_ENABLED: 'false'
        })
      ).toBe('demo');
    });

    it.each([...DEMO_FORBIDDEN_CREDENTIALS])(
      'throws when the real credential %s is defined',
      (name) => {
        expect(() => assertRuntimeConfig({ ...demo, [name]: 'real-value' })).toThrow(
          RuntimeConfigError
        );
        expect(() => assertRuntimeConfig({ ...demo, [name]: 'real-value' })).toThrow(
          new RegExp(name)
        );
      }
    );

    it('lists exactly the six credentials named by ADR-08', () => {
      expect([...DEMO_FORBIDDEN_CREDENTIALS].sort()).toEqual(
        [
          'SIFEN_CERT_PASSWORD',
          'SIFEN_CERT_PATH',
          'SIFEN_CSC',
          'WHATSAPP_ACCESS_TOKEN',
          'WHATSAPP_APP_SECRET',
          'WHATSAPP_PHONE_NUMBER_ID'
        ]
      );
    });

    it('never echoes credential values in the error', () => {
      let message = '';
      try {
        assertRuntimeConfig({ ...demo, WHATSAPP_APP_SECRET: 's3cr3t-value' });
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message).toMatch(/WHATSAPP_APP_SECRET/);
      expect(message).not.toContain('s3cr3t-value');
    });
  });

  describe('production (fail closed)', () => {
    const production: Env = { NODE_ENV: 'production' };

    it('throws without any credential, naming what is missing', () => {
      expect(() => assertRuntimeConfig(production)).toThrow(RuntimeConfigError);
      expect(() => assertRuntimeConfig(production)).toThrow(/WHATSAPP_ACCESS_TOKEN/);
    });

    it.each([...REQUIRED_WHATSAPP_CREDENTIALS])(
      'throws when the WhatsApp credential %s is missing',
      (name) => {
        const env = { ...production, ...WHATSAPP, ...SIFEN, [name]: undefined };
        expect(() =>
          assertRuntimeConfig(env, { realFiscalProviderAvailable: true })
        ).toThrow(new RegExp(name));
      }
    );

    it.each([...REQUIRED_SIFEN_CREDENTIALS])(
      'throws when the SIFEN setting %s is missing',
      (name) => {
        const env = { ...production, ...WHATSAPP, ...SIFEN, [name]: '' };
        expect(() =>
          assertRuntimeConfig(env, { realFiscalProviderAvailable: true })
        ).toThrow(new RegExp(name));
      }
    );

    it('rejects an unknown SIFEN_ENVIRONMENT', () => {
      const env = { ...production, ...WHATSAPP, ...SIFEN, SIFEN_ENVIRONMENT: 'mock' };
      expect(() =>
        assertRuntimeConfig(env, { realFiscalProviderAvailable: true })
      ).toThrow(/SIFEN_ENVIRONMENT/);
    });

    it('throws with every credential but no real SIFEN provider (G-1)', () => {
      const env = { ...production, ...WHATSAPP, ...SIFEN };
      expect(() => assertRuntimeConfig(env)).toThrow(/SIFEN provider/);
    });

    it('never mocks in production, even with WHATSAPP_MOCK_ENABLED=true', () => {
      const env = { ...production, WHATSAPP_MOCK_ENABLED: 'true' };
      expect(() => assertRuntimeConfig(env)).toThrow(RuntimeConfigError);
    });

    it('passes with every credential and a real SIFEN provider', () => {
      const env = { ...production, ...WHATSAPP, ...SIFEN, SIFEN_ENVIRONMENT: 'production' };
      expect(assertRuntimeConfig(env, { realFiscalProviderAvailable: true })).toBe(
        'production'
      );
    });
  });
});

describe('bootstrap runs the runtime guard', () => {
  const touched = ['NODE_ENV', 'WHOLESALE_DEMO_MODE', ...DEMO_FORBIDDEN_CREDENTIALS];
  let saved: Env;

  beforeEach(() => {
    saved = Object.fromEntries(touched.map((k) => [k, process.env[k]]));
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it('fails boot in demo mode with a real credential', () => {
    process.env.NODE_ENV = 'production';
    process.env.WHOLESALE_DEMO_MODE = 'true';
    process.env.WHATSAPP_ACCESS_TOKEN = 'real-token';
    expect(() => bootstrap({ command: 'start' })).toThrow(RuntimeConfigError);
  });

  it('fails boot in production without credentials', () => {
    process.env.NODE_ENV = 'production';
    delete process.env.WHOLESALE_DEMO_MODE;
    for (const name of DEMO_FORBIDDEN_CREDENTIALS) {
      delete process.env[name];
    }
    expect(() => bootstrap({ process: 'event' })).toThrow(RuntimeConfigError);
  });

  it('skips the guard for the asset build, which sends nothing', () => {
    process.env.NODE_ENV = 'production';
    delete process.env.WHOLESALE_DEMO_MODE;
    expect(() => bootstrap({ command: 'build' })).not.toThrow();
  });
});
