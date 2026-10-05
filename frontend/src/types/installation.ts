/**
 * 安装履历（InstallationRecord）
 *
 * 一条记录对应仪器在某一台站上「某段安装区间」：
 * - 改点（instrument.stationId 变更）：关闭旧台站履历段，按新台站开一段；
 * - 换序列号（instrument.serialNo 变更）：关闭旧序列号履历段，同站开新段；
 * - 标定记录与更换单不跟随仪器走，始终按「当时归属」挂在原台站名下，
 *   通过 stationIdAt / serialNoAt 解析得到；
 * - 每台仪器至多有一段 endDate === null 的「当前在用」履历段。
 */

/** 履历段开启原因 */
export type InstallationReason = '初次安装' | '改点' | '更换序列号' | '历史档案补录';

export const INSTALLATION_REASONS: InstallationReason[] = [
  '初次安装',
  '改点',
  '更换序列号',
  '历史档案补录',
];

/** 安装履历：仪器在某台站、以某序列号安装的一个连续区间 */
export interface InstallationRecord {
  id: string;
  /** 仪器 id */
  instrumentId: string;
  /** 该段安装所在台站（改点后旧台站封存在已关闭段中） */
  stationId: string;
  /** 该段安装期间使用的序列号 */
  serialNo: string;
  /** 段开始日期（YYYY-MM-DD，含当日） */
  startDate: string;
  /** 段结束日期（YYYY-MM-DD，含当日）；null 表示当前在用段 */
  endDate: string | null;
  /** 开启原因 */
  reason: InstallationReason;
  /** 操作人（布设班组） */
  operator: string;
  /** 备注 */
  remark: string;
  createdAt: number;
  updatedAt: number;
}

/** 改点表单草稿（存组件即可，不落 Redux 草稿表） */
export interface RelocateDraft {
  stationId: string;
  serialNo: string;
  startDate: string;
  reason: InstallationReason;
  operator: string;
  remark: string;
}

/** 某天仪器的「当时归属」解析结果 */
export interface AttributionAt {
  /** 命中的履历段（无履历时为 null） */
  record: InstallationRecord | null;
  /** 当时台站 id（兜底为仪器当前台站） */
  stationId: string;
  /** 当时序列号（兜底为仪器当前序列号） */
  serialNo: string;
}
