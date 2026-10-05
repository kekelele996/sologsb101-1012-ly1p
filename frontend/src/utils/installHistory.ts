/**
 * 安装履历事务操作：在 Dexie 事务内完成「封存旧阶段 + 开启新阶段 + 回写仪器档案」。
 * 被仪器 slice（登记 / 改点）与标定 slice（更换完成回写序列号）复用，
 * 保证台站台数（当前归属）与标定成果（当时归属）两边对账一致。
 */
import { db, createId } from '@/utils/db';
import type { InstallHistory } from '@/types/installHistory';
import type { Instrument } from '@/types/instrument';

/** 为仪器构建首条履历（当前在任），不落库 */
export function buildInitialHistory(instrument: Instrument, now: number): InstallHistory {
  return {
    id: createId('ih'),
    instrumentId: instrument.id,
    stationId: instrument.stationId,
    serialNo: instrument.serialNo,
    startDate: instrument.installDate || new Date(now).toISOString().slice(0, 10),
    endDate: null,
    reason: '初始安装',
    createdAt: now,
    updatedAt: now,
  };
}

/** 为仪器开启一条新的在任履历（不负责封存旧履历） */
export async function openHistoryForInstrument(instrument: Instrument, now: number): Promise<InstallHistory> {
  const row = buildInitialHistory(instrument, now);
  await db.installHistories.put(row);
  return row;
}

/** 封存仪器当前在任履历（换点 / 换序列号时调用） */
export async function sealOpenHistory(instrumentId: string, endDate: string, now: number): Promise<void> {
  await db.installHistories
    .where('instrumentId')
    .equals(instrumentId)
    .filter((row) => row.endDate === null)
    .modify((row) => {
      row.endDate = endDate;
      row.updatedAt = now;
    });
}

/** 开启一条新的在任履历（仪器已改归新台站 / 新序列号） */
export async function openHistory(
  instrument: Instrument,
  stationId: string,
  serialNo: string,
  startDate: string,
  reason: string,
  now: number
): Promise<InstallHistory> {
  const row: InstallHistory = {
    id: createId('ih'),
    instrumentId: instrument.id,
    stationId,
    serialNo,
    startDate,
    endDate: null,
    reason,
    createdAt: now,
    updatedAt: now,
  };
  await db.installHistories.put(row);
  return row;
}

/**
 * 改点 / 换序列号：封存旧在任履历、开启新履历并回写仪器档案。
 * 调用方应已开启包含 instruments 与 installHistories 的事务；
 * 未开启时各操作仍会在各自的隐式事务中执行。
 */
export async function applyInstrumentMove(payload: {
  instrument: Instrument;
  newStationId: string;
  newSerialNo: string;
  reason: string;
  changeDate: string;
  now: number;
}): Promise<void> {
  const { instrument, newStationId, newSerialNo, reason, changeDate, now } = payload;
  await sealOpenHistory(instrument.id, changeDate, now);
  await openHistory(instrument, newStationId, newSerialNo, changeDate, reason, now);
  await db.instruments.update(instrument.id, {
    stationId: newStationId,
    serialNo: newSerialNo,
    updatedAt: now,
  } as never);
}

/**
 * 为没有履历的仪器补建当前在任履历（升级旧数据 / 导入旧快照时调用）。
 * 仅补建缺失项，已存在履历的仪器不动，保证幂等。
 */
export async function backfillInstallHistories(now: number): Promise<number> {
  const [instruments, existing] = await Promise.all([
    db.instruments.toArray(),
    db.installHistories.toArray(),
  ]);
  const covered = new Set(existing.map((row) => row.instrumentId));
  const missing = instruments.filter((row) => !covered.has(row.id));
  if (missing.length === 0) return 0;
  const rows = missing.map((instrument) => buildInitialHistory(instrument, now));
  await db.installHistories.bulkPut(rows);
  return rows.length;
}

/**
 * 为缺少台站归属的标定 / 更换记录补台站归属（按仪器当前台站）。
 * 仅补写缺失项，已带 stationId 的记录不动，保证幂等。
 */
export async function backfillAttribution(): Promise<void> {
  const instruments = await db.instruments.toArray();
  const stationOf = new Map(instruments.map((row) => [row.id, row.stationId]));
  await db.calibrations.toCollection().modify((row) => {
    if (!row.stationId) {
      row.stationId = stationOf.get(row.instrumentId) ?? '';
    }
  });
  await db.replaces.toCollection().modify((row) => {
    if (!row.stationId) {
      row.stationId = stationOf.get(row.instrumentId) ?? '';
    }
  });
}
