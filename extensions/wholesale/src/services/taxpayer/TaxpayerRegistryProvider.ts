/**
 * Taxpayer registry (DNIT) port (`03_sifen_y_dnit_mock.md` §2.1). The
 * implementation is chosen by the runtime mode (`getTaxpayerProvider`).
 */
export type TaxpayerStatus = 'ACTIVE' | 'BLOCKED' | 'UNVERIFIED';

export interface TaxpayerLookup {
  /** Normalized RUC with check digit, e.g. "80012344-1". */
  ruc: string;
  status: TaxpayerStatus;
  /** Null when the provider cannot tell. */
  businessName: string | null;
  /** True -> the registration form locks the business name field. */
  businessNameLocked: boolean;
  source: 'dnit_mock' | 'local' | 'dnit_api';
}

export interface TaxpayerRegistryProvider {
  /** `normalizedRuc` has already passed format and check digit validation. */
  lookup(normalizedRuc: string): Promise<TaxpayerLookup>;
}
