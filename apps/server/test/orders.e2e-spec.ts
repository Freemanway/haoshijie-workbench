import { INestApplication } from '@nestjs/common';
import JSZip from 'jszip';
import request from 'supertest';
import { hashPhone } from '../src/common/pii';
import { LeadsService } from '../src/leads/leads.service';
import { findHeaderRow, guessMapping, isCancelled, parseAmount, parseTime } from '../src/orders/mapping';
import { parseCsv } from '../src/orders/sheet';
import { bootApp, loginAs, prisma, resetDb } from './helpers';

/** 生成一个最简单的 .xlsx（内联字符串），模拟团购工具导出的订单表。 */
async function xlsx(rows: (string | number)[][]) {
  const col = (i: number) => String.fromCharCode(65 + i);
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const sheet = `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows
    .map((r, ri) => `<row r="${ri + 1}">${r.map((v, ci) => (typeof v === 'number' ? `<c r="${col(ci)}${ri + 1}"><v>${v}</v></c>` : v === '' ? '' : `<c r="${col(ci)}${ri + 1}" t="inlineStr"><is><t>${esc(v)}</t></is></c>`)).join('')}</row>`)
    .join('')}</sheetData></worksheet>`;
  const zip = new JSZip();
  zip.file('xl/workbook.xml', '<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="订单" sheetId="1" r:id="rId1"/></sheets></workbook>');
  zip.file('xl/_rels/workbook.xml.rels', '<Relationships><Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/></Relationships>');
  zip.file('xl/worksheets/sheet1.xml', sheet);
  return (await zip.generateAsync({ type: 'nodebuffer' })).toString('base64');
}

const KTT_HEAD = ['跟团号', '下单人', '商品', '数量', '订单金额', '收货人', '联系电话', '省', '市', '区', '详细地址', '订单状态', '支付时间'];
const KTT_ROWS: (string | number)[][] = [
  ['快团团 · 错峰鲜果第 3 团 订单导出'],
  KTT_HEAD,
  ['KT001', '小鹿', '金傲芬礼盒', 2, '256.00', '陆小鹿', '13812345678', '浙江省', '杭州市', '西湖区', '文三路 100 号', '已完成', '2026-10-14 12:30:00'],
  ['KT002', '晓雯', '金傲芬', 1, '128', '王晓雯', '139****1111', '广东省', '深圳市', '南山区', '粤海街道科技园南区8栋1203', '已完成', '2026/10/14 13:00'],
  ['KT002', '晓雯', '青皮', 1, '128', '王晓雯', '139****1111', '广东省', '深圳市', '南山区', '粤海街道科技园南区8栋1203', '已完成', '2026/10/14 13:00'],
  ['KT003', '张三', '格莱斯', 1, '¥99', '张三', '18600007721', '北京市', '北京市', '朝阳区', '望京 SOHO T1', '已完成', '2026年10月15日 09:10'],
  ['KT004', '小鹿', '青皮', 1, '99', '陆小鹿', '13812345678', '浙江省', '杭州市', '西湖区', '文三路 100 号', '已完成', 46310.5],
  ['KT005', '小鹿', '格莱斯', 1, '99', '陆小鹿', '13812345678', '浙江省', '杭州市', '西湖区', '文三路 100 号', '已退款', '2026-10-16 08:00'],
  ['KT006', '坏数据', '金傲芬', 1, 'abc', '某某', '13700000000', '', '', '', '', '', '2026-10-16'],
];

