# sologsb101-1012 地震台阵仪器标定与布设台账

面向地震台阵建设与运维班组的纯前端单页应用：把台站布设、仪器安装与逐次标定结果写成可追溯的台账。数据全部保存在浏览器本地（IndexedDB），不依赖任何后端服务或外部接口。

## 一、Docker 一键启动（推荐）

```bash
cp .env.example .env && docker compose up -d --build
```

启动完成后访问：**http://localhost:22812**

常用命令：

```bash
docker compose ps                 # 查看容器状态
docker compose logs -f frontend   # 查看 nginx 访问日志
docker compose down               # 停止并移除容器
docker compose up -d --build      # 修改代码后重新构建
```

> 宿主端口由 `.env` 中的 `FRONTEND_PORT` 控制（默认 22812）。
> 容器为纯静态 nginx，无数据库服务、不挂载任何命名卷，可随时删除重建。

## 二、技术栈

| 层次 | 选型 | 说明 |
| --- | --- | --- |
| 框架 | React 18.3（函数组件 + Hooks） | 页面全部 `lazy` 懒加载并 `Suspense` 兜底 |
| 语言 | TypeScript 5.6（strict） | 构建脚本执行 `tsc --noEmit` 类型检查 |
| UI 组件 | Ant Design 5.22 + @ant-design/icons | 中文语言包，表格 / 表单 / Modal / 徽标 |
| 构建 | Vite 5 | 产物 `dist/`，交给 nginx 托管 |
| 状态管理 | Redux Toolkit 2 + react-redux 9 | `arraySlice` / `instrumentSlice` / `calibrationSlice` |
| 路由 | React Router 6（`createBrowserRouter`） | 路径与提示词逐字一致，支持深链刷新 |
| 持久化 | Dexie 4（IndexedDB，库名 `gbseisarray`） | 结构版本 v3 + upgrade 迁移 + liveQuery 订阅 |
| 容器 | node:20-alpine 构建 → nginx:alpine 运行 | 多阶段构建，运行阶段 `chmod -R a+rX` |

## 三、路由与功能模块

| 路由 | 页面 | 消费模型 | 主要交互 |
| --- | --- | --- | --- |
| `/arrays` | 台阵与台站台账 | Array、Station、Instrument | 新建/编辑/删除台阵，按布设日期、运行状态与孔径分档筛选；卡片回显台站数、仪器数与标定合格率，可一键按经纬度重算孔径 |
| `/stations/:id/instruments` | 台站仪器登记与安装位置维护 | Station、Instrument、InstallationRecord | 新增/编辑/删除台站（经纬度范围校验 + 度分秒显示、基岩类型、高程），登记仪器（类型/型号/序列号**唯一性校验**/安装日期/状态）；**改点**按新台站归位并封存旧台站/旧序列号履历，可查看每台仪器的分段安装履历；标定次数按当时归属统计 |
| `/calibrations` | 标定记录台 | Calibration、Instrument、InstallationRecord | 录入灵敏度、自噪与脉冲响应结论（按类型区间自动初判）、灵敏度相对上次的变化、批量改结论、灵敏度趋势折线图；台站/序列号按**标定当天当时归属**显示，改点或换序列号后旧成果标注「原站 / 旧号」不跟随移动 |
| `/replacements` | 合格评定与更换提醒 | Replace、Calibration、Instrument、InstallationRecord | 按 365 天标定周期评定，超期未标定与不合格仪器高亮；登记更换并推进状态机（待更换→已更换→已复核），流转到「已更换」时回写仪器序列号并自动封存旧序列号履历；更换单（含未办完）按**登记当天当时归属**留在原台站 |
| `/geometry` | 台阵几何视图、布设—计量对账与结构版本 | 全部模型 | 实算孔径与台站间距、SVG 几何平面图与辐射距离、按台阵汇总标定结论、**布设—计量对账明细**（台站台数按当前归属，标定/更换按当时归属，逐项核对平衡）、结构版本查看、全量 JSON 导入导出（六张表） |

带 `:id` 的层级路由在直接深链访问时同样可用：若 IndexedDB 中查不到该台阵，页面渲染 `<RouteMissingPanel>` 友好空态（含「返回台阵台账」与可用 id 快捷跳转），不会白屏。

## 四、目录结构

