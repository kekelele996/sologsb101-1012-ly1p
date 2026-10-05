/**
 * 仪器 slice：维护仪器列表、登记草稿与选中台站。
 * 序列号唯一性校验与「登记后自动生成下一次标定待办」在本 slice 的动作里完成。
 */
import { createAsyncThunk, createSlice, type PayloadAction } from '@reduxjs/toolkit';
import { db, createId, watchTable } from '@/utils/db';
import type { Instrument, InstrumentDraft, InstrumentState, InstrumentType } from '@/types/instrument';
import { createEmptyInstrumentDraft, daysUntilDue } from '@/types/instrument';
import type { InstallationRecord, InstallationReason } from '@/types/installation';
import { buildSegmentTurn, sortInstallations } from '@/utils/installation';
import type { RootState } from '@/stores/store';

/** 选择器入参统一用 RootState */
type WithInstrument = RootState;

export interface InstrumentSliceState {
  instruments: Instrument[];
  installations: InstallationRecord[];
  ready: boolean;
  error: string | null;
  /** 当前选中的台站（台站仪器页上下文） */
  currentStationId: string | null;
  /** 仪器登记草稿（跨页面保留） */
  draft: InstrumentDraft;
  /** 最近一次保存回执（用于页面提示） */
  lastReceipt: string;
}

const initialState: InstrumentSliceState = {
  instruments: [],
  installations: [],
  ready: false,
  error: null,
  currentStationId: null,
  draft: createEmptyInstrumentDraft(),
  lastReceipt: '',
};

/** 序列号唯一性校验：返回冲突的仪器（排除自身） */
export async function findSerialConflict(
  serialNo: string,
  excludeId?: string
): Promise<Instrument | undefined> {
  const rows = await db.instruments.where('serialNo').equals(serialNo).toArray();
  return rows.find((row) => row.id !== excludeId);
}

export const createInstrument = createAsyncThunk(
  'instrument/createInstrument',
  async (
    payload: Omit<Instrument, 'id' | 'createdAt' | 'updatedAt'>,
    { rejectWithValue }
  ) => {
    const conflict = await findSerialConflict(payload.serialNo);
    if (conflict) {
      return rejectWithValue(`序列号「${payload.serialNo}」已被仪器 ${conflict.model} 占用`);
    }
    const now = Date.now();
    const row: Instrument = { ...payload, id: createId('ins'), createdAt: now, updatedAt: now };
    // 仪器档案与第一条安装履历（当前台站 + 当前序列号的在用段）同事务落库
    const firstInstallation: InstallationRecord = {
      id: createId('inst'),
      instrumentId: row.id,
      stationId: row.stationId,
      serialNo: row.serialNo,
      startDate: row.installDate,
      endDate: null,
      reason: '初次安装',
      operator: '',
      remark: '登记仪器时自动生成',
      createdAt: now,
      updatedAt: now,
    };
    await db.transaction('rw', [db.instruments, db.installations], async () => {
      await db.instruments.put(row);
      await db.installations.put(firstInstallation);
    });
    // 登记后自动生成下一次标定待办：待标定状态 + 提示文案
    const dueInDays = daysUntilDue(null, row.installDate);
    return { row, dueInDays };
  }
);