describe('成交导入（M11）', () => {
  let app: INestApplication;
  let admin: string;
  let cs: string;
  let biz: string;
  let viewer: string;
  let leads: LeadsService;
  let leadA: string;
  let leadB: string;
  let topicId: string;
  let file: string;
  const http = () => request(app.getHttpServer());
  const lead = (id: string) => prisma.lead.findUniqueOrThrow({ where: { id } });
  const order = (externalNo: string) => prisma.order.findFirstOrThrow({ where: { externalNo } });

  beforeAll(async () => {
    await resetDb();
    app = await bootApp();
    leads = app.get(LeadsService);
    admin = await loginAs(app, 'guanli', ['ADMIN']);
    cs = await loginAs(app, 'kefu', ['CS']);
    biz = await loginAs(app, 'zhaoshang', ['BIZ']);
    viewer = await loginAs(app, 'laoban', ['VIEWER']);

    // 作品：排期里回填过链接的稿件，对应选题
    const acc = await prisma.platformAccount.create({ data: { platform: 'XHS', name: '好时节果园', audience: 'C', externalId: 'xhs-1' } });
    const topic = await prisma.topic.create({ data: { title: '三种无花果盲盒开箱', audience: 'C', category: '开箱', platforms: ['XHS'] } });
    topicId = topic.id;
    const draft = await prisma.draft.create({ data: { topicId: topic.id, platform: 'XHS' } });
    await prisma.scheduleItem.create({ data: { draftId: draft.id, accountId: acc.id, publishAt: new Date(), postUrl: 'https://www.xiaohongshu.com/explore/66f1a2b3c4d5e6f7a8b9c0d1?xsec_token=abc' } });

    // 线索 A：留了手机号，来自那篇作品（分享链接参数不同）
    leadA = (await http().post('/api/leads').set('Authorization', cs).send({ audience: 'C', nickname: '小鹿', phone: '13812345678' }).expect(201)).body.id;
    await prisma.lead.update({ where: { id: leadA }, data: { sourcePlatform: 'XHS', sourceAccount: '好时节果园', sourcePostUrl: 'https://www.xiaohongshu.com/explore/66f1a2b3c4d5e6f7a8b9c0d1?share=wx' } });
    // 线索 B：没留手机号，只在私信里收了收货地址
    leadB = (await http().post('/api/leads').set('Authorization', cs).send({ audience: 'C', nickname: '晓雯爱吃果' }).expect(201)).body.id;
    await http().post(`/api/leads/${leadB}/addresses`).set('Authorization', cs).send({ name: '王晓雯', phone: '13900001111', province: '广东省', city: '深圳市', district: '南山区', detail: '粤海街道科技园南区8栋1203', confirmed: true }).expect(201);
    file = await xlsx(KTT_ROWS);
  });
  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  it('字段解析：金额、时间、退款状态、CSV、表头识别', () => {
    expect(parseAmount('¥1,256.50元')).toBe(125650);
    expect(parseAmount('abc')).toBeNull();
    expect(parseTime('2026-10-14 12:30:00')!.toISOString()).toBe('2026-10-14T04:30:00.000Z');
    expect(parseTime('2026年10月15日 09:10')!.toISOString()).toBe('2026-10-15T01:10:00.000Z');
    expect(parseTime('46310.5')!.toISOString()).toBe('2026-10-15T04:00:00.000Z');
    expect(isCancelled('已退款')).toBe(true);
    expect(isCancelled('部分退款')).toBe(false);
    expect(parseCsv('"a,b",c\r\n"x""y",z\n')).toEqual([['a,b', 'c'], ['x"y', 'z']]);
    expect(findHeaderRow(KTT_ROWS.map((r) => r.map(String)))).toBe(1);
    expect(guessMapping(KTT_HEAD)).toMatchObject({ externalNo: '跟团号', amount: '订单金额', phone: '联系电话', orderedAt: '支付时间', receiver: '收货人', address: '详细地址', province: '省', district: '区', status: '订单状态', buyerNick: '下单人' });
  });

  it('预览：跳过标题行找到表头，猜出快团团的字段映射', async () => {
    await http().post('/api/orders/import/preview').set('Authorization', viewer).send({ tool: 'ktt', fileName: 'a.xlsx', data: file }).expect(403);
    await http().post('/api/orders/import/preview').set('Authorization', cs).send({ tool: 'ktt', fileName: 'a.xls', data: file }).expect(400);
    const r = await http().post('/api/orders/import/preview').set('Authorization', cs).send({ tool: 'ktt', fileName: '订单.xlsx', data: file }).expect(201);
    expect(r.body.headers).toEqual(KTT_HEAD);
    expect(r.body.total).toBe(7);
    expect(r.body.sample[0][0]).toBe('KT001');
    expect(r.body.mapping).toMatchObject({ externalNo: '跟团号', amount: '订单金额', orderedAt: '支付时间', phone: '联系电话' });
  });

  it('导入：按手机号、收货人 + 地址匹配线索，归因到作品和选题，标复购，退款不计金额', async () => {
    const { mapping } = (await http().post('/api/orders/import/preview').set('Authorization', cs).send({ tool: 'ktt', fileName: '订单.xlsx', data: file })).body;
    await http().post('/api/orders/import').set('Authorization', cs).send({ tool: 'ktt', fileName: '订单.xlsx', data: file, mapping: { ...mapping, amount: '' } }).expect(400);
    const r = await http().post('/api/orders/import').set('Authorization', cs).send({ tool: 'ktt', fileName: '订单.xlsx', data: file, mapping }).expect(201);
    expect(r.body).toMatchObject({ total: 5, created: 5, duplicated: 0, matched: 4, unmatched: 1, failed: 1 });
    expect(r.body.errors[0]).toMatchObject({ row: 9 });

    const k1 = await order('KT001');
    expect(k1).toMatchObject({ leadId: leadA, matchedBy: 'phone', amountCents: 25600, attrPlatform: 'XHS', attrAccount: '好时节果园', attrTopicId: topicId, isRepeat: false, cancelled: false, quantity: 2 });
    expect(k1.phoneEnc).not.toContain('138');
    // 一单两行：商品合并，金额每行一样按订单金额算一次
    expect(await order('KT002')).toMatchObject({ leadId: leadB, matchedBy: 'receiver_address', amountCents: 12800, product: '金傲芬、青皮', quantity: 2 });
    expect(await order('KT004')).toMatchObject({ leadId: leadA, isRepeat: true });
    expect(await order('KT005')).toMatchObject({ leadId: leadA, cancelled: true, isRepeat: false });
    expect(await order('KT003')).toMatchObject({ leadId: null });

    expect(await lead(leadA)).toMatchObject({ status: 'WON', dealCents: 35500, orderCount: 2, dealTool: 'ktt' });
    expect((await lead(leadA)).wonAt!.toISOString()).toBe('2026-10-14T04:30:00.000Z');
    expect(await lead(leadB)).toMatchObject({ status: 'WON', dealCents: 12800 });

    // 再导一次同一张表：全部认作重复；映射已按工具记住
    const again = await http().post('/api/orders/import').set('Authorization', cs).send({ tool: 'ktt', fileName: '订单.xlsx', data: file, mapping }).expect(201);
    expect(again.body).toMatchObject({ created: 0, duplicated: 5 });
    const saved = await prisma.setting.findUniqueOrThrow({ where: { key: 'orders.mapping.ktt' } });
    expect(saved.value).toMatchObject({ externalNo: '跟团号' });
  });

  it('列表脱敏、汇总；管理层只读看不了明文', async () => {
    const r = await http().get('/api/orders').set('Authorization', viewer).expect(200);
    expect(r.body.summary).toMatchObject({ orders: 4, amountCents: 25600 + 12800 + 9900 + 9900, matched: 3, unmatched: 1, repeat: 1 });
    const k3 = r.body.items.find((o: { externalNo: string }) => o.externalNo === 'KT003');
    expect(k3).toMatchObject({ receiver: '张*', phone: '186****7721', toolName: '快团团', canHandle: false });
    expect(JSON.stringify(r.body)).not.toContain('18600007721');
    expect(JSON.stringify(r.body)).not.toContain('Enc');
    const un = await http().get('/api/orders?state=unmatched').set('Authorization', cs).expect(200);
    expect(un.body.items.map((o: { externalNo: string }) => o.externalNo)).toEqual(['KT003']);
    await http().post(`/api/orders/${k3.id}/reveal`).set('Authorization', viewer).expect(403);
    const plain = await http().post(`/api/orders/${k3.id}/reveal`).set('Authorization', cs).expect(201);
    expect(plain.body).toMatchObject({ receiver: '张三', phone: '18600007721', address: '北京市朝阳区望京 SOHO T1' });
  });

  it('群接龙 CSV（没有订单号列）：同一张表重导不重复；同手机号的订单算同一客户的复购', async () => {
    const csv = '\ufeff接龙时间,昵称,姓名,手机号,地址,商品名称,金额\n2026-10-17 10:00,张三丰,张三,186 0000 7721,北京市朝阳区望京SOHO T1,金傲芬礼盒,"1,299.00"\n';
    const data = Buffer.from(csv).toString('base64');
    const p = await http().post('/api/orders/import/preview').set('Authorization', cs).send({ tool: 'jielong', fileName: '接龙.csv', data }).expect(201);
    expect(p.body.mapping).toMatchObject({ orderedAt: '接龙时间', buyerNick: '昵称', receiver: '姓名', phone: '手机号', address: '地址', product: '商品名称', amount: '金额' });
    const r = await http().post('/api/orders/import').set('Authorization', cs).send({ tool: 'jielong', fileName: '接龙.csv', data, mapping: p.body.mapping }).expect(201);
    expect(r.body).toMatchObject({ created: 1, matched: 0 });
    const o = await prisma.order.findFirstOrThrow({ where: { tool: 'jielong' } });
    expect(o).toMatchObject({ amountCents: 129900, isRepeat: true, buyerNick: '张三丰', province: '北京市' });
    expect(o.externalNo).toMatch(/^h:/);
    const again = await http().post('/api/orders/import').set('Authorization', cs).send({ tool: 'jielong', fileName: '接龙.csv', data, mapping: p.body.mapping }).expect(201);
    expect(again.body).toMatchObject({ created: 0, duplicated: 1 });
  });

  it('未匹配订单人工关联：同一客户的其他未匹配订单一起关联；撤销关联后线索退回跟进中', async () => {
    const leadC = (await http().post('/api/leads').set('Authorization', cs).send({ audience: 'C', nickname: '张三丰' }).expect(201)).body.id;
    const k3 = await order('KT003');
    await http().post(`/api/orders/${k3.id}/link`).set('Authorization', viewer).send({ leadId: leadC }).expect(403);
    const r = await http().post(`/api/orders/${k3.id}/link`).set('Authorization', cs).send({ leadId: leadC }).expect(201);
    expect(r.body).toMatchObject({ leadId: leadC, matchedBy: 'manual' });
    const jl = await prisma.order.findFirstOrThrow({ where: { tool: 'jielong' } });
    expect(jl).toMatchObject({ leadId: leadC, matchedBy: 'manual', isRepeat: true });
    expect(await lead(leadC)).toMatchObject({ status: 'WON', orderCount: 2, dealCents: 9900 + 129900, dealTool: 'jielong' });

    const d = (await http().get(`/api/leads/${leadC}`).set('Authorization', cs).expect(200)).body;
    expect(d.orders).toHaveLength(2);
    expect(d.dealCents).toBe(139800);

    await http().post(`/api/orders/${jl.id}/unlink`).set('Authorization', cs).expect(201);
    await http().post(`/api/orders/${k3.id}/unlink`).set('Authorization', cs).expect(201);
    expect(await lead(leadC)).toMatchObject({ status: 'FOLLOWING', orderCount: 0, dealCents: 0, wonAt: null });
    expect(await order('KT003')).toMatchObject({ leadId: null, attrPlatform: null });
  });

  it('B 端人工录入成交：招商记报价、合同、金额；客服不能给 B 端录；按客群看订单', async () => {
    const leadBiz = (await http().post('/api/leads').set('Authorization', biz).send({ audience: 'B', name: '成都蓉果供应链', phone: '18980011234' }).expect(201)).body.id;
    const deal = { leadId: leadBiz, amount: 50000, quote: 52000, contractNo: 'HT-2026-001', product: '金傲芬 2 吨', orderedAt: '2026-10-18' };
    await http().post('/api/orders/manual').set('Authorization', cs).send(deal).expect(404);
    await http().post('/api/orders/manual').set('Authorization', biz).send({ ...deal, amount: 0 }).expect(400);
    const r = await http().post('/api/orders/manual').set('Authorization', biz).send(deal).expect(201);
    expect(r.body.orders[0]).toMatchObject({ tool: 'manual', amountCents: 5000000, quoteCents: 5200000, contractNo: 'HT-2026-001', matchedBy: 'manual' });
    expect(r.body).toMatchObject({ status: 'WON', dealCents: 5000000, dealTool: 'manual' });

    const mine = await http().get('/api/orders').set('Authorization', biz).expect(200);
    expect(mine.body.items.map((o: { tool: string }) => o.tool)).toEqual(['manual']);
    const csList = await http().get('/api/orders').set('Authorization', cs).expect(200);
    expect(csList.body.items.every((o: { audience: string }) => o.audience === 'C')).toBe(true);

    // 导入的订单不能单独删；人工录入的可以
    await http().delete(`/api/orders/${(await order('KT001')).id}`).set('Authorization', cs).expect(400);
    await http().delete(`/api/orders/${r.body.orders[0].id}`).set('Authorization', biz).expect(200);
    expect(await lead(leadBiz)).toMatchObject({ status: 'FOLLOWING', dealCents: 0 });
  });

  it('导错了整批删除（管理员），线索成交重算', async () => {
    const batch = await prisma.orderImport.findFirstOrThrow({ where: { tool: 'ktt', created: 5 } });
    await http().delete(`/api/orders/imports/${batch.id}`).set('Authorization', cs).expect(403);
    const r = await http().delete(`/api/orders/imports/${batch.id}`).set('Authorization', admin).expect(200);
    expect(r.body.removed).toBe(5);
    expect(await lead(leadA)).toMatchObject({ status: 'FOLLOWING', dealCents: 0, orderCount: 0 });
    expect(await prisma.order.count({ where: { tool: 'ktt' } })).toBe(0);
    const logs = await prisma.auditLog.findMany({ where: { action: { startsWith: 'order.' } } });
    expect(logs.map((l) => l.action)).toEqual(expect.arrayContaining(['order.import', 'order.reveal', 'order.link', 'order.unlink', 'order.manual', 'order.import.delete']));
  });

  it('M11 之前存的地址补上匹配哈希', async () => {
    const a = await prisma.address.findFirstOrThrow({ where: { leadId: leadB } });
    await prisma.address.update({ where: { id: a.id }, data: { phoneHash: null, matchHash: null } });
    await leads.backfillAddressHashes();
    const b = await prisma.address.findUniqueOrThrow({ where: { id: a.id } });
    expect(b.phoneHash).toBe(hashPhone('13900001111'));
    expect(b.matchHash).toBeTruthy();
  });
});
