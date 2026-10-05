/**
 * 安装履历纯函数：履历段排序 / 当时归属解析 / 旧档案补录 / 两边对账。
 *
 * 口径（布设—计量对账的唯一事实来源）：
 * - 台站台数、台阵台数：按仪器「当前归属」（instrument.stationId）；
 * - 标定成果（次数、合格率等）：按标定日期当天仪器「当时归属」台站；
 * - 更换单（含未办完的待更换单）：按更换单登记日期当天「当时归属」台站；
 * - 台站汇总相加应与全局总数逐项相等（balanced），对不上时 issues 给出明细。
 */
import type { Instrument } from '@/types/instrument';
import type { Calibration } from '@/types/calibration';
import type { Replace } from '@/types/replace';
import type { SeisStation } from '@/types/station';
import type { InstallationRecord, InstallationReason } from '@/types/installation';

/** 履历按开始日期升序（同日按 createdAt），当前在用段（endDate=null）排在最后 */
export function sortInstallations(records: InstallationRecord[]): InstallationRecord[] {
  return [...records].sort((a, b) => {
    const dateCmp = a.startDate.localeCompare(b.startDate);
    if (dateCmp !== 0) return dateCmp;
    if (a.endDate === null && b.endDate !== null) return 1;
    if (a.endDate !== null && b.endDate === null) return -1;
    return a.createdAt - b.createdAt;
  });
}

/** 仪器 id → 该仪器的履历段（按时间升序） */
export function groupInstallationsByInstrument(
  records: InstallationRecord[]
): Map<string, InstallationRecord[]> {
  const map = new Map<string, InstallationRecord[]>();
  records.forEach((record) => {
    const list = map.get(record.instrumentId) ?? [];
    list.push(record);
    map.set(record.instrumentId, list);
  });
  map.forEach((list, key) => map.set(key, sortInstallations(list)));
  return map;
}

/** 取仪器当前在用履历段（endDate === null，取开始日期最新的一段） */
export function currentInstallation(
  records: InstallationRecord[] | undefined
): InstallationRecord | null {
  if (!records || records.length === 0) return null;
  const open = sortInstallations(records).filter((record) => record.endDate === null);
  return open.length > 0 ? open[open.length - 1] : null;
}

/**
 * 解析仪器在某一天的当时归属（台站 + 序列号）。
 * 命中区间 startDate ≤ date ≤ endDate 的履历段；endDate=null 的在用段从 startDate 起一直命中。
 * 无任何履历时兜底返回仪器当前归属，保证旧数据与异常快照也能对账。
 */
export function resolveAttributionAt(
  instrument: Instrument,
  grouped: Map<string, InstallationRecord[]>,
  date: string
): { stationId: string; serialNo: string; record: InstallationRecord | null } {
  const records = grouped.get(instrument.id) ?? [];
  const hit =
    records.find((record) => record.startDate <= date && (record.endDate === null || date <= record.endDate)) ??
    null;
  return {
    stationId: hit?.stationId ?? instrument.stationId,
    serialNo: hit?.serialNo ?? instrument.serialNo,
    record: hit,
  };
}

/** 标定记录在标定当天的当时归属 */
export function calibrationStationAt(
  calibration: Calibration,
  instrument: Instrument | null | undefined,
  grouped: Map<string, InstallationRecord[]>
): { stationId: string; serialNo: string } {
  if (!instrument) {
    return { stationId: '', serialNo: '' };
  }
  const hit = resolveAttributionAt(instrument, grouped, calibration.date);
  return { stationId: hit.stationId, serialNo: hit.serialNo };
}

/** 更换单在登记当天的当时归属 */
export function replaceStationAt(
  replace: Replace,
  instrument: Instrument | null | undefined,
  grouped: Map<string, InstallationRecord[]>
): { stationId: string; serialNo: string } {
  if (!instrument) {
    return { stationId: '', serialNo: '' };
  }
  const hit = resolveAttributionAt(instrument, grouped, replace.date);
  return { stationId: hit.stationId, serialNo: hit.serialNo };
}

/* ------------------------------ 旧档案补录 ------------------------------ */

export interface BackfillOptions {
  /** 履历 id 生成（默认确定性 id，便于快照反复读回时幂等） */
  idFactory?: (instrumentId: string) => string;
  now?: number;
  reason?: InstallationReason;
}

/**
 * 按现有仪器档案为「完全没有履历」的仪器补一条履历：
 * 以当前台站 / 当前序列号 / 仪器安装日期开一段当前在用段。
 * 已存在履历（哪怕只有已关闭段）的仪器不动，避免覆盖真实历史。
 */