```
sologsb101-1012/
├── README.md
├── docker-compose.yml          # name: gbseisarray，不写 version
├── Dockerfile                  # 多阶段：node:20-alpine 构建 → nginx:alpine 托管
├── nginx.conf                  # try_files $uri $uri/ /index.html; + gzip
├── .env / .env.example         # COMPOSE_PROJECT_NAME、FRONTEND_PORT
├── .gitignore
└── frontend/
    ├── Dockerfile              # 前端独立构建用（同样多阶段 + chmod -R a+rX）
    ├── nginx.conf              # 前端独立托管用
    ├── .dockerignore
    ├── package.json            # build = tsc --noEmit && vite build
    ├── tsconfig.json
    ├── vite.config.ts
    ├── index.html
    ├── public/favicon.svg
    └── src/
        ├── main.tsx            # Provider + ConfigProvider + RouterProvider
        ├── App.tsx             # 侧边导航 + 顶部上下文条 + 页脚，并启动各表订阅
        ├── types/              # array / station / instrument / installation / calibration / replace / filter
        ├── stores/             # arraySlice / instrumentSlice（含安装履历）/ calibrationSlice / store.ts
        ├── components/common/  # QualifyTag / FilterBar / StatBadge / EmptyPanel / RouteMissingPanel / InstallationHistoryDrawer
        ├── hooks/              # useIdbTable / useCalibHistory
        ├── pages/              # ArrayList / StationInstruments / CalibrationBoard / ReplaceBoard / GeometryView
        ├── router/index.tsx    # 路由表（路径与提示词逐字一致）
        ├── styles/main.css
        └── utils/              # geo.ts（Haversine/孔径）/ db.ts（Dexie 封装）/ installation.ts（履历/当时归属/对账）/ export.ts（导入导出与结论）
```

## 五、本地开发

```bash
cd frontend
npm install
npm run dev        # http://localhost:22812
npm run build      # 类型检查 + 生产构建
npm run preview    # 预览构建产物
```

## 六、数据存储说明

- **存储位置**：浏览器 IndexedDB，库名 `gbseisarray`，当前结构版本 `v3`。读写统一经 `frontend/src/utils/db.ts` 封装，页面组件不直接触碰 Dexie 实例。
- **数据表**：`arrays`（台阵）、`stations`（台站）、`instruments`（仪器）、`calibrations`（标定）、`replaces`（更换）、`installations`（安装履历，v3 新增）。
- **安装履历口径**：仪器一台一档，履历按段记录「台站 + 序列号 + 起止日期 + 原因（初次安装/改点/更换序列号/历史档案补录）」。改点后仪器档案按新台站归位，旧台站与旧序列号封存在已关闭段；标定记录与更换单不跟随移动。台站台数按仪器**当前归属**（`instrument.stationId`），标定成果按标定日期、更换单（含未办完的待更换单）按登记日期解析履历段得到**当时归属**；各台站合计与仪器档案/标定记录/更换记录总数逐项相等（几何页「布设—计量对账明细」可核对，不平衡会给出 issue）。
- **升级迁移**：`db.version(1)` 保留初版结构；`db.version(2)` 补齐索引并回填时间戳与必填字段；`db.version(3)` 新增 `installations` 表并在 upgrade 中按现有仪器档案（当前台站 + 当前序列号 + 安装日期）为每台仪器补一条「历史档案补录」在用段；调整字段结构时递增 `DB_VERSION` 并补迁移。
- **首屏播种**：`initDatabase()` 在 `arrays` 表为空时执行幂等播种，生成四层互相引用的演示数据（2 个台阵 / 5 个台站 / 8 台仪器 / 11 条标定 / 3 条更换），并刻意包含：1 次不合格标定（自噪超标）、2 台超期未标定仪器、3 条不同状态的更换记录、1 次跨台站改点（含改点前后各 1 次标定）与 2 次同站更换序列号，保证安装履历与两边对账每个页面打开都有内容可演示。
- **实时同步**：utils/db.ts 的 `watchTable()` 基于 Dexie `liveQuery` 订阅表变化，`App.tsx` 挂载时启动订阅并把数据 dispatch 到 Redux slice，页面只读 selector。
- **业务规则**：标定周期 365 天（超期即在更换提醒页高亮）；响应结论自动初判规则为「灵敏度落在类型区间内（宽频带 800~3000、短周期 100~800、强震 0.1~5）且自噪 ≤ 3.5」，最终以标定报告为准；仪器序列号全局唯一；更换状态机为 待更换 → 已更换 → 已复核，流转到「已更换」时把新序列号回写到仪器档案、旧序列号封进履历并置为在用。
- **备份与恢复**：`/geometry` 页可导出包含六张表的 JSON 快照，支持「覆盖导入」与「追加导入（重新分配 id）」；早期五表快照（无 `installations`）读回来时按与 v3 升级完全相同的规则为每台仪器补一条履历（确定性 id，重复导入幂等）；备份时间写入 `localStorage`，页脚与几何页均展示结构版本号。
- **离线可用**：应用为纯静态资源，无任何网络请求；换浏览器或清空站点数据后数据不跟随，需通过 JSON 备份迁移。
