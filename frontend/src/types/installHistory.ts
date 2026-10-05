/**
 * 安装履历：仪器历次「台站 + 序列号」归属阶段。
 * 改点（换台站 / 换序列号）时封存旧阶段、开启新阶段，
 * 标定记录与更换单按发生时的台站归属记账，台站台数按当前归属统计。
 */

/** 安装履历：一段「仪器在某台站使用某序列号」的期间 */
export interface InstallHistory {
  id: string;
  /** 所属仪器 */
  instrumentId: string;
  /** 该阶段所在台站 */
  stationId: string;
  /** 该阶段使用的序列号 */
  serialNo: string;
  /** 该阶段开始日期（安装 / 换点日期，YYYY-MM-DD） */
  startDate: string;
  /** 该阶段结束日期；null 表示当前在任 */
  endDate: string | null;
  /** 换点 / 换序列号原因 */
  reason: string;
  createdAt: number;
  updatedAt: number;
}

/** 履历阶段文案：在任显示「至今」，已卸任显示起止区间 */
export function formatHistoryPeriod(history: InstallHistory): string {
  if (history.endDate === null) return `${history.startDate} ~ 至今`;
  return `${history.startDate} ~ ${history.endDate}`;
}

/** 按开始日期倒序排列履历（最近的阶段在前） */
export function sortHistories(histories: InstallHistory[]): InstallHistory[] {
  return [...histories].sort((a, b) => b.startDate.localeCompare(a.startDate));
}
