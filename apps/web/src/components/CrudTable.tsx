import { App, Button, Form, Modal, Popconfirm, Space, Table, type TableColumnsType } from 'antd';
import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api';

interface Props<T extends { id: string }> {
  /** 列表接口，如 /knowledge/faqs?category=售后 */
  listPath: string;
  /** 写接口前缀，如 /knowledge/faqs，编辑和删除会拼上 /:id */
  basePath: string;
  columns: TableColumnsType<T>;
  /** 表单项（Form.Item 列表） */
  form: React.ReactNode;
  canEdit: boolean;
  canDelete?: boolean;
  entity: string;
  /** 打开编辑框时把记录转成表单值 */
  toForm?: (row: T) => Record<string, unknown>;
  /** 提交前把表单值转成接口参数 */
  toBody?: (values: Record<string, unknown>) => unknown;
  initialValues?: Record<string, unknown>;
  extra?: React.ReactNode;
  /** 每行额外的操作按钮，reload 用于操作后刷新列表 */
  rowActions?: (row: T, reload: () => void) => React.ReactNode;
}

/** 通用的“列表 + 新增/编辑弹窗 + 删除”表格，后端校验错误会落到对应表单项上。 */
export function CrudTable<T extends { id: string }>(p: Props<T>) {
  const { message } = App.useApp();
  const [rows, setRows] = useState<T[]>([]);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState<T | 'new' | null>(null);
  const [initial, setInitial] = useState<Record<string, unknown>>({});
  const [saving, setSaving] = useState(false);
  const [form] = Form.useForm();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setRows(await api<T[]>(p.listPath));
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [p.listPath, message]);

  useEffect(() => {
    void load();
  }, [load]);

  const open = (row: T | 'new') => {
    // 弹窗关闭时会销毁表单，所以用 initialValues 而不是 setFieldsValue 回填
    setInitial(row === 'new' ? (p.initialValues ?? {}) : (p.toForm?.(row) ?? (row as Record<string, unknown>)));
    setEditing(row);
  };

  const save = async () => {
    const values = await form.validateFields();
    const body = p.toBody ? p.toBody(values) : values;
    setSaving(true);
    try {
      if (editing === 'new') await api(p.basePath, { method: 'POST', body });
      else await api(`${p.basePath}/${(editing as T).id}`, { method: 'PATCH', body });
      message.success('已保存');
      setEditing(null);
      void load();
    } catch (e) {
      if (e instanceof ApiError && e.errors?.length) {
        form.setFields(e.errors.map((x) => ({ name: x.field.split('.'), errors: [x.message] })));
      } else message.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const remove = async (row: T) => {
    try {
      await api(`${p.basePath}/${row.id}`, { method: 'DELETE' });
      message.success('已删除');
      void load();
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  const columns: TableColumnsType<T> = p.canEdit || p.rowActions
    ? [
        ...p.columns,
        {
          title: '操作',
          key: '_ops',
          render: (_, row) => (
            <Space size={4}>
              {p.rowActions?.(row, () => void load())}
              {p.canEdit && <Button type="link" size="small" onClick={() => open(row)}>编辑</Button>}
              {p.canEdit && p.canDelete !== false && (
                <Popconfirm title={`删除这条${p.entity}？`} onConfirm={() => remove(row)}>
                  <Button type="link" size="small" danger>删除</Button>
                </Popconfirm>
              )}
            </Space>
          ),
        },
      ]
    : p.columns;

  return (
    <>
      <Space style={{ marginBottom: 12, width: '100%', justifyContent: 'space-between' }} wrap>
        <Space wrap>{p.extra}</Space>
        {p.canEdit && <Button type="primary" onClick={() => open('new')}>新增{p.entity}</Button>}
      </Space>
      <Table<T> rowKey="id" size="middle" loading={loading} dataSource={rows} columns={columns} scroll={{ x: true }} />
      <Modal
        title={editing === 'new' ? `新增${p.entity}` : `编辑${p.entity}`}
        open={editing !== null}
        onOk={save}
        confirmLoading={saving}
        onCancel={() => setEditing(null)}
        destroyOnHidden
      >
        <Form form={form} layout="vertical" preserve={false} initialValues={initial}>
          {p.form}
        </Form>
      </Modal>
    </>
  );
}