export const updateInstrument = createAsyncThunk(
  'instrument/updateInstrument',
  async (
    payload: { id: string; patch: Partial<Instrument> },
    { rejectWithValue }
  ) => {
    if (payload.patch.serialNo) {
      const conflict = await findSerialConflict(payload.patch.serialNo, payload.id);
      if (conflict) {
        return rejectWithValue(`序列号「${payload.patch.serialNo}」已被占用`);
      }
    }
    // 台站归属变更必须走「改点」动作（relocateInstrument），普通编辑不改 stationId
    const { stationId: _ignoredStationId, ...fieldPatch } = payload.patch;
    const existing = await db.instruments.get(payload.id);
    if (!existing) return rejectWithValue('仪器不存在');

    await db.transaction('rw', [db.instruments, db.installations], async () => {
      const now = Date.now();
      await db.instruments.update(payload.id, { ...fieldPatch, updatedAt: now } as never);
      // 序列号变更（同站换序列号）：旧序列号封进履历，同站开一段新序列号履历
      if (fieldPatch.serialNo && fieldPatch.serialNo !== existing.serialNo) {
        const records = await db.installations.where('instrumentId').equals(payload.id).toArray();
        const turn = buildSegmentTurn(records, {
          instrumentId: payload.id,
          nextStationId: existing.stationId,
          nextSerialNo: fieldPatch.serialNo,
          startDate: fieldPatch.installDate ?? new Date().toISOString().slice(0, 10),
          reason: '更换序列号',
          operator: '',
          remark: '编辑仪器档案时序列号变更，自动封存旧序列号',
          idFactory: () => createId('inst'),
          now,
        });
        if (turn) {
          for (const closed of turn.closes) await db.installations.put(closed);
          await db.installations.bulkPut(turn.opens);
        }
      }
    });
    return payload;
  }
);

/**
 * 改点（布设班组换台站）：
 * 按新台站归位仪器档案；旧台站与旧序列号封进履历段；
 * 不动任何标定记录与更换单（它们始终按当时归属留在原台站名下）。
 * - 目标台站同当前台站且序列号未变：拒绝（无履历可记）；
 * - 只换台站：履历段 reason=改点；
 * - 同时换序列号：新段记录新序列号，旧序列号随旧台站段封存。
 */
export const relocateInstrument = createAsyncThunk(
  'instrument/relocateInstrument',
  async (
    payload: {
      instrumentId: string;
      stationId: string;
      serialNo: string;
      startDate: string;
      operator?: string;
      remark?: string;
    },
    { rejectWithValue }
  ) => {
    const instrument = await db.instruments.get(payload.instrumentId);
    if (!instrument) return rejectWithValue('仪器不存在');
    if (payload.stationId === instrument.stationId && payload.serialNo === instrument.serialNo) {
      return rejectWithValue('新台站、新序列号与当前档案一致，无需改点');
    }
    if (payload.serialNo !== instrument.serialNo) {
      const conflict = await findSerialConflict(payload.serialNo, payload.instrumentId);
      if (conflict) {
        return rejectWithValue(`序列号「${payload.serialNo}」已被仪器 ${conflict.model} 占用`);
      }
    }
    const reason: InstallationReason =
      payload.stationId !== instrument.stationId ? '改点' : '更换序列号';
    const now = Date.now();
    const records = await db.installations.where('instrumentId').equals(payload.instrumentId).toArray();
    const turn = buildSegmentTurn(records, {
      instrumentId: payload.instrumentId,
      nextStationId: payload.stationId,
      nextSerialNo: payload.serialNo,
      startDate: payload.startDate,
      reason,
      operator: payload.operator ?? '',
      remark: payload.remark ?? '',
      idFactory: () => createId('inst'),
      now,
    });
    if (!turn) return rejectWithValue('新台站、新序列号与当前档案一致，无需改点');

    await db.transaction('rw', [db.instruments, db.installations], async () => {
      for (const closed of turn.closes) await db.installations.put(closed);
      await db.installations.bulkPut(turn.opens);
      // 仪器档案按新台站归位（installDate 保留首次安装日期，本段安装日期以履历为准）
      await db.instruments.update(payload.instrumentId, {
        stationId: payload.stationId,
        serialNo: payload.serialNo,
        updatedAt: now,
      } as never);
    });
    return {
      ...payload,
      reason,
      stationChanged: payload.stationId !== instrument.stationId,
      serialChanged: payload.serialNo !== instrument.serialNo,
    };
  }
);

