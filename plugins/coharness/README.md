# CoHarness 寄宿于 dsh

CoHarness 把项目阅读、开发和审阅放入三个空间。dsh 提供客户端外壳、工作区、认证、模型循环和持久化存储。插件使用 TypeScript 处理文件和 Git。插件不依赖 Python HTTP 服务。

## 用户在三个空间协作

| 空间 | 当前功能 |
| --- | --- |
| 项目空间 | 打开目录、模型生成项目概览和架构 HTML、场景阅读、源码依据、目录分层浏览、文件搜索、分段读取 |
| 开发空间 | 保存需求、编辑文件、保存工作快照、暂存任务、恢复任务 |
| 审阅空间 | 当前修改、提交历史、双栏差异、修改项选择、调用候选、参数个数、上下文抽屉、返回原修改项、预期对齐 |

模型每次生成概览时同时提交 `architectureHtml`。模型决定模块分层、关系箭头、布局、颜色和展开说明。客户端在文字说明上方展示 HTML。客户端不生成项目关系数据。

架构页面使用隔离 iframe。浏览器禁止脚本、外部资源和父页面访问。模型可以使用 HTML details 和 CSS 实现展开交互。用户可以展开整个架构页面。

文件编辑保存工作快照。用户确认预期后，系统保存对齐记录。上述操作均不会创建 Git 提交。恢复任务使用 `git stash apply --index`，系统保留 stash 备份。

## 插件组织代码

| 路径 | 职责 |
| --- | --- |
| `cordis.patch.yml` | 注册 dsh 插件 |
| `src/index.ts`、`src/rpc.ts` | 注册带 dsh 认证的精确 RPC 路由 |
| `src/overview/` | 运行模型、读取依据、校验概览、保存生成记录 |
| `src/ide/files.ts` | 限定文件范围、分段读取、核对版本、保存文件 |
| `src/ide/symbols.ts` | 解析 TypeScript、JavaScript、Python 定义及同文件调用候选 |
| `src/ide/workflow.ts` | 读取 Git 状态、提交历史和任务暂存 |
| `src/ide/workspace.ts` | 生成修改地图、校验对齐记录 |
| `src/ide/store.ts` | 保存操作记录、恢复状态、导入旧 SQLite 记录 |
| `src/ide/service.ts` | 隔离工作区、按仓库串行执行请求 |
| `src/client/Panel.tsx` | 组织三个空间 |
| `src/client/Architecture.tsx` | 展示模型生成的架构 HTML |
| `src/client/Workbench.tsx` | 连接工作台与认证 RPC |
| `src/client/workbench/` | 承载迁移后的文件、开发、审阅界面 |

宿主只接受已注册的工作区 ID。客户端不能通过 RPC 指定任意根目录。工作台使用隔离 iframe 和带随机通道标识的消息桥。宿主保持文件操作的授权边界。

## 编辑器布局

文件浏览与开发空间使用紧凑文件树和文件标签。CodeMirror 提供语法高亮、行号、折叠、搜索和撤销。开发空间支持 Ctrl/Cmd+S 保存工作快照。页面保留未保存草稿。

审阅空间使用双栏差异。顶部下拉框选择修改项。右侧面板保存预期和对齐状态。用户可以收起右侧面板。调用上下文继续支持展开和返回原修改项。

## 系统保存真实记录

`coharness_overview` 保存概览版本与最近生成编号。每条引用保留路径、行号、SHA-256 和源码片段。

`coharness_ide` 保存操作日志。每条日志同时携带状态值与序号。系统从日志恢复需求、快照、暂存关联和对齐记录。

开发启动脚本通过 `COHARNESS_LEGACY_STATE_DIR` 指定旧状态目录。插件首次打开对应工作区时读取旧 SQLite 数据。插件使用 Node 的 SQLite 接口。旧数据库保持原样。插件保留旧审计记录；旧对齐快照不会自动成为新快照的已对齐状态。

## 用户启动插件

项目固定使用 dsh 0.2.1-alpha.1。插件要求 Node 22.19+ 或 Node 24+。

```sh
pnpm install
pnpm run typecheck
pnpm test
pnpm run build
```

用户在现有 dsh 环境安装本地插件：

```sh
dsh plugin --profile web add file:/完整路径/plugins/coharness
dsh web
```

本仓库的 `pnpm run dev` 使用 `.coharness/dsh-dev` 中的隔离 dsh。脚本在 3081 端口启动 Web 客户端。模型使用 dsh 已配置的默认模型与凭据。

## 当前边界

模型已接入项目阅读。开发需求目前支持保存和人工文件编辑，模型自动修改循环尚未接入。运行验证尚未接入。用户对齐不会被标记为测试通过。提交创建尚未接入。

调用关系是语法层面的同文件候选。系统不会把动态调用或跨文件引用伪装为已确认调用。模块架构关系由模型根据引用依据生成。

文件正文按需分段读取。差异预载保留 1000 文件、单文件 512 KiB、总计 8 MiB 的边界。大型历史差异目前显示范围提示。

旧 `coharness/` 目录保留为迁移参考。用户审核通过前，系统不会删除旧原型。

## 迁移验证

2026-10-08：22 项自动测试通过。测试覆盖 RPC、模型循环、依据校验、文件版本冲突、分段读取、Git 历史、暂存恢复、旧记录导入与 HTML 隔离策略。TypeScript 类型检查和插件构建通过。

实际 Web 页面及模型生成验证记录将在本次验收后补充。Electron 客户端安装尚未验证。
