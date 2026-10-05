/**
 * 安装履历 slice：维护仪器历次「台站 + 序列号」归属阶段。
 * 数据经 utils/db.ts 的 Dexie liveQuery 订阅后写入 store；页面只读 selector，写操作落 IndexedDB。
 */
import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import { db, watchTable } from '@/utils/db';
import type { InstallHistory } from '@/types/installHistory';
import { sortHistories } from '@/types/installHistory';
import type { RootState } from '@/stores/store';

/** 选择器入参统一用 RootState */
type WithInstallHistory = RootState;

export interface InstallHistorySliceState {
  installHistories: InstallHistory[];
  ready: boolean;
}

const initialState: InstallHistorySliceState = {
  installHistories: [],
  ready: false,
};

const installHistorySlice = createSlice({
  name: 'installHistory',
  initialState,
  reducers: {
    setInstallHistories(state, action: PayloadAction<InstallHistory[]>) {
      state.installHistories = action.payload;
      state.ready = true;
    },
  },
});

export const { setInstallHistories } = installHistorySlice.actions;

let started = false;

/** 启动安装履历表实时订阅（幂等） */
export function startInstallHistorySubscription(dispatch: (action: unknown) => void): void {
  if (started) return;
  started = true;
  watchTable<InstallHistory>(() => db.installHistories).subscribe((rows) => {
    dispatch(setInstallHistories(rows));
  });
}

/* ------------------------------ Selector ------------------------------ */

export const selectInstallHistories = (state: WithInstallHistory): InstallHistory[] =>
  state.installHistory.installHistories;

export const selectInstallHistoryReady = (state: WithInstallHistory): boolean =>
  state.installHistory.ready;

/** 指定仪器的全部履历（按开始日期倒序） */
export const selectHistoriesOfInstrument = (
  state: WithInstallHistory,
  instrumentId: string | null | undefined
): InstallHistory[] => {
  if (!instrumentId) return [];
  return sortHistories(
    state.installHistory.installHistories.filter((row) => row.instrumentId === instrumentId)
  );
};

/** 指定仪器当前在任的履历（endDate 为 null） */
export const selectCurrentHistoryOfInstrument = (
  state: WithInstallHistory,
  instrumentId: string | null | undefined
): InstallHistory | null => {
  if (!instrumentId) return null;
  return (
    state.installHistory.installHistories.find(
      (row) => row.instrumentId === instrumentId && row.endDate === null
    ) ?? null
  );
};

export default installHistorySlice.reducer;
