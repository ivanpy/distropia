/**
 * R3-handler-next-inside-try: the shared admin handler of product lines
 * (`services/line/productLineHandler.ts`) must hand over to the next
 * middleware only after its transaction is settled. A downstream middleware
 * that throws after COMMIT must not trigger a ROLLBACK on the released
 * connection nor a second `next(err)` call.
 *
 * No database: the connection records the transaction statements.
 */
import type { PoolClient } from 'pg';
import type { EvershopRequest } from '@evershop/evershop/types/request';
import type { EvershopResponse } from '@evershop/evershop/types/response';
import { createProductLineHandler } from '../../../services/line/productLineHandler.js';
import { type ProductLine, ProductLineError } from '../../../services/line/productLines.js';

const LINE: ProductLine = {
  uuid: '7f1b0a52-4c38-4b8f-9d39-5a6c1f7e2b10',
  name: 'Herramientas',
  isActive: true,
  countsTowardMix: false,
  tiers: []
};

function recordingConnection() {
  const connection = {
    statements: [] as string[],
    released: 0,
    async query(text: unknown) {
      connection.statements.push(String(text).trim().toUpperCase());
      return { rows: [] };
    },
    release() {
      connection.released += 1;
    }
  };
  return connection;
}

function response() {
  const res = {
    statusCode: undefined as number | undefined,
    payload: undefined as unknown,
    $body: undefined as unknown,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(payload: unknown) {
      res.payload = payload;
      return res;
    }
  };
  return res;
}

describe('product line handler hands over after the transaction (R3-handler-next-inside-try)', () => {
  it('calls next once and never rolls back when a downstream middleware throws after COMMIT', async () => {
    const connection = recordingConnection();
    const handler = createProductLineHandler(
      { successStatus: 200, requiresLineId: false, run: async () => LINE },
      async () => connection as unknown as PoolClient
    );
    const res = response();
    const calls: unknown[] = [];
    const downstream = new Error('downstream failure');

    await expect(
      handler({ params: {}, body: {} } as unknown as EvershopRequest, res as unknown as EvershopResponse, (err?: unknown) => {
        calls.push(err);
        throw downstream;
      })
    ).rejects.toBe(downstream);

    expect(calls).toEqual([undefined]);
    expect(connection.statements).toEqual(['BEGIN', 'COMMIT']);
    expect(connection.released).toBe(1);
    expect(res.statusCode).toBe(200);
    expect(res.$body).toEqual({ data: LINE });
    expect(res.payload).toBeUndefined();
  });

  it('still rolls back and answers a domain error itself without calling next', async () => {
    const connection = recordingConnection();
    const handler = createProductLineHandler(
      {
        successStatus: 200,
        requiresLineId: false,
        run: async () => {
          throw new ProductLineError('PRODUCT_LINE_NOT_FOUND', 404, 'Product line not found');
        }
      },
      async () => connection as unknown as PoolClient
    );
    const res = response();
    const calls: unknown[] = [];
    await handler({ params: {}, body: {} } as unknown as EvershopRequest, res as unknown as EvershopResponse, (err?: unknown) => {
      calls.push(err);
    });
    expect(calls).toEqual([]);
    expect(connection.statements).toEqual(['BEGIN', 'ROLLBACK']);
    expect(res.statusCode).toBe(404);
  });

  it('passes an unexpected error to next exactly once after rolling back', async () => {
    const connection = recordingConnection();
    const failure = new Error('boom');
    const handler = createProductLineHandler(
      {
        successStatus: 200,
        requiresLineId: false,
        run: async () => {
          throw failure;
        }
      },
      async () => connection as unknown as PoolClient
    );
    const calls: unknown[] = [];
    await handler({ params: {}, body: {} } as unknown as EvershopRequest, response() as unknown as EvershopResponse, (err?: unknown) => {
      calls.push(err);
    });
    expect(calls).toEqual([failure]);
    expect(connection.statements).toEqual(['BEGIN', 'ROLLBACK']);
    expect(connection.released).toBe(1);
  });
});