/** 删除仪器：级联删除标定、更换记录与安装履历 */
export const removeInstrument = createAsyncThunk(
  'instrument/removeInstrument',
  async (instrumentId: string) => {
    await db.transaction(
      'rw',
      [db.instruments, db.calibrations, db.replaces, db.installations],
      async () => {
        await db.calibrations.where('instrumentId').equals(instrumentId).delete();
        await db.replaces.where('instrumentId').equals(instrumentId).delete();
        await db.installations.where('instrumentId').equals(instrumentId).delete();
        await db.instruments.delete(instrumentId);
      }
    );
    return instrumentId;
  }
);

/** 批量改状态（如把超期仪器统一置为待标定） */
export const bulkSetInstrumentState = createAsyncThunk(
  'instrument/bulkSetInstrumentState',
  async (payload: { ids: string[]; state: InstrumentState }) => {
    const now = Date.now();
    await db.instruments
      .where('id')
      .anyOf(payload.ids)
      .modify((row) => {
        row.state = payload.state;
        row.updatedAt = now;
      });
    return payload;
  }
);

/** 更换完成后回写仪器序列号并置为在用（旧序列号封进安装履历） */
export const applySerialReplace = createAsyncThunk(
  'instrument/applySerialReplace',
  async (payload: { instrumentId: string; newSerialNo: string; date?: string }) => {
    const now = Date.now();
    const startDate = payload.date ?? new Date().toISOString().slice(0, 10);
    await db.transaction('rw', [db.instruments, db.installations], async () => {
      const instrument = await db.instruments.get(payload.instrumentId);
      await db.instruments.update(payload.instrumentId, {
        serialNo: payload.newSerialNo,
        state: '在用',
        updatedAt: now,
      } as never);
      if (instrument && payload.newSerialNo !== instrument.serialNo) {
        const records = await db.installations.where('instrumentId').equals(payload.instrumentId).toArray();
        const turn = buildSegmentTurn(records, {
          instrumentId: payload.instrumentId,
          nextStationId: instrument.stationId,
          nextSerialNo: payload.newSerialNo,
          startDate,
          reason: '更换序列号',
          operator: '',
          remark: '更换单完成回写序列号',
          idFactory: () => createId('inst'),
          now,
        });
        if (turn) {
          for (const closed of turn.closes) await db.installations.put(closed);
          await db.installations.bulkPut(turn.opens);
        }
      }
    });
    return payload;
  }
);

