import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * 企业微信回调加解密（与官方 WXBizMsgCrypt 一致）。
 * 文档：https://developer.work.weixin.qq.com/document/path/90968
 */
export class WecomCrypto {
  private readonly key: Buffer;

  constructor(
    private readonly token: string,
    encodingAesKey: string,
    private readonly receiveId: string,
  ) {
    this.key = Buffer.from(`${encodingAesKey}=`, 'base64');
    if (this.key.length !== 32) throw new Error('EncodingAESKey 应为 43 位');
  }

  signature(timestamp: string, nonce: string, encrypted: string) {
    return createHash('sha1').update([this.token, timestamp, nonce, encrypted].sort().join('')).digest('hex');
  }

  verify(signature: string, timestamp: string, nonce: string, encrypted: string) {
    const want = Buffer.from(this.signature(timestamp, nonce, encrypted));
    const got = Buffer.from(signature ?? '');
    return want.length === got.length && timingSafeEqual(want, got);
  }

  decrypt(encrypted: string) {
    const d = createDecipheriv('aes-256-cbc', this.key, this.key.subarray(0, 16));
    d.setAutoPadding(false);
    let buf = Buffer.concat([d.update(Buffer.from(encrypted, 'base64')), d.final()]);
    const pad = buf[buf.length - 1];
    if (pad < 1 || pad > 32) throw new Error('解密失败');
    buf = buf.subarray(0, buf.length - pad);
    const len = buf.readUInt32BE(16);
    const msg = buf.subarray(20, 20 + len).toString('utf8');
    const from = buf.subarray(20 + len).toString('utf8');
    if (from !== this.receiveId) throw new Error('回调不是发给本企业的');
    return msg;
  }

  encrypt(msg: string) {
    const body = Buffer.from(msg, 'utf8');
    const len = Buffer.alloc(4);
    len.writeUInt32BE(body.length);
    let buf = Buffer.concat([randomBytes(16), len, body, Buffer.from(this.receiveId)]);
    const pad = 32 - (buf.length % 32);
    buf = Buffer.concat([buf, Buffer.alloc(pad, pad)]);
    const c = createCipheriv('aes-256-cbc', this.key, this.key.subarray(0, 16));
    c.setAutoPadding(false);
    return Buffer.concat([c.update(buf), c.final()]).toString('base64');
  }
}

/** 取 XML 里某个字段的值（回调报文结构固定、只有一层，用不着完整的 XML 解析器）。 */
export function xmlField(xml: string, name: string): string | undefined {
  const m = new RegExp(`<${name}>(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([^<]*))</${name}>`).exec(xml);
  return m ? (m[1] ?? m[2]) : undefined;
}
