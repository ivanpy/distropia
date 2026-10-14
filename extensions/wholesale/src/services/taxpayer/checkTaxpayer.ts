import { getTaxpayerProvider } from './getTaxpayerProvider.js';
import { normalizeRuc } from './rucCheckDigit.js';
import { TaxpayerError } from './TaxpayerError.js';
import type { TaxpayerLookup, TaxpayerRegistryProvider } from './TaxpayerRegistryProvider.js';

/** Message of the blocked-taxpayer case, literal from CIRCUITO §2. */
export const DNIT_401_MESSAGE =
  'El RUC ingresado se encuentra en estado SUSPENDIDO o BLOQUEADO. No se permiten transacciones comerciales con este contribuyente.';

/**
 * Domain check of a RUC typed by a customer (`03_sifen_y_dnit_mock.md` §2.1):
 * normalizes it and validates format and check digit **before** the
 * provider is called, then asks the provider of the runtime mode.
 *
 * Throws `TaxpayerError` with `RUC_INVALID_FORMAT`, `RUC_INVALID_CHECK_DIGIT`
 * or `DNIT_401` (provider returned BLOCKED).
 */
export async function checkTaxpayer(
  raw: unknown,
  provider: TaxpayerRegistryProvider = getTaxpayerProvider()
): Promise<TaxpayerLookup> {
  const { normalized } = normalizeRuc(typeof raw === 'string' ? raw : '');
  const lookup = await provider.lookup(normalized);
  if (lookup.status === 'BLOCKED') {
    throw new TaxpayerError('DNIT_401', DNIT_401_MESSAGE);
  }
  return lookup;
}