const instrumentSlice = createSlice({
  name: 'instrument',
  initialState,
  reducers: {
    setInstruments(state, action: PayloadAction<Instrument[]>) {
      state.instruments = action.payload;
      state.ready = true;
      state.error = null;
    },
    setInstallations(state, action: PayloadAction<InstallationRecord[]>) {
      state.installations = sortInstallations(action.payload);
    },
    setInstrumentError(state, action: PayloadAction<string | null>) {
      state.error = action.payload;
    },
    selectStationForInstrument(state, action: PayloadAction<string | null>) {
      state.currentStationId = action.payload;
      state.draft.stationId = action.payload ?? '';
    },
    patchDraft(state, action: PayloadAction<Partial<InstrumentDraft>>) {
      state.draft = { ...state.draft, ...action.payload };
    },
    resetDraft(state) {
      state.draft = { ...createEmptyInstrumentDraft(), stationId: state.currentStationId ?? '' };
    },
    setReceipt(state, action: PayloadAction<string>) {
      state.lastReceipt = action.payload;
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(createInstrument.fulfilled, (state, action) => {
        const dueInDays = action.payload.dueInDays;
        state.lastReceipt =
          dueInDays >= 0
            ? `仪器已登记，距下次标定 ${dueInDays} 天，请按期安排标定`
            : `仪器已登记，但安装日期距今已超过标定周期 ${Math.abs(dueInDays)} 天，请尽快安排标定`;
        state.error = null;
      })
      .addCase(createInstrument.rejected, (state, action) => {
        state.error = typeof action.payload === 'string' ? action.payload : '仪器登记失败';
      })
      .addCase(updateInstrument.rejected, (state, action) => {
        state.error = typeof action.payload === 'string' ? action.payload : '仪器更新失败';
      })
      .addCase(removeInstrument.fulfilled, (state, action) => {
        state.lastReceipt = `已删除仪器 ${action.payload}`;
      });
  },
});

export const {
  setInstruments,
  setInstallations,
  setInstrumentError,
  selectStationForInstrument,
  patchDraft,
  resetDraft,
  setReceipt,
} = instrumentSlice.actions;

let started = false;

/** 启动仪器表与安装履历表实时订阅（幂等） */
export function startInstrumentSubscription(dispatch: (action: unknown) => void): void {
  if (started) return;
  started = true;
  watchTable<Instrument>(() => db.instruments).subscribe((rows) => {
    dispatch(setInstruments(rows));
  });
  watchTable<InstallationRecord>(() => db.installations).subscribe((rows) => {
    dispatch(setInstallations(rows));
  });
}

/* ------------------------------ Selector ------------------------------ */

export const selectInstrumentState = (state: WithInstrument): InstrumentSliceState => state.instrument;
export const selectInstruments = (state: WithInstrument): Instrument[] => state.instrument.instruments;
export const selectInstallations = (state: WithInstrument): InstallationRecord[] =>
  state.instrument.installations;
export const selectInstrumentReady = (state: WithInstrument): boolean => state.instrument.ready;
export const selectInstrumentDraft = (state: WithInstrument): InstrumentDraft => state.instrument.draft;
export const selectInstrumentReceipt = (state: WithInstrument): string => state.instrument.lastReceipt;

export const selectInstrumentById = (
  state: WithInstrument,
  id: string | null | undefined
): Instrument | null => (id ? state.instrument.instruments.find((row) => row.id === id) ?? null : null);

export const selectInstrumentsOfStation = (
  state: WithInstrument,
  stationId: string | null | undefined
): Instrument[] => {
  if (!stationId) return [];
  return state.instrument.instruments
    .filter((row) => row.stationId === stationId)
    .sort((a, b) => a.type.localeCompare(b.type, 'zh-Hans-CN') || a.model.localeCompare(b.model));
};

/** 台站 id → 仪器台数 */
export const selectInstrumentCountsByStation = (state: WithInstrument): Record<string, number> => {
  const counts: Record<string, number> = {};
  state.instrument.instruments.forEach((row) => {
    counts[row.stationId] = (counts[row.stationId] ?? 0) + 1;
  });
  return counts;
};

/** 仪器类型统计 */
export const selectInstrumentTypeCounts = (state: WithInstrument): Record<InstrumentType, number> => {
  const counts: Record<InstrumentType, number> = { 宽频带: 0, 短周期: 0, 强震: 0 };
  state.instrument.instruments.forEach((row) => {
    counts[row.type] += 1;
  });
  return counts;
};

/** 仪器 id → 安装履历段（按时间升序） */
export const selectInstallationsByInstrument = (
  state: WithInstrument
): Map<string, InstallationRecord[]> => {
  const map = new Map<string, InstallationRecord[]>();
  state.instrument.installations.forEach((record) => {
    const list = map.get(record.instrumentId) ?? [];
    list.push(record);
    map.set(record.instrumentId, list);
  });
  return map;
};

/** 单台仪器的安装履历段（按时间升序） */
export const selectInstallationsOfInstrument = (
  state: WithInstrument,
  instrumentId: string | null | undefined
): InstallationRecord[] => {
  if (!instrumentId) return [];
  return state.instrument.installations
    .filter((record) => record.instrumentId === instrumentId)
    .sort((a, b) => a.startDate.localeCompare(b.startDate));
};

export default instrumentSlice.reducer;
