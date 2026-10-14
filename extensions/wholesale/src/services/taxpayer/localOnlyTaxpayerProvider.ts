import { normalizeRuc } from './rucCheckDigit.js';
import type { TaxpayerLookup, TaxpayerRegistryProvider } from './TaxpayerRegistryProvider.js';

/**
 * Production provider (`03_sifen_y_dnit_mock.md` §2.5): no external lookup
 * (G-1). Format and check digit only; the administrator verifies the real
 * status of the RUC before approving (CU-00 step 5).
 */
export const localOnlyTaxpayerProvider: TaxpayerRegistryProvider = {
  async lookup(normalizedRuc: string): Promise<TaxpayerLookup> {
    const { normalized } = normalizeRuc(normalizedRuc);
    return {
      ruc: normalized,
      status: 'UNVERIFIED',
      businessName: null,
      businessNameLocked: false,
      source: 'local'
    };
  }
};
