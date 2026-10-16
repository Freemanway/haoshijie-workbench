import { maskPhone, parseAddress } from '@hsj/shared';
import { Alert, Button, Card, Descriptions, Input, Space, Typography } from 'antd';
import { useState } from 'react';

export function AddressPage() {
  const [raw, setRaw] = useState('王晓雯 13812345678 广东省深圳市南山区粤海街道科技园南区8栋1203');
  const [result, setResult] = useState(() => parseAddress(raw));

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Typography.Title level={3} style={{ margin: 0 }}>线索库</Typography.Title>
      <Typography.Text type="secondary">线索列表开发中（M10-3）。下面是地址智能拆分（M10-2）。</Typography.Text>
      <Card title="地址智能拆分">
        <Input.TextArea id="addr-raw" rows={3} value={raw} onChange={(e) => setRaw(e.target.value)} />
        <Button type="primary" style={{ marginTop: 12 }} onClick={() => setResult(parseAddress(raw))}>
          拆分
        </Button>
        <Descriptions column={1} size="small" style={{ marginTop: 16 }}>
          <Descriptions.Item label="收件人">{result.name || '—'}</Descriptions.Item>
          <Descriptions.Item label="电话">{result.phone ? maskPhone(result.phone) : '—'}</Descriptions.Item>
          <Descriptions.Item label="省市区">{[result.province, result.city, result.district].filter(Boolean).join(' ') || '—'}</Descriptions.Item>
          <Descriptions.Item label="详细地址">{result.detail || '—'}</Descriptions.Item>
        </Descriptions>
        {!result.ok && <Alert type={result.outOfRange ? 'error' : 'warning'} message={result.message} showIcon />}
      </Card>
    </Space>
  );
}
