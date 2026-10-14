import { DNIT_MOCK_SEED, type DnitActivity } from './dnitMockSeed.js';
import { normalizeRuc, rucCheckDigit } from './rucCheckDigit.js';
import type { TaxpayerLookup, TaxpayerRegistryProvider } from './TaxpayerRegistryProvider.js';

/**
 * In-process DNIT mock, development and demo only (`03_sifen_y_dnit_mock.md`
 * §2.3): the last digit of the base number (without check digit) decides.
 * Even -> ACTIVE with the seed business name (or "CONTRIBUYENTE DEMO <base>"),
 * locked; odd -> BLOCKED. The check digit is validated as in production (G-2).
 */

/** A record in the literal shape of CIRCUITO §2 (`GET /api/v1/mock-dnit/consulta-ruc`). */
export interface DnitMockRecord {
  ruc: string;
  dv: string;
  razon_social: string;
  estado: 'ACTIVO' | 'BLOQUEADO';
  tipo_contribuyente: 'JURIDICA' | 'FISICA';
  actividades_economicas: DnitActivity[];
}

const isEvenBase = (base: string): boolean => Number(base[base.length - 1]) % 2 === 0;

/**
 * Taxpayer type outside the seed. Not specified by the SDD: legal entities in
 * the demo data use the `80` prefix of 8-digit company RUCs, anything else is
 * reported as a natural person.
 */
const defaultTaxpayerType = (base: string): 'JURIDICA' | 'FISICA' =>
  base.length === 8 && base.startsWith('80') ? 'JURIDICA' : 'FISICA';

/** The mock record of a base number (1 to 8 digits); the check digit is computed. */
export function dnitMockRecord(base: string): DnitMockRecord {
  const dv = rucCheckDigit(base);
  const seed = DNIT_MOCK_SEED[`${base}-${dv}`];
  return {
    ruc: base,
    dv: String(dv),
    razon_social: seed?.businessName ?? `CONTRIBUYENTE DEMO ${base}`,
    estado: isEvenBase(base) ? 'ACTIVO' : 'BLOQUEADO',
    tipo_contribuyente: seed?.taxpayerType ?? defaultTaxpayerType(base),
    actividades_economicas: seed?.activities ?? []
  };
}

export const dnitMockProvider: TaxpayerRegistryProvider = {
  async lookup(normalizedRuc: string): Promise<TaxpayerLookup> {
    const { base, normalized } = normalizeRuc(normalizedRuc);
    const record = dnitMockRecord(base);
    return {
      ruc: normalized,
      status: record.estado === 'ACTIVO' ? 'ACTIVE' : 'BLOCKED',
      businessName: record.razon_social,
      businessNameLocked: true,
      source: 'dnit_mock'
    };
  }
};
