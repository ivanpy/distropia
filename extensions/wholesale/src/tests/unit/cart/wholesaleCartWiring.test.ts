/**
 * T-2.15 wiring: the extension bootstrap registers the wholesale cart item
 * processor on the core `cartItemFields` and the quantity-update refusal as
 * an after-hook of the core `updateCartItemQty`.
 *
 * Own test file: the bootstrap fills the core registry and hook storage of
 * this module graph, which the end-to-end cart test configures itself.
 */
import path from 'path';
import { pathToFileURL } from 'url';
import { rejectInvalidWholesaleQuantity } from '../../../services/cart/wholesaleCartItemFields.js';

describe('wholesale cart rules wiring (T-2.15)', () => {
  it('is wired by the extension bootstrap on the core cartItemFields and updateCartItemQty', async () => {
    const { getHooks } = (await import(
      pathToFileURL(path.resolve(process.cwd(), 'packages/evershop/dist/lib/util/hookable.js')).href
    )) as { getHooks(): { afterHooks: Map<string, Array<{ callback: unknown }>> } };
    const { getProcessors } = (await import(
      pathToFileURL(path.resolve(process.cwd(), 'packages/evershop/dist/lib/util/registry.js')).href
    )) as { getProcessors(name: string): Array<{ callback: { name: string } }> };
    const bootstrap = (await import(
      pathToFileURL(path.resolve(process.cwd(), 'extensions/wholesale/dist/bootstrap.js')).href
    )) as { default: (context?: Record<string, unknown>) => void };
    bootstrap.default({ command: 'build' });

    expect(getHooks().afterHooks.get('updateCartItemQty')?.map((h) => h.callback)).toContain(
      rejectInvalidWholesaleQuantity
    );
    expect(getProcessors('cartItemFields').map((p) => p.callback.name)).toContain('registerWholesaleCartItemFields');
  });

});
