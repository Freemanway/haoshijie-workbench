import { Form, Input, InputNumber, Select, Space, Switch, Tag, Typography } from 'antd';
import { CrudTable } from '../components/CrudTable';
import { AUDIENCE_LABEL, PLATFORM_LABEL, ROLE_LABEL } from '../lib/api';
import { useAuth } from '../lib/auth';

interface User { id: string; wecomId: string; name: string; roles: string[]; active: boolean }
interface Account { id: string; platform: string; name: string; audience: string; externalId: string | null; dailyPostCap: number }

const options = (m: Record<string, string>) => Object.entries(m).map(([value, label]) => ({ value, label }));

export function MembersPage() {
  const { me } = useAuth();
  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <div>
        <Typography.Title level={3} style={{ margin: 0 }}>成员与权限</Typography.Title>
        <Typography.Text type="secondary">只有这里添加过的企业微信成员才能登录；停用后立即退出</Typography.Text>
      </div>
      <CrudTable<User>
        entity="成员"
        listPath="/users"
        basePath="/users"
        canEdit
        canDelete={false}
        initialValues={{ roles: ['CS'], active: true }}
        columns={[
          { title: '姓名', dataIndex: 'name' },
          { title: '企业微信账号', dataIndex: 'wecomId' },
          { title: '角色', dataIndex: 'roles', render: (r: string[]) => r.map((x) => <Tag key={x}>{ROLE_LABEL[x] ?? x}</Tag>) },
          {
            title: '状态', dataIndex: 'active',
            render: (a: boolean, u) => (
              <>
                {a ? <Tag color="green">在用</Tag> : <Tag>已停用</Tag>}
                {u.id === me?.id && <Tag color="purple">我</Tag>}
              </>
            ),
          },
        ]}
        form={
          <>
            {/* 企业微信账号建好后不能改；后端更新接口也不接收它 */}
            <Form.Item noStyle shouldUpdate>
              {({ getFieldValue }) => (
                <Form.Item label="企业微信成员账号" name="wecomId" rules={[{ required: true, message: '请填写企业微信成员账号' }]}
                  extra="企业微信管理后台“通讯录 > 成员详情”里的账号">
                  <Input disabled={!!getFieldValue('id')} />
                </Form.Item>
              )}
            </Form.Item>
            <Form.Item name="id" hidden><Input /></Form.Item>
            <Form.Item label="姓名" name="name" rules={[{ required: true, message: '请填写姓名' }]}><Input /></Form.Item>
            <Form.Item label="角色" name="roles" rules={[{ required: true, message: '至少选择一个角色' }]}>
              <Select mode="multiple" options={options(ROLE_LABEL)} />
            </Form.Item>
            <Form.Item label="在用" name="active" valuePropName="checked"><Switch /></Form.Item>
          </>
        }
      />
    </Space>
  );
}

export function AccountsPage() {
  const { can } = useAuth();
  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <div>
        <Typography.Title level={3} style={{ margin: 0 }}>平台账号</Typography.Title>
        <Typography.Text type="secondary">一期只接小红书；每个账号的每日发布上限用于排期提醒</Typography.Text>
      </div>
      <CrudTable<Account>
        entity="账号"
        listPath="/accounts"
        basePath="/accounts"
        canEdit={can('ADMIN')}
        initialValues={{ platform: 'XHS', audience: 'C', dailyPostCap: 2 }}
        toBody={(v) => ({ ...v, externalId: v.externalId || undefined })}
        columns={[
          { title: '平台', dataIndex: 'platform', render: (p: string) => PLATFORM_LABEL[p] ?? p },
          { title: '账号名称', dataIndex: 'name' },
          { title: '面向', dataIndex: 'audience', render: (a: string) => AUDIENCE_LABEL[a] ?? a },
          { title: '平台账号 ID', dataIndex: 'externalId', render: (s: string | null) => s ?? '—' },
          { title: '每日发布上限', dataIndex: 'dailyPostCap' },
        ]}
        form={
          <>
            <Form.Item label="平台" name="platform"><Select options={options(PLATFORM_LABEL)} /></Form.Item>
            <Form.Item label="账号名称" name="name" rules={[{ required: true, message: '请填写账号名称' }]}><Input /></Form.Item>
            <Form.Item label="面向客户" name="audience"><Select options={options(AUDIENCE_LABEL)} /></Form.Item>
            <Form.Item label="平台账号 ID（选填）" name="externalId"><Input placeholder="如小红书号" /></Form.Item>
            <Form.Item label="每日发布上限" name="dailyPostCap"><InputNumber min={1} max={20} /></Form.Item>
          </>
        }
      />
    </Space>
  );
}
