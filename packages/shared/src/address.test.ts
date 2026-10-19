import { describe, expect, it } from 'vitest';
import { addressKey, maskPhone, parseAddress } from './address';

describe('parseAddress', () => {
  it('拆分整段地址', () => {
    const r = parseAddress('王晓雯 13812345678 广东省深圳市南山区粤海街道科技园南区8栋1203');
    expect(r).toMatchObject({
      name: '王晓雯',
      phone: '13812345678',
      province: '广东省',
      city: '深圳市',
      district: '南山区',
      detail: '粤海街道科技园南区8栋1203',
      ok: true,
    });
  });

  it('处理直辖市和带标签的写法', () => {
    const r = parseAddress('收货人：李明\n电话：139-0012-3456\n地址：上海市徐汇区漕溪北路 100 号');
    expect(r).toMatchObject({ name: '李明', phone: '13900123456', province: '上海市', city: '上海市', district: '徐汇区' });
  });

  it('姓名在末尾', () => {
    const r = parseAddress('浙江省杭州市西湖区文三路 90 号 18600001111 张伟');
    expect(r.name).toBe('张伟');
    expect(r.city).toBe('杭州市');
  });

  it('配送范围外转人工', () => {
    const r = parseAddress('艾力 13990012233 新疆维吾尔自治区乌鲁木齐市天山区解放北路 88 号');
    expect(r.outOfRange).toBe(true);
    expect(r.ok).toBe(false);
  });

  it('缺手机号时提示', () => {
    expect(parseAddress('广东省广州市天河区体育西路 1 号').message).toContain('手机号');
  });

  it('手机号脱敏', () => {
    expect(maskPhone('13812345678')).toBe('138****5678');
  });
});

describe('addressKey', () => {
  it('写法不同的同一地址得到同一个键', () => {
    const a = addressKey('王晓雯', '广东省深圳市南山区粤海街道科技园南区8栋1203');
    expect(a).toBe(addressKey('王晓雯', '深圳市 南山区 粤海街道科技园南区８栋１２０３'));
    expect(a).toBe(addressKey('王晓雯 ', '广东 深圳 南山 粤海街道科技园南区8栋1203'));
    expect(addressKey('李明', '上海上海市徐汇区漕溪北路100号')).toBe(addressKey('李明', '徐汇区漕溪北路 100 号'));
  });

  it('收件人不同或地址太短不算', () => {
    expect(addressKey('王晓雯', '广东省深圳市南山区科技园')).not.toBe(addressKey('王小雯', '广东省深圳市南山区科技园'));
    expect(addressKey('王晓雯', '深圳')).toBeNull();
    expect(addressKey('', '广东省深圳市南山区科技园')).toBeNull();
  });
});