export function backfillInstallationsFor(
  instruments: Instrument[],
  existing: InstallationRecord[],
  options: BackfillOptions = {}
): InstallationRecord[] {
  const now = options.now ?? Date.now();
  const reason: InstallationReason = options.reason ?? '历史档案补录';
  const idFactory = options.idFactory ?? ((instrumentId: string) => `inst_bf_${instrumentId}`);
  const known = new Set(existing.map((record) => record.instrumentId));
  const additions: InstallationRecord[] = instruments
    .filter((instrument) => !known.has(instrument.id))
    .map((instrument) => ({
      id: idFactory(instrument.id),
      instrumentId: instrument.id,
      stationId: instrument.stationId,
      serialNo: instrument.serialNo,
      startDate: instrument.installDate,
      endDate: null,
      reason,
      operator: '',
      remark: '旧档案升级时按当前台站与序列号补录',
      createdAt: now,
      updatedAt: now,
    }));
  return [...existing, ...additions];
}

/**
 * 计算关闭旧段 / 开启新段所需的履历写入对（供 slice 在事务内调用）。
 * - stationId 变化（改点）或 serialNo 变化（换序列号）时生效；
 * - 旧段在 startDate 前一日关闭；无旧段时只开新段；
 * - 两者都没变时返回 null（不产生履历）。
 */
export function buildSegmentTurn(
  records: InstallationRecord[],
  input: {
    instrumentId: string;
    nextStationId: string;
    nextSerialNo: string;
    startDate: string;
    reason: InstallationReason;
    operator: string;
    remark: string;
    idFactory?: () => string;
    now?: number;
  }
): { closes: InstallationRecord[]; opens: InstallationRecord[] } | null {
  const now = input.now ?? Date.now();
  const sorted = sortInstallations(records);
  const current = sorted.length > 0 ? sorted[sorted.length - 1] : null;
  const stationChanged = !current || current.stationId !== input.nextStationId;
  const serialChanged = !current || current.serialNo !== input.nextSerialNo;
  if (!stationChanged && !serialChanged) return null;

  const closes: InstallationRecord[] = [];
  if (current && current.endDate === null) {
    const previousDay = shiftDate(input.startDate, -1);
    const endDate = previousDay >= current.startDate ? previousDay : current.startDate;
    closes.push({ ...current, endDate, updatedAt: now });
  }

  const opens: InstallationRecord[] = [
    {
      id: input.idFactory ? input.idFactory() : `inst_${now}_${Math.random().toString(36).slice(2, 8)}`,
      instrumentId: input.instrumentId,
      stationId: input.nextStationId,
      serialNo: input.nextSerialNo,
      startDate: input.startDate,
      endDate: null,
      reason: input.reason,
      operator: input.operator,
      remark: input.remark,
      createdAt: now,
      updatedAt: now,
    },
  ];
  return { closes, opens };
}

/** 日期（YYYY-MM-DD）前后平移 n 天 */
export function shiftDate(date: string, deltaDays: number): string {
  const time = Date.parse(`${date}T00:00:00`);
  if (!Number.isFinite(time)) return date;
  return new Date(time + deltaDays * 86400000).toISOString().slice(0, 10);
}

/* ------------------------------ 两边对账 ------------------------------ */

export interface StationReconcileRow {
  stationId: string;
  stationCode: string;
  arrayId: string;
  /** 当前归属台数（仪器当前 stationId） */
  instrumentCount: number;
  /** 按标定日期当时归属计入的标定次数 */
  calibrationAtTimeCount: number;
  /** 其中不合格次数（当时归属口径） */
  unqualifiedAtTimeCount: number;
  /** 若按当前归属硬算会得到的标定次数（仅用于对账提示） */
  calibrationCurrentCount: number;
  /** 按更换单登记日期当时归属计入的更换单数 */
  replaceAtTimeCount: number;
  /** 待更换 / 已更换（未办完）的更换单数（当时归属口径） */
  pendingReplaceAtTimeCount: number;
  /** 当前挂在本站但标定/更换算在原台站的仪器台数（改过点的仪器） */
  relocatedInCount: number;
  /** 曾在本站、现已改走的仪器台数（其历史标定仍算本站） */
  relocatedOutCount: number;
}

export interface ReconcileResult {
  rows: StationReconcileRow[];
  totals: {
    stations: number;
    instruments: number;
    calibrations: number;
    unqualified: number;
    replaces: number;
    pendingReplaces: number;
  };
  /** 台站汇总与全局总数是否逐项一致 */
  balanced: boolean;
  issues: string[];
}

export interface ReconcileInput {
  stations: SeisStation[];
  instruments: Instrument[];
  calibrations: Calibration[];
  replaces: Replace[];
  installations: InstallationRecord[];
}

/**
 * 布设—计量对账：
 * 台站台数按当前归属；标定成果与更换单按当时归属；逐项核对台站合计 == 全局总数。
 */
