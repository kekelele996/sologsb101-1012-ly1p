/**
 * 模块 2：/stations/:id/instruments 台站仪器登记与安装位置维护
 * 序列号唯一性校验；深链访问时台阵不存在给出友好空态。
 * 复用 <StatBadge>、<QualifyTag>。
 */
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  App as AntdApp,
  Alert,
  Breadcrumb,
  Button,
  Card,
  Col,
  DatePicker,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Row,
  Select,
  Skeleton,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd';
import {
  DeleteOutlined,
  EditOutlined,
  HistoryOutlined,
  PlusOutlined,
  SwapOutlined,
  SyncOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import FilterBar from '@/components/common/FilterBar';
import type { FilterModel } from '@/types/filter';
import StatBadge from '@/components/common/StatBadge';
import QualifyTag from '@/components/common/QualifyTag';
import EmptyPanel from '@/components/common/EmptyPanel';
import RouteMissingPanel from '@/components/common/RouteMissingPanel';
import InstallationHistoryDrawer from '@/components/common/InstallationHistoryDrawer';
import { ROUTES } from '@/router';
import { useAppDispatch, useAppSelector } from '@/stores/store';
import {
  createStation,
  patchStationFilter,
  recomputeAperture,
  removeStation,
  resetStationFilter,
  selectArrayById,
  selectArrayReady,
  selectArrays,
  selectStationFilter,
  selectStationsOfArray,
  updateStation,
} from '@/stores/arraySlice';
import {
  bulkSetInstrumentState,
  createInstrument,
  patchDraft,
  relocateInstrument,
  removeInstrument,
  resetDraft,
  selectInstallations,
  selectInstruments,
  selectInstrumentsOfStation,
  updateInstrument,
} from '@/stores/instrumentSlice';
import { selectCalibrations, selectReplaces } from '@/stores/calibrationSlice';
import { BEDROCK_TYPES, validateLatLng, type BedrockType, type SeisStation } from '@/types/station';
import {
  COMMON_MODELS,
  INSTRUMENT_STATES,
  INSTRUMENT_TYPES,
  createEmptyInstrumentDraft,
  daysUntilDue,
  type Instrument,
  type InstrumentState,
  type InstrumentType,
} from '@/types/instrument';
import { formatLatLng, round } from '@/utils/geo';
import { initDatabase } from '@/utils/db';
import {
  buildReconciliation,
  calibrationStationAt,
  groupInstallationsByInstrument,
  replaceStationAt,
} from '@/utils/installation';

interface StationFormValues {
  code: string;
  lat: number;
  lng: number;
  elevM: number;
  bedrock: BedrockType;
  siteNote: string;
}

interface InstrumentFormValues {
  type: InstrumentType;
  model: string;
  serialNo: string;
  installDate: dayjs.Dayjs | null;
  state: InstrumentState;
  remark: string;
}

interface RelocateFormValues {
  stationId: string;
  serialNo: string;
  startDate: dayjs.Dayjs | null;
  operator: string;
  remark: string;
}

/** 台站行统计：当前归属仪器台数、当时归属标定数、不合格数与超期台数 */
interface StationRow {
  station: SeisStation;
  instruments: Instrument[];
  calibrationCount: number;
  unqualified: number;
  overdue: number;
  worstVerdict: string;
  replaceCount: number;
  pendingReplace: number;
}

export default function StationInstruments() {
  const { id: arrayId = '' } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const dispatch = useAppDispatch();
  const { message } = AntdApp.useApp();

  const arrays = useAppSelector(selectArrays);
  const ready = useAppSelector(selectArrayReady);
  const array = useAppSelector((state) => selectArrayById(state, arrayId));
  const stations = useAppSelector((state) => selectStationsOfArray(state, arrayId));
  const stationFilter = useAppSelector(selectStationFilter);
  const allInstruments = useAppSelector(selectInstruments);
  const installations = useAppSelector(selectInstallations);
  const calibrations = useAppSelector(selectCalibrations);
  const replaces = useAppSelector(selectReplaces);

  const [stationModalOpen, setStationModalOpen] = useState(false);
  const [editingStationId, setEditingStationId] = useState<string | null>(null);
  const [instrumentModalOpen, setInstrumentModalOpen] = useState(false);
  const [editingInstrumentId, setEditingInstrumentId] = useState<string | null>(null);
  const [activeStationId, setActiveStationId] = useState<string | null>(null);
  const [relocateModalOpen, setRelocateModalOpen] = useState(false);
  const [relocatingInstrument, setRelocatingInstrument] = useState<Instrument | null>(null);
  const [historyInstrumentId, setHistoryInstrumentId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [stationForm] = Form.useForm<StationFormValues>();
  const [instrumentForm] = Form.useForm<InstrumentFormValues>();
  const [relocateForm] = Form.useForm<RelocateFormValues>();

  useEffect(() => {
    if (arrays.length === 0) void initDatabase();
  }, [arrays.length]);

  const activeStation = useMemo(
    () => stations.find((station) => station.id === activeStationId) ?? null,
    [activeStationId, stations]
  );

  const activeInstruments = useAppSelector((state) =>
    selectInstrumentsOfStation(state, activeStationId)
  );

  /**
   * 台站行：仪器台数按「当前归属」（instrument.stationId）；
   * 标定次数 / 不合格数按标定当天的「当时归属」台站（改过点的仪器，改点前成果留在原台站）；
   * 更换单（含未办完）按更换单登记当天当时归属留在原台站。
   */
  const rows = useMemo<StationRow[]>(() => {
    const grouped = groupInstallationsByInstrument(installations);
    const instrumentById = new Map(allInstruments.map((instrument) => [instrument.id, instrument]));
    return stations
      .filter((station) => {
        const keyword = stationFilter.keyword.trim();
        if (keyword.length > 0 && !`${station.code}${station.bedrock}${station.siteNote}`.includes(keyword)) {
          return false;
        }
        if (stationFilter.bedrocks.length > 0 && !stationFilter.bedrocks.includes(station.bedrock)) return false;
        if (stationFilter.minElevM !== null && station.elevM < stationFilter.minElevM) return false;
        const count = allInstruments.filter((instrument) => instrument.stationId === station.id).length;
        if (stationFilter.onlyEmpty && count > 0) return false;
        return true;
      })
      .map((station) => {
        const stationInstruments = allInstruments.filter(
          (instrument) => instrument.stationId === station.id
        );
        // 标定成果按当时归属：标定当天仪器所在台站
        const stationCalibrations = calibrations.filter((calibration) => {
          const instrument = instrumentById.get(calibration.instrumentId);
          if (!instrument) return false;
          return calibrationStationAt(calibration, instrument, grouped).stationId === station.id;
        });
        // 更换单（含未办完）按登记当天当时归属
        const stationReplaces = replaces.filter((replace) => {
          const instrument = instrumentById.get(replace.instrumentId);
          if (!instrument) return false;
          return replaceStationAt(replace, instrument, grouped).stationId === station.id;
        });
        const unqualified = stationCalibrations.filter(
          (calibration) => calibration.responseVerdict === '不合格'
        ).length;
        // 超期只评价当前挂在本站的仪器
        const overdue = stationInstruments.filter((instrument) => {
          const own = calibrations
            .filter((calibration) => calibration.instrumentId === instrument.id)
            .sort((a, b) => b.date.localeCompare(a.date));
          const last = own.length > 0 ? own[0].date : instrument.installDate;
          return daysUntilDue(last, instrument.installDate) < 0;
        }).length;
        return {
          station,
          instruments: stationInstruments,
          calibrationCount: stationCalibrations.length,
          unqualified,
          overdue,
          worstVerdict: unqualified > 0 ? '不合格' : stationCalibrations.length > 0 ? '合格' : '待判定',
          replaceCount: stationReplaces.length,
          pendingReplace: stationReplaces.filter((replace) => replace.state !== '已复核').length,
        };
      });
  }, [allInstruments, calibrations, installations, replaces, stationFilter, stations]);

  /** 布设（当前归属）— 计量（当时归属）对账 */
  const reconciliation = useMemo(
    () =>
      buildReconciliation({
        stations,
        instruments: allInstruments,
        calibrations,
        replaces,
        installations,
      }),
    [allInstruments, calibrations, installations, replaces, stations]
  );
  const arrayReconcile = useMemo(
    () => reconciliation.rows.filter((row) => stations.some((station) => station.id === row.stationId)),
    [reconciliation.rows, stations]
  );
  const arrayTotals = useMemo(
    () => ({
      instruments: arrayReconcile.reduce((sum, row) => sum + row.instrumentCount, 0),
      calibrations: arrayReconcile.reduce((sum, row) => sum + row.calibrationAtTimeCount, 0),
      replaces: arrayReconcile.reduce((sum, row) => sum + row.replaceAtTimeCount, 0),
      pending: arrayReconcile.reduce((sum, row) => sum + row.pendingReplaceAtTimeCount, 0),
      relocatedIn: arrayReconcile.reduce((sum, row) => sum + row.relocatedInCount, 0),
      relocatedOut: arrayReconcile.reduce((sum, row) => sum + row.relocatedOutCount, 0),
    }),
    [arrayReconcile]
  );

  const totals = useMemo(
    () => ({
      stations: rows.length,
      instruments: rows.reduce((sum, row) => sum + row.instruments.length, 0),
      calibrations: rows.reduce((sum, row) => sum + row.calibrationCount, 0),
      unqualified: rows.reduce((sum, row) => sum + row.unqualified, 0),
      overdue: rows.reduce((sum, row) => sum + row.overdue, 0),
    }),
    [rows]
  );

  const stationFilterModel: FilterModel = {
    keyword: stationFilter.keyword,
    bedrocks: stationFilter.bedrocks,
    minElevM: stationFilter.minElevM,
  };

  const openStationCreate = () => {
    setEditingStationId(null);
    stationForm.setFieldsValue({
      code: `ST${String(stations.length + 1).padStart(2, '0')}`,
      lat: 30.8,
      lng: 103.5,
      elevM: 1000,
      bedrock: '花岗岩',
      siteNote: '',
    });
    setStationModalOpen(true);
  };

  const openStationEdit = (station: SeisStation) => {
    setEditingStationId(station.id);
    stationForm.setFieldsValue({
      code: station.code,
      lat: station.lat,
      lng: station.lng,
      elevM: station.elevM,
      bedrock: station.bedrock,
      siteNote: station.siteNote,
    });
    setStationModalOpen(true);
  };

  const submitStation = async () => {
    const values = await stationForm.validateFields();
    const errors = validateLatLng(Number(values.lat), Number(values.lng));
    if (errors.length > 0) {
      message.warning(`经纬度校验未通过：${errors.join('；')}`);
      return;
    }
    const duplicated = stations.some(
      (station) => station.code === values.code.trim() && station.id !== editingStationId
    );
    if (duplicated) {
      message.warning(`台站码「${values.code.trim()}」在本台阵已存在`);
      return;
    }
    setSubmitting(true);
    try {
      const payload = {
        arrayId,
        code: values.code.trim(),
        lat: Number(values.lat),
        lng: Number(values.lng),
        elevM: Number(values.elevM),
        bedrock: values.bedrock,
        siteNote: values.siteNote?.trim() ?? '',
      };
      if (editingStationId) {
        await dispatch(updateStation({ id: editingStationId, patch: payload })).unwrap();
        message.success('台站已更新');
      } else {
        await dispatch(createStation(payload)).unwrap();
        message.success(`台站 ${payload.code} 已新增（${formatLatLng(payload.lat, payload.lng)}）`);
      }
      setStationModalOpen(false);
    } finally {
      setSubmitting(false);
    }
  };

  const openInstrumentCreate = (station: SeisStation) => {
    setActiveStationId(station.id);
    setEditingInstrumentId(null);
    dispatch(resetDraft());
    const draft = { ...createEmptyInstrumentDraft(), stationId: station.id };
    dispatch(patchDraft(draft));
    instrumentForm.setFieldsValue({
      type: draft.type,
      model: COMMON_MODELS[draft.type][0] ?? '',
      serialNo: `${station.code}-${Date.now().toString(36).toUpperCase().slice(-4)}`,
      installDate: dayjs(),
      state: '在用',
      remark: '',
    });
    setInstrumentModalOpen(true);
  };

  const openInstrumentEdit = (station: SeisStation, instrument: Instrument) => {
    setActiveStationId(station.id);
    setEditingInstrumentId(instrument.id);
    instrumentForm.setFieldsValue({
      type: instrument.type,
      model: instrument.model,
      serialNo: instrument.serialNo,
      installDate: dayjs(instrument.installDate),
      state: instrument.state,
      remark: instrument.remark,
    });
    setInstrumentModalOpen(true);
  };

  const submitInstrument = async () => {
    if (!activeStationId) {
      message.warning('请先选择一个台站');
      return;
    }
    const values = await instrumentForm.validateFields();
    setSubmitting(true);
    try {
      const payload = {
        stationId: activeStationId,
        type: values.type,
        model: values.model.trim(),
        serialNo: values.serialNo.trim(),
        installDate: values.installDate ? values.installDate.format('YYYY-MM-DD') : dayjs().format('YYYY-MM-DD'),
        state: values.state,
        remark: values.remark?.trim() ?? '',
      };
      if (editingInstrumentId) {
        await dispatch(updateInstrument({ id: editingInstrumentId, patch: payload })).unwrap();
        message.success('仪器信息已更新');
      } else {
        await dispatch(createInstrument(payload)).unwrap();
        dispatch(patchDraft(payload));
        const dueInDays = daysUntilDue(null, payload.installDate);
        message.success(
          dueInDays >= 0
            ? `仪器已登记，距下次标定 ${dueInDays} 天`
            : `仪器已登记，安装日期距今已超过标定周期 ${Math.abs(dueInDays)} 天，请尽快安排标定`
        );
      }
      setInstrumentModalOpen(false);
    } catch (error) {
      message.error(typeof error === 'string' ? error : '仪器保存失败');
    } finally {
      setSubmitting(false);
    }
  };

  /** 改点：把仪器归到（本台阵内的）另一台站，可同时登记新序列号 */
  const openRelocate = (instrument: Instrument) => {
    setRelocatingInstrument(instrument);
    relocateForm.setFieldsValue({
      stationId: instrument.stationId,
      serialNo: instrument.serialNo,
      startDate: dayjs(),
      operator: '',
      remark: '',
    });
    setRelocateModalOpen(true);
  };

  const submitRelocate = async () => {
    if (!relocatingInstrument) return;
    const values = await relocateForm.validateFields();
    setSubmitting(true);
    try {
      const result = await dispatch(
        relocateInstrument({
          instrumentId: relocatingInstrument.id,
          stationId: values.stationId,
          serialNo: values.serialNo.trim(),
          startDate: values.startDate ? values.startDate.format('YYYY-MM-DD') : dayjs().format('YYYY-MM-DD'),
          operator: values.operator?.trim() ?? '',
          remark: values.remark?.trim() ?? '',
        })
      ).unwrap();
      message.success(
        result.stationChanged
          ? `已改点至新台站并归位；旧台站与旧序列号已封进履历，标定记录与更换单仍算原台站`
          : `序列号已更换并封档；标定记录与更换单仍算原台站`
      );
      setActiveStationId(values.stationId);
      setRelocateModalOpen(false);
    } catch (error) {
      message.error(typeof error === 'string' ? error : '改点失败');
    } finally {
      setSubmitting(false);
    }
  };

  const handleBulkPending = async () => {    const ids = Array.from(new Set(allInstruments.map((instrument) => instrument.id)));
    const targetIds = ids.filter((id) =>
      rows.some((row) => row.instruments.some((instrument) => instrument.id === id))
    );
    if (targetIds.length === 0) {
      message.warning('当前筛选范围内没有可批量操作的仪器');
      return;
    }
    await dispatch(bulkSetInstrumentState({ ids: targetIds, state: '待标定' })).unwrap();
    message.success(`已将 ${targetIds.length} 台仪器状态置为待标定`);
  };

  if (!ready) {
    return <Skeleton active paragraph={{ rows: 6 }} />;
  }

  if (!array) {
    return (
      <RouteMissingPanel
        entityLabel="台阵"
        missingId={arrayId}
        fallbackPath={ROUTES.arrays}
        fallbackText="返回台阵台账"
        candidates={arrays.slice(0, 3).map((row) => ({
          id: row.id,
          label: `${row.name} 的台站仪器`,
          path: ROUTES.stations(row.id),
        }))}
      />
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div className="gb-brand-bar" />

      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
        <div>
          <Breadcrumb
            items={[
              { title: <a onClick={() => navigate(ROUTES.arrays)}>台阵台账</a> },
              { title: array.name },
              { title: '台站仪器' },
            ]}
          />
          <Typography.Title level={4} style={{ margin: '8px 0 4px', color: '#1e3a5f' }}>
            {array.name} · 台站仪器登记
          </Typography.Title>
          <p className="gb-hint">
            维护台站地理坐标与基岩类型并登记仪器；序列号全局唯一，登记后自动生成下一次标定待办（周期
            365 天）。仪器换台站点「改点」按新台站归位，旧台站与旧序列号封进安装履历，标定记录与更换单仍算原台站。
          </p>
        </div>
        <Space wrap>
          <Button
            icon={<SyncOutlined />}
            onClick={() =>
              void dispatch(recomputeAperture(array.id))
                .unwrap()
                .then((result) => message.success(`已按经纬度重算孔径：${result.apertureKm} km`))
            }
          >
            重算孔径
          </Button>
          <Button onClick={() => void handleBulkPending()}>批量置为待标定</Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={openStationCreate}>
            新增台站
          </Button>
        </Space>
      </div>

      <div className="gb-stats-row">
        <StatBadge label="台站数" value={totals.stations} suffix="个" tone="info" />
        <StatBadge label="仪器台数" value={totals.instruments} suffix="台" tone="primary" />
        <StatBadge label="累计标定" value={totals.calibrations} suffix="次" tone="default" />
        <StatBadge
          label="不合格标定"
          value={totals.unqualified}
          suffix="次"
          tone={totals.unqualified > 0 ? 'danger' : 'success'}
        />
        <StatBadge
          label="超期未标定"
          value={totals.overdue}
          suffix="台"
          tone={totals.overdue > 0 ? 'warning' : 'success'}
        />
      </div>

      <FilterBar
        modelValue={stationFilterModel}
        selects={[
          {
            key: 'bedrocks',
            label: '基岩类型',
            options: BEDROCK_TYPES.map((bedrock) => ({ label: bedrock, value: bedrock })),
          },
        ]}
        numberRanges={[{ key: 'minElevM', label: '高程不低于', placeholder: '不限', suffix: 'm' }]}
        hasSwitch
        switchLabel="仅看未安装仪器的台站"
        switchValue={stationFilter.onlyEmpty}
        keywordPlaceholder="搜索台站码 / 基岩 / 场地备注"
        onChange={(next, switchValue) => {
          dispatch(
            patchStationFilter({
              keyword: next.keyword,
              bedrocks: ((next.bedrocks as string[]) ?? []) as BedrockType[],
              minElevM: (next.minElevM as number | null) ?? null,
              onlyEmpty: switchValue,
            })
          );
        }}
        onReset={() => dispatch(resetStationFilter())}
      />

      <Alert
        type={reconciliation.balanced ? 'success' : 'error'}
        showIcon
        message={
          reconciliation.balanced
            ? `布设—计量对账一致：本台阵当前归属 ${arrayTotals.instruments} 台；标定成果按当时归属合计 ${arrayTotals.calibrations} 次；更换单 ${arrayTotals.replaces} 条（未办完 ${arrayTotals.pending} 条），台站合计与档案总数对得上`
            : '布设—计量对账出现差异'
        }
        description={
          reconciliation.balanced
            ? arrayTotals.relocatedIn + arrayTotals.relocatedOut > 0
              ? `本台阵改入 ${arrayTotals.relocatedIn} 台、改出 ${arrayTotals.relocatedOut} 台（历史标定/更换单留原台站，不随仪器移动）。`
              : '本台阵暂无改点仪器。'
            : reconciliation.issues.join('；')
        }
      />

      {rows.length === 0 ? (
        <EmptyPanel
          title={stations.length === 0 ? '该台阵还没有台站' : '没有符合条件的台站'}
          description="新增台站并录入经纬度、高程与基岩类型后，即可登记仪器并录入标定结果。"
          actionText="新增台站"
          secondaryText="重置筛选"
          onAction={openStationCreate}
          onSecondary={() => dispatch(resetStationFilter())}
        />
      ) : (
        <Table
          rowKey={(row) => row.station.id}
          className="gb-table-compact"
          dataSource={rows}
          pagination={false}
          columns={[
            {
              title: '台站码',
              width: 110,
              render: (_: unknown, row: StationRow) => <span className="gb-mono">{row.station.code}</span>,
            },
            {
              title: '经纬度',
              width: 200,
              render: (_: unknown, row: StationRow) => (
                <div>
                  <div className="gb-mono">
                    {row.station.lat.toFixed(4)}, {row.station.lng.toFixed(4)}
                  </div>
                  <div className="gb-hint gb-mono">{formatLatLng(row.station.lat, row.station.lng)}</div>
                </div>
              ),
            },
            {
              title: '高程 (m)',
              width: 100,
              align: 'right',
              render: (_: unknown, row: StationRow) => <span className="gb-mono">{row.station.elevM}</span>,
            },
            {
              title: '基岩',
              width: 110,
              render: (_: unknown, row: StationRow) => <Tag>{row.station.bedrock}</Tag>,
            },
            {
              title: '仪器台数',
              width: 110,
              align: 'center',
              render: (_: unknown, row: StationRow) => (
                <Button type="link" size="small" onClick={() => setActiveStationId(row.station.id)}>
                  {row.instruments.length} 台
                </Button>
              ),
            },
            {
              title: '标定 / 不合格（当时归属）',
              width: 180,
              align: 'right',
              render: (_: unknown, row: StationRow) => (
                <span className="gb-mono">
                  {row.calibrationCount} /{' '}
                  <span className={row.unqualified > 0 ? 'gb-danger' : ''}>{row.unqualified}</span>
                  {row.pendingReplace > 0 ? (
                    <div className="gb-hint">未办完更换 {row.pendingReplace} 条</div>
                  ) : null}
                </span>
              ),
            },
            {
              title: '标定提醒',
              width: 130,
              render: (_: unknown, row: StationRow) =>
                row.overdue > 0 ? <Tag color="red">超期 {row.overdue} 台</Tag> : <Tag color="green">按期</Tag>,
            },
            {
              title: '综合结论',
              width: 120,
              render: (_: unknown, row: StationRow) => <QualifyTag verdict={row.worstVerdict as never} size="small" />,
            },
            { title: '场地备注', dataIndex: ['station', 'siteNote'], ellipsis: true },
            {
              title: '操作',
              width: 250,
              render: (_: unknown, row: StationRow) => (
                <Space size={6}>
                  <Button size="small" type="primary" onClick={() => openInstrumentCreate(row.station)}>
                    登记仪器
                  </Button>
                  <Button size="small" icon={<EditOutlined />} onClick={() => openStationEdit(row.station)}>
                    编辑
                  </Button>
                  <Popconfirm
                    title="删除台站"
                    description={`将同时删除其仪器、标定与更换记录，确认删除「${row.station.code}」？`}
                    okText="删除"
                    cancelText="取消"
                    okButtonProps={{ danger: true }}
                    onConfirm={() =>
                      void dispatch(removeStation(row.station.id))
                        .unwrap()
                        .then(() => message.success('台站及其下级数据已删除'))
                    }
                  >
                    <Button size="small" danger icon={<DeleteOutlined />}>
                      删除
                    </Button>
                  </Popconfirm>
                </Space>
              ),
            },
          ]}
        />
      )}

      {activeStation ? (
        <Card
          className="gb-panel"
          size="small"
          title={`${activeStation.code} · 仪器清单（${activeInstruments.length} 台）`}
          extra={
            <Button type="primary" size="small" icon={<PlusOutlined />} onClick={() => openInstrumentCreate(activeStation)}>
              登记仪器
            </Button>
          }
        >
          {activeInstruments.length === 0 ? (
            <EmptyPanel
              title="该台站还没有仪器"
              description="登记宽频带 / 短周期 / 强震仪器，序列号需全局唯一。"
              actionText="登记仪器"
              onAction={() => openInstrumentCreate(activeStation)}
              compact
            />
          ) : (
            <Table
              rowKey="id"
              size="small"
              className="gb-table-compact"
              dataSource={activeInstruments}
              pagination={false}
              columns={[
                { title: '类型', dataIndex: 'type', width: 100, render: (value: string) => <Tag>{value}</Tag> },
                { title: '型号', dataIndex: 'model', width: 160 },
                {
                  title: '序列号',
                  dataIndex: 'serialNo',
                  width: 220,
                  render: (value: string) => <span className="gb-mono">{value}</span>,
                },
                { title: '安装日期', dataIndex: 'installDate', width: 120, className: 'gb-mono' },
                {
                  title: '安装履历',
                  width: 110,
                  align: 'center',
                  render: (_: unknown, instrument: Instrument) => {
                    const segments = installations.filter((record) => record.instrumentId === instrument.id);
                    const stationCount = new Set(segments.map((record) => record.stationId)).size;
                    const moved = stationCount > 1;
                    return (
                      <Button
                        size="small"
                        type={moved ? 'primary' : 'default'}
                        ghost={moved}
                        icon={<HistoryOutlined />}
                        onClick={() => setHistoryInstrumentId(instrument.id)}
                      >
                        {segments.length} 段{moved ? ` · ${stationCount} 站` : ''}
                      </Button>
                    );
                  },
                },
                {
                  title: '状态',
                  dataIndex: 'state',
                  width: 100,
                  render: (value: string) => (
                    <Tag color={value === '在用' ? 'green' : value === '待标定' ? 'orange' : 'default'}>{value}</Tag>
                  ),
                },
                {
                  title: '标定次数',
                  width: 100,
                  align: 'right',
                  render: (_: unknown, instrument: Instrument) => (
                    <span className="gb-mono">
                      {calibrations.filter((row) => row.instrumentId === instrument.id).length}
                    </span>
                  ),
                },
                {
                  title: '最近结论',
                  width: 180,
                  render: (_: unknown, instrument: Instrument) => {
                    const own = calibrations
                      .filter((row) => row.instrumentId === instrument.id)
                      .sort((a, b) => b.date.localeCompare(a.date));
                    const latest = own[0];
                    if (!latest) {
                      return <span className="gb-hint">尚未标定</span>;
                    }
                    return (
                      <QualifyTag
                        verdict={latest.responseVerdict}
                        sensitivity={round(latest.sensitivity, 2)}
                        size="small"
                      />
                    );
                  },
                },
                {
                  title: '距下次标定',
                  width: 130,
                  render: (_: unknown, instrument: Instrument) => {
                    const own = calibrations
                      .filter((row) => row.instrumentId === instrument.id)
                      .sort((a, b) => b.date.localeCompare(a.date));
                    const last = own.length > 0 ? own[0].date : instrument.installDate;
                    const days = daysUntilDue(last, instrument.installDate);
                    return (
                      <span className={days < 0 ? 'gb-danger gb-mono' : 'gb-mono'}>
                        {days < 0 ? `超期 ${Math.abs(days)} 天` : `剩余 ${days} 天`}
                      </span>
                    );
                  },
                },
                {
                  title: '操作',
                  width: 280,
                  render: (_: unknown, instrument: Instrument) => (
                    <Space size={6} wrap>
                      <Button size="small" type="primary" ghost icon={<SwapOutlined />} onClick={() => openRelocate(instrument)}>
                        改点
                      </Button>
                      <Button size="small" icon={<HistoryOutlined />} onClick={() => setHistoryInstrumentId(instrument.id)}>
                        履历
                      </Button>
                      <Button size="small" onClick={() => openInstrumentEdit(activeStation, instrument)}>
                        编辑
                      </Button>
                      <Popconfirm
                        title="删除仪器"
                        description={`将同时删除其标定、更换记录与安装履历，确认删除「${instrument.model}」？`}
                        okText="删除"
                        cancelText="取消"
                        okButtonProps={{ danger: true }}
                        onConfirm={() =>
                          void dispatch(removeInstrument(instrument.id))
                            .unwrap()
                            .then(() => message.success('仪器及其记录已删除'))
                        }
                      >
                        <Button size="small" danger>
                          删除
                        </Button>
                      </Popconfirm>
                    </Space>
                  ),
                },
              ]}
            />
          )}
        </Card>
      ) : (
        <Card className="gb-panel" size="small">
          <EmptyPanel
            title="请选择台站查看仪器"
            description="在上表点击任一「仪器台数」或「登记仪器」按钮，即可查看与维护该台站的仪器。"
            compact
          />
        </Card>
      )}

      <p className="gb-hint">
        安装履历口径：仪器「改点」后按新台站归位，旧台站与旧序列号封进履历；标定记录与更换单不跟随移动，
        仍按当时归属算在原台站名下——台站台数看当前归属，标定成果与更换单看当时归属，两边对账一致。
        当仪器标定超期或结论不合格时，可到「合格评定与更换」页登记更换并跟踪到复核闭环；
        更换完成后自动把新序列号回写到仪器档案并记一段履历。当前共 {replaces.length} 条更换记录。
      </p>

      <Modal
        open={stationModalOpen}
        title={editingStationId ? '编辑台站' : '新增台站'}
        onCancel={() => setStationModalOpen(false)}
        onOk={() => void submitStation()}
        confirmLoading={submitting}
        okText={editingStationId ? '保存修改' : '新增台站'}
        destroyOnClose
      >
        <Form form={stationForm} layout="vertical" preserve={false}>
          <Form.Item name="code" label="台站码" rules={[{ required: true, message: '请填写台站码' }]}>
            <Input placeholder="如：LTX01" maxLength={20} />
          </Form.Item>
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item name="lat" label="纬度" rules={[{ required: true, message: '请填写纬度' }]}>
                <InputNumber min={-90} max={90} step={0.0001} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="lng" label="经度" rules={[{ required: true, message: '请填写经度' }]}>
                <InputNumber min={-180} max={180} step={0.0001} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item name="elevM" label="高程 (m)" rules={[{ required: true }]}>
                <InputNumber min={-500} max={9000} step={1} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="bedrock" label="基岩类型" rules={[{ required: true }]}>
                <Select options={BEDROCK_TYPES.map((bedrock) => ({ label: bedrock, value: bedrock }))} />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item name="siteNote" label="场地备注">
            <Input.TextArea rows={2} maxLength={80} placeholder="如：基岩出露，噪声本底低" />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        open={instrumentModalOpen}
        title={`${editingInstrumentId ? '编辑' : '登记'}仪器 · ${activeStation?.code ?? ''}`}
        onCancel={() => setInstrumentModalOpen(false)}
        onOk={() => void submitInstrument()}
        confirmLoading={submitting}
        okText={editingInstrumentId ? '保存修改' : '登记并生成待办'}
        destroyOnClose
      >
        <Form form={instrumentForm} layout="vertical" preserve={false}>
          <Form.Item name="type" label="仪器类型" rules={[{ required: true }]}>
            <Select
              options={INSTRUMENT_TYPES.map((type) => ({ label: type, value: type }))}
              onChange={(value: InstrumentType) => {
                const models = COMMON_MODELS[value] ?? [];
                instrumentForm.setFieldValue('model', models[0] ?? '');
              }}
            />
          </Form.Item>
          <Form.Item name="model" label="型号" rules={[{ required: true, message: '请填写型号' }]}>
            <Input placeholder="如：CMG-3ESPC" maxLength={40} />
          </Form.Item>
          <Form.Item
            name="serialNo"
            label="序列号（全局唯一）"
            rules={[{ required: true, message: '请填写序列号' }]}
          >
            <Input placeholder="如：CMG-3E-20210418-01" maxLength={60} />
          </Form.Item>
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item name="installDate" label="安装日期" rules={[{ required: true }]}>
                <DatePicker style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="state" label="状态" rules={[{ required: true }]}>
                <Select options={INSTRUMENT_STATES.map((state) => ({ label: state, value: state }))} />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item name="remark" label="备注">
            <Input.TextArea rows={2} maxLength={80} placeholder="如：井下安装，深度 42 m" />
          </Form.Item>
          {editingInstrumentId ? (
            <p className="gb-hint">
              提示：在此修改序列号会按「更换序列号」封存旧序列号并新开一段履历；换台站请点「改点」。
            </p>
          ) : null}
        </Form>
      </Modal>

      <Modal
        open={relocateModalOpen}
        title={`改点（换台站）· ${relocatingInstrument?.model ?? ''}`}
        onCancel={() => setRelocateModalOpen(false)}
        onOk={() => void submitRelocate()}
        confirmLoading={submitting}
        okText="按新台站归位并封履历"
        destroyOnClose
      >
        {relocatingInstrument ? (
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 12 }}
            message={`当前档案：${activeStation?.code ?? ''} · 序列号 ${relocatingInstrument.serialNo}`}
            description="改点后仪器按新台站归位，旧台站与旧序列号封进安装履历；该仪器的标定记录与未办完更换单不跟随移动，仍算在原台站名下。"
          />
        ) : null}
        <Form form={relocateForm} layout="vertical" preserve={false}>
          <p className="gb-hint">
            新归位台站限选当前台阵「{array.name}」内的台站；跨台阵调拨请先在目标台阵重新登记仪器。
          </p>
          <Form.Item name="stationId" label="新归位台站" rules={[{ required: true, message: '请选择台站' }]}>
            <Select
              showSearch
              optionFilterProp="label"
              options={stations.map((station) => ({
                label: `${station.code}（${station.bedrock}）`,
                value: station.id,
              }))}
            />
          </Form.Item>
          <Form.Item
            name="serialNo"
            label="改点后序列号（沿用旧序列号则保持不变）"
            rules={[{ required: true, message: '请填写序列号' }]}
          >
            <Input maxLength={60} placeholder="沿用旧序列号时无需修改" />
          </Form.Item>
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item name="startDate" label="改点日期" rules={[{ required: true }]}>
                <DatePicker style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="operator" label="操作人">
                <Input maxLength={20} placeholder="如：周渝" />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item name="remark" label="备注">
            <Input.TextArea rows={2} maxLength={100} placeholder="如：原台站井下环境改造，整机改点" />
          </Form.Item>
        </Form>
      </Modal>

      <InstallationHistoryDrawer
        open={historyInstrumentId !== null}
        instrumentId={historyInstrumentId}
        onClose={() => setHistoryInstrumentId(null)}
      />
    </div>
  );
}
