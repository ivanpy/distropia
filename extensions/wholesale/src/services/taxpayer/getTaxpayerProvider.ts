import { getRuntimeMode, mocksEnabled, type RuntimeMode } from '../runtime/getRuntimeMode.js';
import { dnitMockProvider } from './dnitMockProvider.js';
import { localOnlyTaxpayerProvider } from './localOnlyTaxpayerProvider.js';
import type { TaxpayerRegistryProvider } from './TaxpayerRegistryProvider.js';

/** DNIT mock in development/demo, local validation only in production (ADR-08). */
export const getTaxpayerProvider = (mode: RuntimeMode = getRuntimeMode()): TaxpayerRegistryProvider =>
  mocksEnabled(mode) ? dnitMockProvider : localOnlyTaxpayerProvider;
