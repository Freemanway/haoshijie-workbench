import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { decrypt, encrypt, hashPhone, normalizePhone } from '../src/common/pii';
import { CrmService } from '../src/wecom/crm.module';
import { WecomClient } from '../src/wecom/wecom.client';
import { WecomCrypto } from '../src/wecom/wecom.crypto';
import { NotifyService } from '../src/wecom/wecom.module';
import { bootApp, loginAs, prisma, resetDb } from './helpers';

const CORP = 'ww-test-corp';
const TOKEN = 'cb-token';
const AES = Buffer.alloc(32, 7).toString('base64').slice(0, 43);

describe('企业微信私域（M9）', () => {
  let app: INestApplication;
  let admin: string;
  let cs: string;
  let ops: string;
  let acc: string;
  let crm: CrmService;
  let notify: NotifyService;
  const http = () => request(app.getHttpServer());
  const crypt = new WecomCrypto(TOKEN, AES, CORP);

  // 企业微信那边的状态
  const fake = {
    seq: 0,
    welcomes: [] as { code: string; text: string; media?: string }[],
    tags: [] as { staff: string; ext: string; tags: string[] }[],
    contacts: {} as Record<string, { name: string; follow: { userid: string; remark_mobiles?: string[] }[] }>,
    groups: {} as Record<string, number>,
  };

  const callback = (fields: Record<string, string>) => {
    const inner = `<xml><ToUserName><![CDATA[${CORP}]]></ToUserName><CreateTime>${fields.CreateTime ?? String(++fake.seq)}</CreateTime><MsgType><![CDATA[event]]></MsgType>${Object.entries(fields)
      .filter(([k]) => k !== 'CreateTime')
      .map(([k, v]) => `<${k}><![CDATA[${v}]]></${k}>`)
      .join('')}</xml>`;
    const enc = crypt.encrypt(inner);
    const ts = '1760000000';
    const nonce = 'abc';
    return http()
      .post(`/api/wecom/callback?msg_signature=${crypt.signature(ts, nonce, enc)}&timestamp=${ts}&nonce=${nonce}`)
      .set('Content-Type', 'text/xml')
      .send(`<xml><ToUserName><![CDATA[${CORP}]]></ToUserName><Encrypt><![CDATA[${enc}]]></Encrypt></xml>`);
  };
  const added = async (ext: string, staff: string, state: string, extra: Record<string, string> = {}) => {
    await callback({ Event: 'change_external_contact', ChangeType: 'add_external_contact', UserID: staff, ExternalUserID: ext, State: state, WelcomeCode: `wc-${ext}`, ...extra }).expect(200);
    await crm.idle();
    return prisma.wecomContact.findUniqueOrThrow({ where: { externalUserId_staffId: { externalUserId: ext, staffId: staff } }, include: { lead: true } });
  };

  beforeAll(async () => {
    Object.assign(process.env, { WECOM_CORP_ID: CORP, WECOM_AGENT_ID: '1000002', WECOM_SECRET: 'x', WECOM_CALLBACK_TOKEN: TOKEN, WECOM_CALLBACK_AES_KEY: AES });
    await resetDb();
    app = await bootApp();
    crm = app.get(CrmService);
    notify = app.get(NotifyService);
    const wc = app.get(WecomClient);
    jest.spyOn(wc, 'sendText').mockResolvedValue(undefined);
    jest.spyOn(wc, 'addContactWay').mockImplementation(async () => ({ remoteId: `cfg-${++fake.seq}`, qrCode: `https://wework.qpic.cn/qr-${fake.seq}.png` }));
    jest.spyOn(wc, 'createLink').mockImplementation(async () => ({ remoteId: `link-${++fake.seq}`, url: `https://work.weixin.qq.com/ca/cawcde${fake.seq}` }));
    jest.spyOn(wc, 'updateContactWay').mockResolvedValue(undefined);
    jest.spyOn(wc, 'delContactWay').mockResolvedValue(undefined);
    jest.spyOn(wc, 'ensureTag').mockImplementation(async (_g, name) => `tag-${name}`);
    jest.spyOn(wc, 'markTag').mockImplementation(async (staff, ext, tags) => void fake.tags.push({ staff, ext, tags }));
    jest.spyOn(wc, 'sendWelcome').mockImplementation(async (code, text, media) => void fake.welcomes.push({ code, text, media }));
    jest.spyOn(wc, 'externalContact').mockImplementation(async (ext) => fake.contacts[ext] ?? { name: '微信用户', follow: [] });
    jest.spyOn(wc, 'addJoinWay').mockImplementation(async () => `join-${++fake.seq}`);
    jest.spyOn(wc, 'joinWayQr').mockImplementation(async (id) => `https://wework.qpic.cn/group-${id}.png`);
    jest.spyOn(wc, 'updateJoinWay').mockResolvedValue(undefined);
    jest.spyOn(wc, 'groupChat').mockImplementation(async (id) => ({ name: `团购${id}群`, count: fake.groups[id] ?? 0 }));
    jest.spyOn(wc, 'uploadImage').mockResolvedValue('media-group-qr');

    admin = await loginAs(app, 'guanli', ['ADMIN']);
    cs = await loginAs(app, 'kefu', ['CS']);
    await loginAs(app, 'zhaoshang', ['BIZ']);
    ops = await loginAs(app, 'yunying', ['CONTENT']);
    acc = (await prisma.platformAccount.create({ data: { platform: 'XHS', name: '好时节果园', audience: 'C' } })).id;
    await prisma.riskWord.create({ data: { word: '包治百病', category: '医疗功效', level: 'block' } });
  });
  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
    for (const k of ['WECOM_CORP_ID', 'WECOM_AGENT_ID', 'WECOM_SECRET', 'WECOM_CALLBACK_TOKEN', 'WECOM_CALLBACK_AES_KEY']) delete process.env[k];
  });

  let group: { id: string; qrCode: string };
  let qr: { id: string; state: string };

  it('团购群活码：生成二维码并记录各群人数；没开自动建群时群都满了提醒一次', async () => {
    fake.groups = { 'wr-1': 120, 'wr-2': 60 };
    const res = await http().post('/api/wecom/groups').set('Authorization', admin).send({ name: '秋季鲜果团', chatIds: ['wr-1', 'wr-2'], autoCreate: false }).expect(201);
    group = res.body;
    expect(res.body.qrCode).toContain('group-join-');
    expect(res.body.members['wr-1']).toEqual({ name: '团购wr-1群', count: 120 });
    await http().post('/api/wecom/groups').set('Authorization', admin).send({ name: '太多群', chatIds: ['1', '2', '3', '4', '5', '6'] }).expect(400);

    fake.groups = { 'wr-1': 199, 'wr-2': 195 };
    const before = notify.sent.length;
    await crm.checkGroups(new Date(), true);
    expect(notify.sent.at(-1)!.text).toContain('团购群快满了');
    await crm.checkGroups(new Date(), true);
    expect(notify.sent.length).toBe(before + 1);
  });

  it('渠道活码：只有管理员能建；接待成员必须是工作台成员；欢迎语过风控；建好自动打来源标签', async () => {
    const body = { kind: 'qr', name: '小红书-好时节果园', accountId: acc, audience: 'C', staff: ['kefu'], groupWayId: group.id };
    await http().post('/api/wecom/channels').set('Authorization', ops).send(body).expect(403);
    const bad = await http().post('/api/wecom/channels').set('Authorization', admin).send({ ...body, staff: ['nobody'] }).expect(400);
    expect(bad.body.message).toContain('nobody');
    const risky = await http().post('/api/wecom/channels').set('Authorization', admin).send({ ...body, welcomeText: '我们的无花果包治百病' }).expect(400);
    expect(risky.body.message).toContain('包治百病');
    const res = await http().post('/api/wecom/channels').set('Authorization', admin).send(body).expect(201);
    qr = res.body;
    expect(res.body).toMatchObject({ kind: 'qr', tagId: 'tag-小红书-好时节果园', qrCode: expect.stringContaining('qr-') });
    expect(res.body.state).toMatch(/^ch_[0-9a-f]{16}$/);

    const link = await http().post('/api/wecom/channels').set('Authorization', admin).send({ kind: 'link', name: '小红书-获客链接', accountId: acc, audience: 'C', staff: ['kefu', 'zhaoshang'] }).expect(201);
    expect(link.body.url).toContain(`customer_channel=${link.body.state}`);
  });

  it('回调地址校验：签名对才解出 echostr', async () => {
    const enc = crypt.encrypt('echo-123');
    const sig = crypt.signature('1', '2', enc);
    const ok = await http().get('/api/wecom/callback').query({ msg_signature: sig, timestamp: '1', nonce: '2', echostr: enc }).expect(200);
    expect(ok.text).toBe('echo-123');
    await http().get('/api/wecom/callback').query({ msg_signature: 'bad', timestamp: '1', nonce: '2', echostr: enc }).expect(403);
    await http().post('/api/wecom/callback?msg_signature=bad&timestamp=1&nonce=2').set('Content-Type', 'text/xml').send(`<xml><Encrypt><![CDATA[${enc}]]></Encrypt></xml>`).expect(403);
  });

  it('扫渠道活码加微：发欢迎语（C 端附团购群码）、打来源标签、新建线索；重复推送只处理一次', async () => {
    fake.contacts['wm-1'] = { name: '小鹿', follow: [{ userid: 'kefu' }] };
    const c = await added('wm-1', 'kefu', qr.state, { CreateTime: '777' });
    expect(fake.welcomes.at(-1)).toEqual({ code: 'wc-wm-1', text: expect.stringContaining('小鹿你好呀'), media: 'media-group-qr' });
    expect(fake.tags.at(-1)).toEqual({ staff: 'kefu', ext: 'wm-1', tags: ['tag-小红书-好时节果园'] });
    expect(c).toMatchObject({ welcome: 'sent', tagged: true, channelId: qr.id, name: '小鹿' });
    expect(c.lead).toMatchObject({ status: 'ADDED_WECOM', audience: 'C', sourcePlatform: 'XHS', sourceAccount: '好时节果园', wecomChannel: qr.id, nickname: '小鹿' });

    const n = fake.welcomes.length;
    await added('wm-1', 'kefu', qr.state, { CreateTime: '777' });
    expect(fake.welcomes.length).toBe(n);
    expect(await prisma.lead.count()).toBe(1);

    const list = await http().get('/api/wecom/channels').set('Authorization', cs).expect(200);
    expect(list.body.find((x: { id: string }) => x.id === qr.id)).toMatchObject({ added: 1, addedWeek: 1 });
  });

  it('私信里发专属加微链接：客户加微后线索直接挂到这条会话上，会话标记已引流', async () => {
    const conv = await prisma.conversation.create({ data: { accountId: acc, externalUserId: 'xhs-u1', nickname: '阿茶', audience: 'C', status: 'AGENT_HANDLING' } });
    await http().get(`/api/wecom/conversation-link/${conv.id}`).set('Authorization', ops).expect(403);
    const r = await http().get(`/api/wecom/conversation-link/${conv.id}`).set('Authorization', cs).expect(200);
    expect(r.body.url).toContain(`customer_channel=cv_${conv.id}`);
    expect(r.body.url).not.toContain('ch_');

    const c = await added('wm-2', 'zhaoshang', `cv_${conv.id}`);
    expect(c.lead).toMatchObject({ conversationId: conv.id, nickname: '阿茶', status: 'ADDED_WECOM', sourceAccount: '好时节果园' });
    expect(c.channelId).toBe(r.body.channel.id);
    const after = await prisma.conversation.findUniqueOrThrow({ where: { id: conv.id }, include: { messages: true } });
    expect(after.status).toBe('DIVERTED');
    expect(after.messages.at(-1)!.text).toContain('已添加企业微信');
  });

  it('员工备注了手机号：加微时按手机号对上已有线索；事后补备注也会并过去', async () => {
    const old = await prisma.lead.create({ data: { audience: 'B', nickname: '果商老王', phoneHash: hashPhone('13800138000') } });
    fake.contacts['wm-3'] = { name: '老王', follow: [{ userid: 'zhaoshang', remark_mobiles: ['+86 138-0013-8000'] }] };
    const c = await added('wm-3', 'zhaoshang', qr.state);
    expect(c.leadId).toBe(old.id);
    expect(c.lead!.status).toBe('ADDED_WECOM');

    const old2 = await prisma.lead.create({ data: { audience: 'C', nickname: '留资客户', phoneHash: hashPhone('13900139000') } });
    fake.contacts['wm-4'] = { name: '新朋友', follow: [{ userid: 'kefu' }] };
    const temp = await added('wm-4', 'kefu', qr.state);
    expect(temp.leadId).not.toBe(old2.id);
    fake.contacts['wm-4'].follow[0].remark_mobiles = ['13900139000'];
    await callback({ Event: 'change_external_contact', ChangeType: 'edit_external_contact', UserID: 'kefu', ExternalUserID: 'wm-4' }).expect(200);
    await crm.idle();
    const moved = await prisma.wecomContact.findUniqueOrThrow({ where: { externalUserId_staffId: { externalUserId: 'wm-4', staffId: 'kefu' } } });
    expect(moved.leadId).toBe(old2.id);
    expect(await prisma.lead.findUnique({ where: { id: temp.leadId! } })).toBeNull();
  });

  it('客户删了员工：记录删除时间；欢迎语设置有拦截词不能保存', async () => {
    await callback({ Event: 'change_external_contact', ChangeType: 'del_follow_user', UserID: 'kefu', ExternalUserID: 'wm-1' }).expect(200);
    await crm.idle();
    expect((await prisma.wecomContact.findUniqueOrThrow({ where: { externalUserId_staffId: { externalUserId: 'wm-1', staffId: 'kefu' } } })).removedAt).not.toBeNull();

    const s = (await http().get('/api/wecom/settings').set('Authorization', cs).expect(200)).body;
    await http().put('/api/wecom/settings').set('Authorization', cs).send(s).expect(403);
    await http().put('/api/wecom/settings').set('Authorization', admin).send({ ...s, welcome: { ...s.welcome, C: '包治百病' } }).expect(400);
    await http().put('/api/wecom/settings').set('Authorization', admin).send({ ...s, groupFullAt: 180 }).expect(200);

    const contacts = await http().get('/api/wecom/contacts').set('Authorization', cs).expect(200);
    expect(contacts.body).toHaveLength(4);
    await http().get('/api/wecom/contacts').set('Authorization', ops).expect(403);
  });

  it('个人信息：手机号统一格式后再算哈希，加密可还原且每次密文不同', () => {
    expect(normalizePhone('+86 139-0013-9000')).toBe('13900139000');
    expect(normalizePhone('12345')).toBeNull();
    expect(hashPhone('13900139000')).toHaveLength(64);
    const a = encrypt('13900139000');
    expect(a).not.toBe(encrypt('13900139000'));
    expect(decrypt(a)).toBe('13900139000');
  });
});
