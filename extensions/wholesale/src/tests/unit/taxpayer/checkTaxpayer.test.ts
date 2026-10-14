/**
 * T-2.36: taxpayer registry providers and `checkTaxpayer`, per runtime mode
 * (`03_sifen_y_dnit_mock.md` §1, §2).
 *
 * - development / demo: `dnitMockProvider` (last digit of the base number:
 *   even -> ACTIVE with a seed or demo business name, odd -> BLOCKED);
 * - production: `localOnlyTaxpayerProvider` (UNVERIFIED, no name).
 * Format and check digit are validated before any provider in every mode.
 */
import { checkTaxpayer, DNIT_401_MESSAGE } from '../../../services/taxpayer/checkTaxpayer.js';
import { dnitMockProvider, dnitMockRecord } from '../../../services/taxpayer/dnitMockProvider.js';
import { DNIT_MOCK_SEED } from '../../../services/taxpayer/dnitMockSeed.js';
import { getTaxpayerProvider } from '../../../services/taxpayer/getTaxpayerProvider.js';
import { localOnlyTaxpayerProvider } from '../../../services/taxpayer/localOnlyTaxpayerProvider.js';
import { normalizeRuc } from '../../../services/taxpayer/rucCheckDigit.js';
import { TaxpayerError } from '../../../services/taxpayer/TaxpayerError.js';
import type {
  TaxpayerLookup,
  TaxpayerRegistryProvider
} from '../../../services/taxpayer/TaxpayerRegistryProvider.js';

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (e) {
    expect(e).toBeInstanceOf(TaxpayerError);
    return (e as TaxpayerError).code;
  }
  return undefined;
}

describe('getTaxpayerProvider', () => {
  it.each([
    ['development', dnitMockProvider],
    ['demo', dnitMockProvider],
    ['production', localOnlyTaxpayerProvider]
  ] as const)('%s -> expected provider', (mode, provider) => {
    expect(getTaxpayerProvider(mode)).toBe(provider);
  });
});

describe('dnitMockSeed', () => {
  it('only holds RUCs with a valid check digit and the parity status', () => {
    for (const [ruc, entry] of Object.entries(DNIT_MOCK_SEED)) {
      const { base, normalized } = normalizeRuc(ruc);
      expect(normalized).toBe(ruc);
      const even = Number(base[base.length - 1]) % 2 === 0;
      expect(entry.status).toBe(even ? 'ACTIVE' : 'BLOCKED');
    }
  });
});

describe('dnitMockProvider', () => {
  it('returns the seed business name for an even seed RUC, locked', async () => {
    await expect(dnitMockProvider.lookup('80012344-1')).resolves.toEqual<TaxpayerLookup>({
      ruc: '80012344-1',
      status: 'ACTIVE',
      businessName: 'FERRETERIA Y CONSTRUCCIONES CENTRAL S.A.',
      businessNameLocked: true,
      source: 'dnit_mock'
    });
    await expect(dnitMockProvider.lookup('80012346-8')).resolves.toMatchObject({
      status: 'ACTIVE',
      businessName: 'CONSTRUCTORA DEMO DEL ESTE S.R.L.'
    });
  });

  it('returns a demo business name for an even RUC outside the seed', async () => {
    // 1234 -> 4*2 + 3*3 + 2*4 + 1*5 = 30 -> 30 mod 11 = 8 -> 3
    await expect(dnitMockProvider.lookup('1234-3')).resolves.toEqual<TaxpayerLookup>({
      ruc: '1234-3',
      status: 'ACTIVE',
      businessName: 'CONTRIBUYENTE DEMO 1234',
      businessNameLocked: true,
      source: 'dnit_mock'
    });
  });

  it.each(['4445551-8', '1-9', '80012345-0'])('odd base %s -> BLOCKED', async (ruc) => {
    const lookup = await dnitMockProvider.lookup(ruc);
    expect(lookup.status).toBe('BLOCKED');
    expect(lookup.source).toBe('dnit_mock');
  });

  it('validates the check digit itself (G-2)', async () => {
    expect(await codeOf(dnitMockProvider.lookup('80012344-2'))).toBe('RUC_INVALID_CHECK_DIGIT');
  });

  it('exposes the CIRCUITO record with the computed check digit', () => {
    expect(dnitMockRecord('80012344')).toEqual({
      ruc: '80012344',
      dv: '1',
      razon_social: 'FERRETERIA Y CONSTRUCCIONES CENTRAL S.A.',
      estado: 'ACTIVO',
      tipo_contribuyente: 'JURIDICA',
      actividades_economicas: [
        {
          codigo: '46631',
          descripcion: 'VENTA AL POR MAYOR DE MATERIALES DE CONSTRUCCION Y HERRAMIENTAS'
        }
      ]
    });
    expect(dnitMockRecord('4445551')).toMatchObject({
      ruc: '4445551',
      dv: '8',
      razon_social: 'MIGUEL PEREZ FERRETERO',
      estado: 'BLOQUEADO'
    });
  });
});

