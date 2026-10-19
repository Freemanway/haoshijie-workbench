import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { InboxService } from '../src/inbox/inbox.module';
import { LeadsService } from '../src/leads/leads.service';
import { NotifyService } from '../src/wecom/wecom.module';
import { bootApp, loginAs, prisma, resetDb } from './helpers';

const ALL_DAY = { days: [1, 2, 3, 4, 5, 6, 7], start: '00:00', end: '23:59' };

describe('线索库（M10）', () => {
  let app: INestApplication;
  let admin: string;
  let cs: string;
  let cs2: string;
  let biz: string;
  let viewer: string;
  let ops: string;
  let acc: string;
  let acc2: string;
  let inbox: InboxService;
  let leads: LeadsService;
  let notify: NotifyService;
  const http = () => request(app.getHttpServer());
  const paste = (nickname: string, text: string, accountId = acc) =>
    http().post('/api/inbox/manual').set('Authorization', cs).send({ accountId, nickname, text }).expect(201).then(async (r) => {
      await inbox.idle();
      return r;
    });
  const leadOf = async (conversationId: string) => prisma.lead.findFirst({ where: { OR: [{ conversationId }, { sources: { some: { conversationId } } }] }, include: { sources: true, addresses: true } });

  beforeAll(async () => {
    await resetDb();
    app = await bootApp();
    inbox = app.get(InboxService);
    leads = app.get(LeadsService);
    notify = app.get(NotifyService);
    admin = await loginAs(app, 'guanli', ['ADMIN']);
    cs = await loginAs(app, 'kefu', ['CS']);
    cs2 = await loginAs(app, 'kefu2', ['CS']);
    biz = await loginAs(app, 'zhaoshang', ['BIZ']);
    viewer = await loginAs(app, 'laoban', ['VIEWER']);
    ops = await loginAs(app, 'yunying', ['CONTENT']);
    acc = (await prisma.platformAccount.create({ data: { platform: 'XHS', name: '好时节果园', audience: 'C', externalId: 'xhs-1' } })).id;
    acc2 = (await prisma.platformAccount.create({ data: { platform: 'XHS', name: '好时节批发', audience: 'B', externalId: 'xhs-2' } })).id;
    await prisma.setting.create({ data: { key: 'inbox', value: { workHours: ALL_DAY } } });
    await prisma.faqItem.create({ data: { category: '价格', question: '无花果多少钱', answer: '鲜果礼盒 2 斤装 99 元，顺丰冷链包邮～' } });
  });
  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  it('有效咨询才建线索：闲聊不建，问价格建 C 端线索并轮流分给客服', async () => {
    const chat = await paste('路人', '你好');
    expect(await leadOf(chat.body.id)).toBeNull();

    const r1 = await paste('小鹿', '无花果多少钱一盒？');
    const l1 = await leadOf(r1.body.id);
    expect(l1).toMatchObject({ audience: 'C', status: 'NEW', intent: 'high', sourcePlatform: 'XHS', sourceAccount: '好时节果园', nickname: '小鹿' });
    expect(l1!.sources).toHaveLength(1);
    const r2 = await paste('阿茶', '想买无花果送人，多少钱？');
    const l2 = await leadOf(r2.body.id);
    const owners = await prisma.user.findMany({ where: { id: { in: [l1!.ownerId!, l2!.ownerId!] } } });
    expect(owners.map((o) => o.wecomId).sort()).toEqual(['kefu', 'kefu2']);
    expect(notify.sent.at(-1)!.text).toContain('【新线索】C 端');
    // 后台从对话提取意向
    expect((l2!.intentDetail as { scene?: string }).scene).toBe('送礼');
  });

  it('同一平台用户 ID 换账号来咨询：合并成一条，保留两次来源', async () => {
    await inbox.ingest('api', { id: 'p1', accountId: 'xhs-1', kind: 'dm', userId: 'u-777', nickname: '果商老王', text: '你们怎么批发，价格多少' }, { wait: true });
    await inbox.ingest('api', { id: 'p2', accountId: 'xhs-2', kind: 'dm', userId: 'u-777', nickname: '果商老王', text: '起订量多少？想做代理' }, { wait: true });
    await inbox.idle();
    const rows = await prisma.lead.findMany({ where: { sources: { some: { platformUserId: 'u-777' } } }, include: { sources: true, owner: true } });
    expect(rows).toHaveLength(1);
    expect(rows[0].sources.map((s) => s.accountName).sort()).toEqual(['好时节批发', '好时节果园']);
    expect(rows[0].audience).toBe('B');
  });

  it('客户在私信里留手机号：记到线索上（加密）；另一位客户留了同一个号就合并', async () => {
    const r = await paste('小鹿', '我电话 138 0013 8000，方便的话联系我');
    const l = await leadOf(r.body.id);
    expect(l!.phoneHash).toBeTruthy();
    expect(l!.phoneEnc).not.toContain('13800138000');
    expect(r.body.messages.some((m: { sender: string; text: string }) => m.sender === 'system' && m.text.includes('手机号'))).toBe(true);

    const other = await paste('小鹿的小号', '多少钱？我手机 13800138000');
    const merged = await leadOf(other.body.id);
    expect(merged!.id).toBe(l!.id);
    expect(merged!.sources).toHaveLength(2);

    const list = await http().get('/api/leads?audience=C').set('Authorization', cs).expect(200);
    const row = list.body.items.find((x: { id: string }) => x.id === l!.id);
    expect(row.phone).toBe('138****8000');
    expect(JSON.stringify(list.body)).not.toContain('13800138000');
  });

  it('客户发整段地址：回显核对（只露手机尾号并告知用途），回复“确认”后入库；配送范围外转人工', async () => {
    const r = await paste('阿茶', '王晓雯 13912345678 广东省深圳市南山区粤海街道科技园南区8栋1203');
    const echo = r.body.messages.filter((m: { sender: string }) => m.sender === 'ai').at(-1);
    expect(echo.text).toContain('收件人：王晓雯');
    expect(echo.text).toContain('尾号 5678');
    expect(echo.text).not.toContain('13912345678');
    expect(echo.text).toContain('只用于发货');
    let l = await leadOf(r.body.id);
    expect(l!.addresses).toHaveLength(1);
    expect(l!.addresses[0]).toMatchObject({ province: '广东省', city: '深圳市', district: '南山区', confirmed: false, source: 'chat' });

    const ok = await paste('阿茶', '确认');
    expect(ok.body.messages.filter((m: { sender: string }) => m.sender === 'ai').at(-1).text).toContain('已确认');
    l = await leadOf(r.body.id);
    expect(l!.addresses[0].confirmed).toBe(true);

    const far = await paste('远方', '买两盒，寄 李四 13700001111 新疆维吾尔自治区乌鲁木齐市天山区解放北路1号');
    expect(far.body.status).toBe('WAITING_AGENT');
    expect(far.body.handoffReason).toContain('不在配送范围');
  });

  it('权限：客服只看 C 端、只能改自己负责的；招商管 B 端；管理层只看脱敏；运营看不到', async () => {
    await http().get('/api/leads').set('Authorization', ops).expect(403);
    const csList = await http().get('/api/leads').set('Authorization', cs).expect(200);
    expect(csList.body.items.every((x: { audience: string }) => x.audience === 'C')).toBe(true);
    const bizList = await http().get('/api/leads').set('Authorization', biz).expect(200);
    expect(bizList.body.items.every((x: { audience: string }) => x.audience === 'B')).toBe(true);
    expect((await http().get('/api/leads?audience=B').set('Authorization', cs).expect(200)).body.items).toHaveLength(0);

    const kefu2 = await prisma.user.findUniqueOrThrow({ where: { wecomId: 'kefu2' } });
    const theirs = await prisma.lead.findFirstOrThrow({ where: { ownerId: kefu2.id } });
    await http().patch(`/api/leads/${theirs.id}`).set('Authorization', cs).send({ intent: 'low' }).expect(403);
    await http().patch(`/api/leads/${theirs.id}`).set('Authorization', cs2).send({ intent: 'low' }).expect(200);
    await http().post(`/api/leads/${theirs.id}/reveal`).set('Authorization', viewer).send({}).expect(403);
    const v = await http().get(`/api/leads/${theirs.id}`).set('Authorization', viewer).expect(200);
    expect(v.body.canEdit).toBe(false);

    const b = bizList.body.items[0];
    await http().patch(`/api/leads/${b.id}`).set('Authorization', biz).send({ intentDetail: { city: '长沙', channel: '水果店' } }).expect(200);
    await http().get(`/api/leads/${b.id}`).set('Authorization', cs).expect(404);
  });

  it('人工改过的客群和意向，AI 不再覆盖', async () => {
    const l = await prisma.lead.findFirstOrThrow({ where: { nickname: '阿茶' } });
    const owner = await prisma.user.findUniqueOrThrow({ where: { id: l.ownerId! } });
    const token = owner.wecomId === 'kefu' ? cs : cs2;
    await http().patch(`/api/leads/${l.id}`).set('Authorization', token).send({ intent: 'medium' }).expect(200);
    await paste('阿茶', '一共多少钱？怎么下单');
    expect((await prisma.lead.findUniqueOrThrow({ where: { id: l.id } })).intent).toBe('medium');
  });

  it('跟进记录：状态变跟进中；到期和超时未跟进提醒负责人，各提醒一次', async () => {
    const l = await prisma.lead.findFirstOrThrow({ where: { nickname: '阿茶' } });
    const owner = await prisma.user.findUniqueOrThrow({ where: { id: l.ownerId! } });
    const token = owner.wecomId === 'kefu' ? cs : cs2;
    const due = new Date(Date.now() - 60_000).toISOString();
    const r = await http().post(`/api/leads/${l.id}/follow-ups`).set('Authorization', token).send({ note: '打过电话，周末再联系', nextFollowAt: due }).expect(201);
    expect(r.body).toMatchObject({ status: 'FOLLOWING', followUps: [{ note: '打过电话，周末再联系', user: { name: owner.name } }] });

    const stale = await prisma.lead.findFirstOrThrow({ where: { nickname: '小鹿' } });
    await prisma.lead.update({ where: { id: stale.id }, data: { createdAt: new Date(Date.now() - 25 * 3600_000) } });
    const t = await leads.remind(new Date(), true);
    expect(t).toMatchObject({ due: 1 });
    expect(t.stale).toBeGreaterThanOrEqual(1);
    expect(notify.sent.some((n) => n.to.includes(owner.wecomId) && n.text.includes('该跟进了'))).toBe(true);
    expect(notify.sent.some((n) => n.text.includes('【线索未跟进】小鹿'))).toBe(true);
    expect(await leads.remind(new Date(), true)).toEqual({ due: 0, stale: 0 });
  });

  it('地址：手动添加（配送范围外拒绝）、批量导入（报出失败行）、查看明文留日志', async () => {
    const l = await prisma.lead.findFirstOrThrow({ where: { nickname: '小鹿' } });
    const owner = await prisma.user.findUniqueOrThrow({ where: { id: l.ownerId! } });
    const token = owner.wecomId === 'kefu' ? cs : cs2;
    await http().post(`/api/leads/${l.id}/addresses`).set('Authorization', token).send({ name: '张三', phone: '13511112222', province: '西藏自治区', city: '拉萨市', detail: '北京中路 1 号' }).expect(400);
    const added = await http().post(`/api/leads/${l.id}/addresses`).set('Authorization', token).send({ name: '张三', phone: '13511112222', province: '浙江省', city: '杭州市', district: '西湖区', detail: '文三路 100 号', confirmed: true }).expect(201);
    const a = added.body.addresses.at(-1);
    expect(a).toMatchObject({ name: '张*', phone: '135****2222', detail: '文三路 ****', confirmed: true });

    const imp = await http().post(`/api/leads/${l.id}/addresses/import`).set('Authorization', token).send({
      text: '收件人\t电话\t地址\n李雷\t13600001111\t江苏省南京市鼓楼区中山路 8 号\n韩梅梅\t13600002222\t上海市浦东新区世纪大道 100 号\n没电话的\t\t广东省广州市天河区\n',
    }).expect(201);
    expect(imp.body.created).toBe(2);
    expect(imp.body.failed).toEqual([expect.objectContaining({ line: 4 })]);

    const plain = await http().post(`/api/leads/${l.id}/reveal`).set('Authorization', token).send({ addressId: a.id }).expect(201);
    expect(plain.body).toMatchObject({ name: '张三', phone: '13511112222', detail: '文三路 100 号' });
    expect(await prisma.auditLog.count({ where: { action: 'lead.reveal', target: l.id } })).toBe(1);
  });

  it('导出明文只有管理员能导，并记日志；推荐话术按客群给', async () => {
    await http().get('/api/leads/export').set('Authorization', cs).expect(403);
    const csv = await http().get('/api/leads/export?audience=C').set('Authorization', admin).expect(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.text).toContain('13800138000');
    expect(csv.text).toContain('客群,状态');
    expect(await prisma.auditLog.count({ where: { action: 'lead.export' } })).toBe(1);

    const b = await prisma.lead.findFirstOrThrow({ where: { audience: 'B' } });
    const s = await http().post(`/api/leads/${b.id}/script`).set('Authorization', biz).expect(201);
    expect(s.body.scripts[0]).toContain('招商');
  });

  it('手动录入：同手机号已有线索时提示去原线索跟进', async () => {
    await http().post('/api/leads').set('Authorization', cs).send({ audience: 'C', nickname: '老客户', phone: '13800138000' }).expect(400);
    await http().post('/api/leads').set('Authorization', cs).send({ audience: 'B', nickname: '果商' }).expect(403);
    const r = await http().post('/api/leads').set('Authorization', biz).send({ audience: 'B', nickname: '展会认识的果商', phone: '13300001111', intent: 'high' }).expect(201);
    const biz0 = await prisma.user.findUniqueOrThrow({ where: { wecomId: 'zhaoshang' } });
    expect(r.body).toMatchObject({ audience: 'B', ownerId: biz0.id, editedFields: expect.arrayContaining(['intent']) });
  });
});
