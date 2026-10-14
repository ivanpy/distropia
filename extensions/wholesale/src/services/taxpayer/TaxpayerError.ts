/**
 * Error codes of the taxpayer (RUC) validation (`03_sifen_y_dnit_mock.md`
 * §2.1, `03_endpoints_y_contratos.md` §3). Every one maps to HTTP 422.
 */
export type TaxpayerErrorCode = 'RUC_INVALID_FORMAT' | 'RUC_INVALID_CHECK_DIGIT' | 'DNIT_401';

export class TaxpayerError extends Error {
  readonly code: TaxpayerErrorCode;

  constructor(code: TaxpayerErrorCode, message: string) {
    super(message);
    this.name = 'TaxpayerError';
    this.code = code;
  }
}

export const isTaxpayerError = (e: unknown): e is TaxpayerError => e instanceof TaxpayerError;
