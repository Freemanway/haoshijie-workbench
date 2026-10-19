import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto';
import { isValidMobile } from '@hsj/shared';

/**
 * 手机号、地址等个人信息：AES-256-GCM 加密存储，另存一份 HMAC 用于去重和匹配（PRD 隐私保护）。
 * 密钥来自 FIELD_ENCRYPTION_KEY（32 字节 base64）；开发和测试环境没配时用固定的开发密钥。
 */
function key() {
  const raw = process.env.FIELD_ENCRYPTION_KEY;
  if (raw) {
    const k = Buffer.from(raw, 'base64');
    if (k.length !== 32) throw new Error('FIELD_ENCRYPTION_KEY 应为 32 字节的 base64');
    return k;
  }
  if (process.env.NODE_ENV === 'production') throw new Error('生产环境必须配置 FIELD_ENCRYPTION_KEY');
  return createHash('sha256').update('hsj-dev-field-key').digest();
}

/** 去掉空格、横线和 +86 前缀；不是大陆手机号返回 null。 */
export function normalizePhone(s: string | null | undefined) {
  const d = (s ?? '').replace(/[\s-]/g, '').replace(/^(\+?86)(?=1\d{10}$)/, '');
  return isValidMobile(d) ? d : null;
}

export function hashPhone(phone: string) {
  return createHmac('sha256', key()).update(`phone:${phone}`).digest('hex');
}

/** 收货人 + 地址的 HMAC（键由 @hsj/shared 的 addressKey 生成），订单匹配用。 */
export function hashAddress(addrKey: string) {
  return createHmac('sha256', key()).update(`addr:${addrKey}`).digest('hex');
}

export function encrypt(text: string) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key(), iv);
  const body = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), body]).toString('base64');
}

export function decrypt(enc: string) {
  const buf = Buffer.from(enc, 'base64');
  const d = createDecipheriv('aes-256-gcm', key(), buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8');
}
