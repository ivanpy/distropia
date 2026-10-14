/**
 * T-2.37 / T-2.38: `GET /api/wholesale/ruc-check` and the literal CIRCUITO §2
 * endpoint `GET /api/v1/mock-dnit/consulta-ruc`
 * (`03_endpoints_y_contratos.md` §1 and §3, `03_sifen_y_dnit_mock.md` §2.4).
 *
 * The compiled handlers are called with a minimal request/response pair.
 * The runtime mode is switched through `NODE_ENV` / `WHOLESALE_DEMO_MODE`,
 * saved and restored around every case.
 */
import fs from 'fs';
import path from 'path';
import type { EvershopRequest } from '@evershop/evershop/types/request';
import type { EvershopResponse } from '@evershop/evershop/types/response';
import mockDnitConsultaRuc from '../../../api/mockDnitConsultaRuc/consultaRuc.js';
import rucCheck from '../../../api/rucCheck/rucCheck.js';
import { DNIT_401_MESSAGE } from '../../../services/taxpayer/checkTaxpayer.js';

const EXTENSION_API = path.resolve(process.cwd(), 'extensions/wholesale/dist/api');

type Handler = (req: EvershopRequest, res: EvershopResponse, next: (err?: unknown) => void) => unknown;

type Captured = { status: number; body: unknown; ended: boolean; nextCalls: unknown[] };

async function call(handler: Handler, query: Record<string, unknown>): Promise<Captured> {
  const captured: Captured = { status: 200, body: undefined, ended: false, nextCalls: [] };
  const response = {
    status(code: number) {
      captured.status = code;
      return response;
    },
    json(body: unknown) {
      captured.body = body;
      captured.ended = true;
      return response;
    },
    end() {
      captured.ended = true;
      return response;
    }
  };
  await handler(
    { query } as unknown as EvershopRequest,
    response as unknown as EvershopResponse,
    (err?: unknown) => {
      captured.nextCalls.push(err);
    }
  );
  return captured;
}

const MODES = {
  development: { NODE_ENV: 'test', WHOLESALE_DEMO_MODE: undefined },
  demo: { NODE_ENV: 'production', WHOLESALE_DEMO_MODE: 'true' },
  production: { NODE_ENV: 'production', WHOLESALE_DEMO_MODE: undefined }
} as const;

type Mode = keyof typeof MODES;

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = { NODE_ENV: process.env.NODE_ENV, WHOLESALE_DEMO_MODE: process.env.WHOLESALE_DEMO_MODE };
});

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function useMode(mode: Mode): void {
  for (const [key, value] of Object.entries(MODES[mode])) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

describe('route declarations', () => {
  it.each([
    ['rucCheck', { methods: ['GET'], path: '/wholesale/ruc-check', access: 'public' }],
    ['mockDnitConsultaRuc', { methods: ['GET'], path: '/v1/mock-dnit/consulta-ruc', access: 'public' }]
  ])('%s/route.json is built into dist', (routeId, expected) => {
    expect(routeId).toMatch(/^[a-zA-Z]+$/);
    const file = path.join(EXTENSION_API, routeId, 'route.json');
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual(expected);
  });
});

describe.each(['development', 'demo'] as const)('GET /api/wholesale/ruc-check (%s)', (mode) => {
  beforeEach(() => useMode(mode));

  it('200 with the mock lookup', async () => {
    const res = await call(rucCheck as Handler, { ruc: '80012344-1' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      data: {
        ruc: '80012344-1',
        status: 'ACTIVE',
        businessName: 'FERRETERIA Y CONSTRUCCIONES CENTRAL S.A.',
        businessNameLocked: true,
        source: 'dnit_mock'
      }
    });
  });

  it('422 DNIT_401 with the CIRCUITO message for an odd base', async () => {
    const res = await call(rucCheck as Handler, { ruc: '4445551-8' });
    expect(res.status).toBe(422);
    expect(res.body).toEqual({ error: { status: 422, code: 'DNIT_401', message: DNIT_401_MESSAGE } });
  });
});

describe('GET /api/wholesale/ruc-check (production)', () => {
  beforeEach(() => useMode('production'));

  it('200 UNVERIFIED from the local provider', async () => {
    const res = await call(rucCheck as Handler, { ruc: '80012344-1' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      data: {
        ruc: '80012344-1',
        status: 'UNVERIFIED',
        businessName: null,
        businessNameLocked: false,
        source: 'local'
      }
    });
  });

  it('an odd base is not blocked without the mock', async () => {
    const res = await call(rucCheck as Handler, { ruc: '4445551-8' });
    expect(res.status).toBe(200);
  });
});

describe.each(['development', 'demo', 'production'] as const)('GET /api/wholesale/ruc-check 422 (%s)', (mode) => {
  beforeEach(() => useMode(mode));

  it.each([
    [{ ruc: '80012344-2' }, 'RUC_INVALID_CHECK_DIGIT'],
    [{ ruc: '4445551-7' }, 'RUC_INVALID_CHECK_DIGIT'],
    [{ ruc: '80012344' }, 'RUC_INVALID_FORMAT'],
    [{ ruc: '123456789-1' }, 'RUC_INVALID_FORMAT'],
    [{}, 'RUC_INVALID_FORMAT'],
    [{ ruc: ['80012344-1', '80012346-8'] }, 'RUC_INVALID_FORMAT']
  ])('%p -> %s', async (query, code) => {
    const res = await call(rucCheck as Handler, query);
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ error: { status: 422, code } });
    expect(res.nextCalls).toEqual([]);
  });
});

describe.each(['development', 'demo'] as const)('GET /api/v1/mock-dnit/consulta-ruc (%s)', (mode) => {
  beforeEach(() => useMode(mode));

  it('even base -> literal CIRCUITO success shape, check digit computed', async () => {
    const res = await call(mockDnitConsultaRuc as Handler, { ruc: '80012344' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      status: 'success',
      data: {
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
      }
    });
  });

  it('odd base -> literal CIRCUITO DNIT_401 shape', async () => {
    const res = await call(mockDnitConsultaRuc as Handler, { ruc: '4445551' });
    expect(res.status).toBe(422);
    expect(res.body).toEqual({
      status: 'error',
      code: 'DNIT_401',
      message: DNIT_401_MESSAGE,
      data: {
        ruc: '4445551',
        dv: '8',
        razon_social: 'MIGUEL PEREZ FERRETERO',
        estado: 'BLOQUEADO'
      }
    });
  });

  it('accepts a RUC with a valid check digit', async () => {
    const res = await call(mockDnitConsultaRuc as Handler, { ruc: '80012346-8' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'success', data: { ruc: '80012346', dv: '8' } });
  });

  it.each([
    ['80012344-2', 'RUC_INVALID_CHECK_DIGIT'],
    ['123456789', 'RUC_INVALID_FORMAT'],
    [undefined, 'RUC_INVALID_FORMAT']
  ])('%p -> 422 %s', async (ruc, code) => {
    const res = await call(mockDnitConsultaRuc as Handler, ruc === undefined ? {} : { ruc });
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ status: 'error', code });
  });
});

describe('GET /api/v1/mock-dnit/consulta-ruc (production)', () => {
  beforeEach(() => useMode('production'));

  it('404 without a body', async () => {
    const res = await call(mockDnitConsultaRuc as Handler, { ruc: '80012344' });
    expect(res.status).toBe(404);
    expect(res.body).toBeUndefined();
    expect(res.ended).toBe(true);
  });
});
