/**
 * WhatsApp reply nonce (T-2.20, security §7).
 *
 * Embedded in the quote buttons' payload (`ACCEPT:<uuid>:<nonce>`) and
 * compared with `wholesale_quote.reply_nonce` by the webhook, so a reply can
 * only act on the quote it was sent for. 16 bytes from the CSPRNG
 * (`crypto.randomBytes`), hex: 32 characters, exactly `varchar(32)`, no
 * colon.
 */
import { randomBytes } from 'crypto';

export const REPLY_NONCE_BYTES = 16;

export const REPLY_NONCE_PATTERN = /^[0-9a-f]{32}$/;

export function generateReplyNonce(random: (size: number) => Buffer = randomBytes): string {
  return random(REPLY_NONCE_BYTES).toString('hex');
}
