/**
 * <InstallationHistoryDrawer>：仪器安装履历抽屉。
 * 展示一台仪器逐段安装区间（台站 / 序列号 / 起止日期 / 原因），
 * 当前在用段高亮，已关闭段即「封进履历」的旧台站与旧序列号。
 * 被台站仪器页、标定记录台、更换提醒页复用。
 */
import { useMemo } from 'react';
import { Drawer, Empty, Table, Tag, Typography } from 'antd';
import { HistoryOutlined } from '@ant-design/icons';
import { useAppSelector } from '@/stores/store';
import { selectStations } from '@/stores/arraySlice';
import { selectInstallationsOfInstrument, selectInstrumentById } from '@/stores/instrumentSlice';
import type { InstallationRecord, InstallationReason } from '@/types/installation';

const REASON_COLOR: Record<InstallationReason, string> = {
  初次安装: 'blue',
  改点: 'gold',
  更换序列号: 'purple',
  历史档案补录: 'default',
};

interface Props {
  open: boolean;
  instrumentId: string | null;
  onClose: () => void;
}

export default function InstallationHistoryDrawer({ open, instrumentId, onClose }: Props) {
  const stations = useAppSelector(selectStations);
  const instrument = useAppSelector((state) => selectInstrumentById(state, instrumentId));
  const installations = useAppSelector((state) =>
    selectInstallationsOfInstrument(state, instrumentId)
  );

  const stationCode = useMemo(
    () => (stationId: string): string => stations.find((station) => station.id === stationId)?.code ?? '台站已删除',
    [stations]
  );

  const rows = useMemo(
    () => [...installations].sort((a, b) => b.startDate.localeCompare(a.startDate)),
    [installations]
  );

  return (
    <Drawer
      title={
        instrument ? (
          <span>
            <HistoryOutlined /> 安装履历 · {instrument.model}（当前序列号 {instrument.serialNo}）
          </span>
        ) : (
          '安装履历'
        )
      }
      open={open}
      onClose={onClose}
      width={720}
      destroyOnClose
    >
      <Typography.Paragraph type="secondary" style={{ fontSize: 13 }}>
        改点后仪器按新台站归位，旧台站与旧序列号封存在已关闭履历段；标定记录与更换单不跟随移动，
        始终按各段起止日期解析「当时归属」，留在原台站名下对账。
      </Typography.Paragraph>
      {rows.length === 0 ? (
        <Empty description="该仪器暂无安装履历" />
      ) : (
        <Table
          rowKey="id"
          size="small"
          className="gb-table-compact"
          dataSource={rows}
          pagination={false}
          rowClassName={(record: InstallationRecord) => (record.endDate === null ? 'gb-row-active' : '')}
          columns={[
            {
              title: '安装台站',
              width: 120,
              render: (_: unknown, record: InstallationRecord) => (
                <span className="gb-mono">
                  {stationCode(record.stationId)}
                  {record.endDate === null ? <Tag color="green" style={{ marginLeft: 6 }}>当前</Tag> : null}
                </span>
              ),
            },
            {
              title: '序列号',
              width: 200,
              render: (_: unknown, record: InstallationRecord) => (
                <span
                  className="gb-mono"
                  style={
                    instrument && record.serialNo !== instrument.serialNo
                      ? { color: '#8a94a6', textDecoration: 'line-through' }
                      : undefined
                  }
                >
                  {record.serialNo}
                </span>
              ),
            },
            {
              title: '安装区间',
              width: 200,
              className: 'gb-mono',
              render: (_: unknown, record: InstallationRecord) => (
                <span>
                  {record.startDate}
                  <br />
                  <span className="gb-hint">{record.endDate ? `至 ${record.endDate}` : '至今（在用）'}</span>
                </span>
              ),
            },
            {
              title: '原因',
              width: 110,
              render: (_: unknown, record: InstallationRecord) => (
                <Tag color={REASON_COLOR[record.reason]}>{record.reason}</Tag>
              ),
            },
            {
              title: '操作人 / 备注',
              render: (_: unknown, record: InstallationRecord) => (
                <span>
                  {record.operator || '—'}
                  {record.remark ? <div className="gb-hint">{record.remark}</div> : null}
                </span>
              ),
            },
          ]}
        />
      )}
    </Drawer>
  );
}
