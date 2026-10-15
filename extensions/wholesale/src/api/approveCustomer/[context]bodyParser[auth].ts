import bodyParser from 'body-parser';
import type { EvershopRequest } from '@evershop/evershop/types/request';
import type { EvershopResponse } from '@evershop/evershop/types/response';

/** JSON body parser of this route (core parses bodies per route). */
export default (request: EvershopRequest, response: EvershopResponse, next: (err?: unknown) => void) => {
  bodyParser.json({ inflate: false })(request, response, next);
};