export function buildReconciliation(input: ReconcileInput): ReconcileResult {
  const grouped = groupInstallationsByInstrument(input.installations);
  const instrumentById = new Map(input.instruments.map((instrument) => [instrument.id, instrument]));

  const rowMap = new Map<string, StationReconcileRow>();
  input.stations.forEach((station) => {
    rowMap.set(station.id, {
      stationId: station.id,
      stationCode: station.code,
      arrayId: station.arrayId,
      instrumentCount: 0,
      calibrationAtTimeCount: 0,
      unqualifiedAtTimeCount: 0,
      calibrationCurrentCount: 0,
      replaceAtTimeCount: 0,
      pendingReplaceAtTimeCount: 0,
      relocatedInCount: 0,
      relocatedOutCount: 0,
    });
  });

  const bump = (stationId: string, apply: (row: StationReconcileRow) => void): void => {
    const row = rowMap.get(stationId);
    if (row) apply(row);
  };

  // 当前归属：台站台数 + 改入/改出统计
  input.instruments.forEach((instrument) => {
    bump(instrument.stationId, (row) => {
      row.instrumentCount += 1;
      const records = grouped.get(instrument.id) ?? [];
      // 当前台站之前还在别的台站装过 → 改入
      if (records.some((record) => record.stationId !== instrument.stationId)) {
        row.relocatedInCount += 1;
      }
    });
    // 曾在某台站装过、现已不在该台站 → 该台站的改出
    const former = new Set(
      (grouped.get(instrument.id) ?? [])
        .filter((record) => record.stationId !== instrument.stationId)
        .map((record) => record.stationId)
    );
    former.forEach((stationId) =>
      bump(stationId, (row) => {
        row.relocatedOutCount += 1;
      })
    );
  });

  // 标定成果：按标定当天当时归属；另算一份当前归属口径仅供差异提示
  let calibrated = 0;
  let unqualified = 0;
  input.calibrations.forEach((calibration) => {
    calibrated += 1;
    if (calibration.responseVerdict === '不合格') unqualified += 1;
    const instrument = instrumentById.get(calibration.instrumentId);
    if (!instrument) return;
    const atTime = calibrationStationAt(calibration, instrument, grouped);
    bump(atTime.stationId, (row) => {
      row.calibrationAtTimeCount += 1;
      if (calibration.responseVerdict === '不合格') row.unqualifiedAtTimeCount += 1;
    });
    bump(instrument.stationId, (row) => {
      row.calibrationCurrentCount += 1;
    });
  });

  // 更换单（含未办完）：按登记当天当时归属
  let replaced = 0;
  let pendingReplaces = 0;
  input.replaces.forEach((replace) => {
    replaced += 1;
    if (replace.state !== '已复核') pendingReplaces += 1;
    const instrument = instrumentById.get(replace.instrumentId);
    if (!instrument) return;
    const atTime = replaceStationAt(replace, instrument, grouped);
    bump(atTime.stationId, (row) => {
      row.replaceAtTimeCount += 1;
      if (replace.state !== '已复核') row.pendingReplaceAtTimeCount += 1;
    });
  });

  const rows = [...rowMap.values()];
  const totals = {
    stations: input.stations.length,
    instruments: input.instruments.length,
    calibrations: calibrated,
    unqualified,
    replaces: replaced,
    pendingReplaces,
  };

  const issues: string[] = [];
  const sum = (pick: (row: StationReconcileRow) => number): number =>
    rows.reduce((acc, row) => acc + pick(row), 0);
  const sumInstruments = sum((row) => row.instrumentCount);
  const sumCalibrations = sum((row) => row.calibrationAtTimeCount);
  const sumUnqualified = sum((row) => row.unqualifiedAtTimeCount);
  const sumReplaces = sum((row) => row.replaceAtTimeCount);
  const sumPending = sum((row) => row.pendingReplaceAtTimeCount);

  if (sumInstruments !== totals.instruments) {
    issues.push(`仪器台数对不上：台站合计 ${sumInstruments} 台，仪器档案 ${totals.instruments} 台`);
  }
  if (sumCalibrations !== totals.calibrations) {
    issues.push(`标定次数对不上：台站合计 ${sumCalibrations} 次，标定记录 ${totals.calibrations} 次`);
  }
  if (sumUnqualified !== totals.unqualified) {
    issues.push(`不合格标定对不上：台站合计 ${sumUnqualified} 次，标定记录 ${totals.unqualified} 次`);
  }
  if (sumReplaces !== totals.replaces) {
    issues.push(`更换单对不上：台站合计 ${sumReplaces} 条，更换记录 ${totals.replaces} 条`);
  }
  if (sumPending !== totals.pendingReplaces) {
    issues.push(`未办完更换单对不上：台站合计 ${sumPending} 条，更换记录 ${totals.pendingReplaces} 条`);
  }
  // 有标定挂在仪器上、但其当时台站已查不到（台站被删等），会体现在差额里
  input.calibrations.forEach((calibration) => {
    const instrument = instrumentById.get(calibration.instrumentId);
    if (!instrument) {
      issues.push(`标定 ${calibration.id} 找不到对应仪器，未计入任何台站`);
      return;
    }
    const atTime = calibrationStationAt(calibration, instrument, grouped);
    if (!rowMap.has(atTime.stationId)) {
      issues.push(`标定 ${calibration.id} 的当时台站「${atTime.stationId}」已不存在`);
    }
  });

  return { rows, totals, balanced: issues.length === 0, issues };
}
