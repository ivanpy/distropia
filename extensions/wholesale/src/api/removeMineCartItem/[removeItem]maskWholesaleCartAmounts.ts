/**
 * Masks cart item amounts for approved wholesale customers (T-2.31). Runs
 * after the core `removeItem` handler has set `response.$body` and before the
 * core `apiResponse` middleware sends it. Passive (2-arg) on purpose: it
 * never sends a response itself.
 */
import { maskWholesaleCartResponse } from '../../services/pricing/maskCartRestResponse.js';

export default maskWholesaleCartResponse;
