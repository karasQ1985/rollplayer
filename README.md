# RollPlay 播放器

> 一个跑在本机的媒体库轮播播放器：从本地磁盘或局域网 NAS 里按批随机播放音乐，界面是紫蓝玻璃拟态的黑胶唱片风格。
>
> A local-first, batch-rotation music player built on a tiny Node proxy server and a framework-free front end.

[![Platform](https://img.shields.io/badge/platform-Windows%2010%2F11-3b6ea5)](#运行环境)
[![Node](https://img.shields.io/badge/node-%E2%89%A522.5-339933)](#运行环境)
[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

---

## 它是什么

浏览器打不开本地磁盘目录、也进不了局域网共享，所以这个项目由一个**零依赖（除元数据解析外）的本地 Node 服务** + **一个纯前端页面**组成：

- `server.mjs`：递归扫描媒体库、去重、HTTP Range 流式播放、内嵌封面提取、元数据刮削与本地库缓存、静态页面托管。
- `public/`：无框架前端。目录管理、扫描进度、批次调度、播放引擎、歌词、频谱、唱片动效全部在这里。

播放规则是「每批 20 首随机不放回」：一批播完自动换下一批，整池播完算一轮，轮完询问是否再来一轮。

## 主要特性

**媒体库**
- 添加本地盘符路径或 UNC 网络路径；多目录合并去重（按规范化路径）。
- 后台扫描 + 进度轮询；扫描有资源熔断（10 万文件 / 3 分钟），防误加根目录把磁盘扫穿。
- 增量收录：播放中新增目录只扫该目录，不打断当前播放，下一轮生效。

**播放**
- 进度条点击/拖拽 seek，两侧显示 `当前 / 总时长`。
- 音量滑块 + 静音；`Ctrl + 滚轮` 以 2% 为一格精细调音量。
- 快捷键：`空格` 播放/暂停、`←/→` 上一首/下一首、`↑/↓` 音量。
- 接入 MediaSession，系统媒体键与系统浮层可用。
- 会话持久化（IndexedDB）：刷新后可「恢复播放」未完成的一轮。

**界面**
- 黑胶唱片 + 唱臂：切歌有「停转 → 抬针 → 换曲 → 落针 → 起转」的完整仪式。
- 唱片转速分 4 档，随播放进度升档，40% 进度到满速（2 圈/秒）；曲末 8 秒线性刹停。
- 频谱可视化（柱状 / 环形双引擎）。
- 左抽屉媒体库、右抽屉本批曲目、设置抽屉（在线刮削 / 频谱 / 界面）。

**元数据**
- 四级来源：文件内嵌标签 → 本地库 → 在线刮削（网易云 / lrclib / MusicBrainz+CoverArt / iTunes）→ 增量写回本地库。
- 本地库是 SQLite（`data/meta/library.sqlite`）与内容寻址的封面文件（`data/meta/covers/`），由 worker 线程独占持有，主线程通过消息通信；库有单实例写锁，第二个进程自动降级只读。
- 封面按内容哈希去重并长期缓存（`Cache-Control: immutable`），二次访问直接从本地直出。

## 运行环境

| 项目 | 要求 |
|---|---|
| 操作系统 | **Windows 10 / 11**（当前只支持 Windows，见下方「跨平台说明」） |
| Node.js | **≥ 22.5**（元数据库使用内置 `node:sqlite`，会打印一条 experimental 警告，属正常） |
| 浏览器 | Chrome / Edge 最新版（用到 PointerEvent、CSS `backdrop-filter`） |

## 快速开始

### 方式一：双击启动（推荐给非开发者）

双击项目根目录的 `start.bat`：自动检测 Node → 启动服务 → 打开浏览器。关闭该窗口即停止服务。

> 绿色免安装（可选）：把 `node.exe` 放进项目下的 `node\` 文件夹，`start.bat` 会优先使用它，系统不必安装 Node。

### 方式二：命令行

```bash
npm install        # 只有一个依赖：music-metadata
node server.mjs
```

默认地址 `http://127.0.0.1:9898`；端口被占用会顺延 9899 → 9902（最多试 4 次）。

| 环境变量 | 作用 |
|---|---|
| `MP_PORT` | 起始端口，默认 `9898` |
| `MP_NO_OPEN` | 设为 `1` 时启动不自动打开浏览器 |

### 添加媒体库

页面左侧抽屉里粘贴**绝对路径**，两种格式：

- 本地盘符：`D:\Music`
- 网络共享：`\\192.168.1.100\share\music`

若 UNC 直连报 `EACCES`，先在命令行把共享映射成盘符再添加：

```powershell
net use Z: \\192.168.1.100\share /user:你的账号 密码
```

## 目录结构

```
server.mjs                本地代理服务（扫描 / 流式播放 / 封面 / 刮削 / 静态托管）
meta-worker.mjs           元数据库 worker（唯一持有 SQLite 的线程）
meta-store.mjs            元数据库门面（超时、背压、降级、单实例锁）
start.bat                 一键启动（Windows）
package.json              仅一个运行依赖
public/
  index.html              页面骨架（静态资源带 ?v= 版本串）
  style.css               全部样式
  app.js                  装配入口：目录 / 扫描 / 调度 / 播放 / 歌词 / 抽屉 / 动效
  modules/
    store.js              状态容器 + IndexedDB 持久化
    scheduler.js          调度层（洗牌 / 切批 / 轮次判定，纯逻辑）
    playback.js           播放引擎（Audio 封装 / 代次 token / 失败熔断）
    visualizer.js         频谱可视化（bars / ring）
    providers/            数据访问层（对 server API 的封装）
  assets/                 字体与唱片、音符 SVG
tools/                    自测与基准脚本（详见各文件头部注释）
docs/
  01-项目概览与进度.md
  02-开发经验.md
  03-规则与约束.md
  notes/                  单体技术方案讨论稿（滚轮音量等）
data/                     运行时生成，已被 .gitignore 排除
  meta/library.sqlite     元数据本地库
  meta/covers/            按内容哈希命名的封面
```

> `UI putout/` 是设计标注的导出源（约 94MB），仅本地参考，不纳入仓库。

## 服务端 API（简表）

| 方法与路径 | 说明 |
|---|---|
| `POST /api/check` · `/api/check-paths` | 校验单个/多个目录是否存在且可读 |
| `POST /api/scan` · `GET /api/scan-status` | 创建后台扫描任务 / 轮询进度 |
| `GET /api/files` | 分批拉取去重后的音频清单 |
| `GET /api/stream`（`/stream`） | Range 流式播放，仅放行音频白名单扩展名 |
| `GET /api/cover` · `/api/cover-art` · `/api/cover-hash` | 内嵌封面、原图、内容寻址封面 |
| `GET /api/lyrics` · `POST /api/scrape` | 歌词、在线刮削（带本地库命中） |
| `GET /api/meta/stats` · `POST /api/meta/purge` | 本地库概况 / 清理 |
| `POST /api/open-dir` · `/api/open-path` | 在资源管理器中定位 |

安全边界：路径只接受盘符绝对路径与 UNC，拒绝相对路径与 `..`；静态资源仅限 `public/` 内；`/stream` 只放行 `.mp3 .wav .flac .aac .ogg .m4a .opus`。

## 跨平台说明

当前**只支持 Windows**，原因是几处实现直接依赖 Windows 语义，不是随手能改的：

1. 路径校验与规范化用 `path.win32`（盘符 `D:`、UNC `\\host\share`）。
2. 目录浏览会枚举 `A:`–`Z:` 盘符根。
3. `start.bat` 与「在资源管理器中定位」使用 Windows 命令。

要在 macOS / Linux 上运行，需要把上述三处抽成平台适配层（POSIX 用 `/` 开头路径、挂载点枚举、`open`/`xdg-open`），属于待办而非现成能力。

## 开发约定

改动代码前请先读 [`docs/03-规则与约束.md`](docs/03-规则与约束.md)，核心几条：

- 改 `server.mjs` / `*.mjs` 必须 `node --check` 通过并重启服务；改前端只升 `public/index.html` 里的 `?v=` 版本串。
- 几何、动效、交互一律**浏览器实测**（`getBoundingClientRect`、逐帧采样）后再交付，不靠肉眼估。
- 不引入第三方前端框架与打包器，保持「直接打开即用」。

本地自测脚本：

```bash
node --check server.mjs && node --check meta-worker.mjs && node --check meta-store.mjs
node --check public/app.js && node --check public/modules/playback.js
node tools/scheduler_test.mjs         # 调度层纯逻辑自测
node tools/test-meta.mjs              # 本地元数据库读写自测
python tools/make_test_media.py       # 生成测试音频（需 Python 与相应依赖）
```

## 隐私与网络行为

- 服务只监听本机 `127.0.0.1`，不对外提供端口；页面与服务的通信全在本地。
- 不做任何统计上报，不写 cookie。
- 「在线刮削」会按需请求第三方公开接口（网易云音乐、lrclib、MusicBrainz、CoverArt Archive、iTunes）来补齐缺失的歌名/封面/歌词；**纯本地播放不需要联网**。
- 本地库里只有你音乐文件的路径、标签与封面，全部躺在 `data/meta/`；删除该目录即彻底清空。
- 仓库里不含任何音乐文件、用户目录结构或个人路径。

## 常见问题

| 现象 | 处理 |
|---|---|
| 首次点击播放没反应 | 浏览器自动播放策略拦截，点一次播放按钮即可 |
| 启动打印 `SQLite is an experimental feature` | Node 内置模块的正常提示，不影响功能 |
| 端口 9898 被占 | 会自动顺延；也可 `MP_PORT=9000 node server.mjs` |
| UNC 路径报无权限 | 用 `net use Z: ...` 映射为盘符后添加盘符路径 |
| 封面不显示 | 先确认文件本身有内嵌封面；无封面时走在线刮削（需联网） |

## 文档

| 文档 | 内容 |
|---|---|
| [`docs/01-项目概览与进度.md`](docs/01-项目概览与进度.md) | 运行方式、里程碑、当前状态、未决问题 |
| [`docs/02-开发经验.md`](docs/02-开发经验.md) | 标注还原、交互与输入、动效与时序、浏览器实测、后端与数据 |
| [`docs/03-规则与约束.md`](docs/03-规则与约束.md) | 边界安全、并发安全、渲染规则、交付纪律 |
| [`docs/notes/`](docs/notes/) | 滚轮音量控制等单体议题的完整技术方案讨论稿 |

## 许可证

[MIT](LICENSE) © 2025 KarasQ1985