describe('localOnlyTaxpayerProvider', () => {
  it('returns UNVERIFIED without a business name', async () => {
    await expect(localOnlyTaxpayerProvider.lookup('80012345-0')).resolves.toEqual<TaxpayerLookup>({
      ruc: '80012345-0',
      status: 'UNVERIFIED',
      businessName: null,
      businessNameLocked: false,
      source: 'local'
    });
  });
});

describe.each(['development', 'demo', 'production'] as const)('checkTaxpayer in %s', (mode) => {
  const provider = getTaxpayerProvider(mode);
  const mock = mode !== 'production';

  it.each(['80012344-2', '4445551-7', '80099999-2'])(
    'rejects the CIRCUITO literal %s with RUC_INVALID_CHECK_DIGIT',
    async (ruc) => {
      expect(await codeOf(checkTaxpayer(ruc, provider))).toBe('RUC_INVALID_CHECK_DIGIT');
    }
  );

  it.each(['', '80012344', '123456789-1', 'x'])('rejects %p with RUC_INVALID_FORMAT', async (ruc) => {
    expect(await codeOf(checkTaxpayer(ruc, provider))).toBe('RUC_INVALID_FORMAT');
  });

  it('does not call the provider when the RUC is invalid', async () => {
    let calls = 0;
    const spy: TaxpayerRegistryProvider = {
      lookup: async () => {
        calls += 1;
        return provider.lookup('80012344-1');
      }
    };
    expect(await codeOf(checkTaxpayer('80012344-2', spy))).toBe('RUC_INVALID_CHECK_DIGIT');
    expect(await codeOf(checkTaxpayer('8001234', spy))).toBe('RUC_INVALID_FORMAT');
    expect(calls).toBe(0);
  });

  it('normalizes and accepts 80012344-1', async () => {
    const lookup = await checkTaxpayer(' 80.012.344-1 ', provider);
    expect(lookup.ruc).toBe('80012344-1');
    expect(lookup.status).toBe(mock ? 'ACTIVE' : 'UNVERIFIED');
    expect(lookup.businessName).toBe(mock ? 'FERRETERIA Y CONSTRUCCIONES CENTRAL S.A.' : null);
  });

  it(`odd base 4445551-8 -> ${mock ? 'DNIT_401' : 'UNVERIFIED'}`, async () => {
    if (mock) {
      let caught: unknown;
      await checkTaxpayer('4445551-8', provider).catch((e: unknown) => {
        caught = e;
      });
      expect(caught).toBeInstanceOf(TaxpayerError);
      expect((caught as TaxpayerError).code).toBe('DNIT_401');
      expect((caught as TaxpayerError).message).toBe(DNIT_401_MESSAGE);
    } else {
      await expect(checkTaxpayer('4445551-8', provider)).resolves.toMatchObject({
        status: 'UNVERIFIED'
      });
    }
  });
});
