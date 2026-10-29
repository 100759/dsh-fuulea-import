# 辅立码课导入成绩工作台 —— 设计说明（SPEC）

> 目标：做一个 DeepSeek Harness 工作台插件 `dsh-fuulea-import`，在「工作台」左侧新增
> 「导入成绩」入口，点进去是整页工作台：选学校 → 选任务（考试×学科）→ 拖入成绩文件
> （xlsx/xls/csv 或 zip 压缩包）→ 一键填充模板 → 预检 → 导入 → 核对平台回执。
>
> 第一版范围：
> - **只做「平常考试」**：任务已在平台发布好，工作台只负责 下模板→填充→预检→上传→核回执；
> - **不做** 绑卷 / 发布考试任务 / 阅卷分配 / 收尾（开始/结束阅卷、算分、公布成绩）。

## 参考实现（设计时借鉴的可复用模式）

- 同系列插件 `dsh-fuulea-report`（<https://github.com/100759/dsh-fuulea-report>）
  （Host: `index.js` + `lib/api.js` + `lib/murmur3.js` + `lib/bindings.js` + `lib/xlsx.js`；
   Client: `client.js`；含 学校绑定/切换、版本更新、文件打开 全套可复用模式）。
- 同系列技能包里的 Python 脚本：`fill.py`、`precheck_upload.py`（openpyxl，逻辑已验证）；
  本仓库已按同样逻辑内联为 `scripts/fill_template.py` 与 `scripts/precheck.py`。

## 平台接口事实（来自技能包实测，直接信任）

- 登录：`POST /v2/auth/login/` `{username,password}` → `{token, siteId, siteTitle, chargedGradeIds, manageGradeIds, ...}`。
- 业务请求三头：`Authorization: jwt <token>`、`uuid`、`fl-sec-sign: <murmur3hex>,<unix秒>`。
  签名串：`${METHOD} ${path}?${q}&none=${ts}&key=${key}&agent=${uuid}&uuid=${uuid}`；
  `key = jwt签名段 sig[0:3]+sig[8:10]+sig[-5:]`；`q` = 参数「key 小写=值」按原 key 排序 `&` 连接。
  murmurhash3_x64_128 纯 JS 实现见 `lib/murmur3.js`（有 selftest 向量）。
- 任务列表：`GET /v2/tasks/?subjectId=&gradeId=&type=2&page=N` → `{count, results:[{taskId,title,classroomName,...}]}`。
  注意：`/v2/tasks/` 默认按当前账号学科收窄，遍历 9 学科拿全量。
- 成绩上传模板（班级对照表，全通教育）：`GET /v2/tasks/<taskId>/class-list/` → xlsx（两张表：
  `小题分` 表 表头第 3 行、B 列=姓名、第 9 列(I)起=题号列；`班级对照表` 无表头 A 列=姓名）。
  模板由 (考试,学科) 决定，同组合所有 taskId 返回相同内容。
- 上传接口：`POST /v2/tasks/import/data/`（multipart/form-data）：
  `usernamePrefix=""`、`source="qt"`、`taskId`、`file=<xlsx>`。成功响应 `{}`；有错响应非空对象。
  导入后台异步，**唯一可信的“收下”证据是 inbox 回执**。
- 回执：`GET /v2/inbox/trainer/?page=N` → `{count, results:[{title,content,createAt}]}`；
  `title=="导入任务数据"` 的条目，`content` 双层转义 JSON，`error` 非空 = 拒收；
  成功文案形如 `{"success":{"历史.xlsx":"导入学生: 39"},"error":{}}`。
- 年级列表兜底：`GET /v2/classrooms/grades/` → `[{id,...}]`。

## 源成绩文件格式（本工作台要解析的“输入”）

“平常考试”的源表比月考组织格式简单，允许多种常见形态，但都含一个「姓名列 + 若干题号列
（+ 可选的 总分列）」。解析器要能识别：
- xlsx（多 sheet 或多文件）、xls、csv；zip 压缩包（内含多份上述文件）。
- 每个 sheet/文件 → 找到「姓名」列（表头含 姓名/学生/学生姓名），题号列 = 表头能解析成数字
  或含「题/分」的连续列；总分列 = 表头含「总分/总成绩/合计」。
- 学生姓名归一化：去掉末尾数字后缀（「张同学2」→「张同学」），去首尾空白。

## 工作流（页面 → Host 接口）

1. `GET defaults` → 已绑定学校列表、最近学校、凭据文件、版本。
2. `POST bind` / `POST unbind` → 绑定/解绑学校（账号密码只存本机 `~/.fuulea-import/bindings.json`，0600）。
3. `POST tasks` → 登录 → 遍历 9 学科拉取 type=2 任务 → 按 (考试,学科) 分组返回。
4. 用户拖入文件 → 前端只把「文件字节」用 `POST parse`（base64）或直接由浏览器读后 base64 上传 → Host 解析返回
   `{subjectGuess, students:[..], questionCount, totalColumn, sheets}`。
5. `POST template` → 下模板并解析返回 `{roster, questionHeaders, questionCount}`。
6. `POST fill` → Host 用 Python(openpyxl) 把源表填进模板 → 返回 `{students, questionCount, blankCells}`。
7. `POST precheck` → 预检（空格=0、名单一致、题号列>0）。
8. `POST import` → 上传（source=qt）→ 记录 `{taskId, at, file}`。
9. `POST receipt` → 拉 inbox 回执 → 按文件名/时间窗匹配 → `{ok, count, matched:[{file,success,students,error}]}`。

## Host 接口契约（`/fuulea-import/api/*`，全部 JSON）

前缀 `ROUTE_PREFIX = '/fuulea-import/api'`。所有响应 `{ok:true, ...}` 或 `{ok:false, error}`。

| method+path | body | 返回 |
|---|---|---|
| GET defaults | — | `{version, defaults:{school, days, credentialsFile, bindingsFile, bindings, lastSchool}}` |
| POST bind | `{school,username,password}` | `{binding(masked), bindings, lastSchool}` |
| POST unbind | `{school}` | `{removed, bindings, lastSchool}` |
| POST tasks | `{school, gradeId?}` | `{groups:[{exam,subject,subjectId,taskId,className,classroomName,gradeId,title}], subjects:[...], grades:[...]}` |
| POST template | `{school, taskId}` | `{taskId, roster:[..], questionHeaders:[..], questionCount}` |
| POST parse | `{school, files:[{name,data(base64),bytes}], taskId?}` | `{files:[{name, subjectGuess, students, questionCount, totalColumn, sheets:[{name,headerRow,rows}]}]}` |
| POST fill | `{school, taskId, sourceFile:{name,data}, sourceSheet?}` | `{filled:{name,bytes,students,questionCount,blankCells}, outFile}` |
| POST precheck | `{school, filledFile:{name,data}}` | `{ok, students, questionCount, blankCells, blankRows, partialRows, extraInScores, missingInMap, noSubscores}` |
| POST import | `{school, taskId, filledFile:{name,data}}` | `{submitted:true, taskId, at}` |
| POST receipt | `{school, sinceISO?, fileNames:[..]}` | `{count, matched:[{title,content,file,success,students,error,createAt}]}` |
| POST open | `{path, reveal?}` | 打开/定位输出目录文件（沿用报告插件 openWithSystem） |

## Host 实现要点

- 复用报告插件的 `lib/api.js`（FuuleaApi 已含 login/ensureAuth/get/getBinary + 签名），
  **补充 `postForm`（multipart，用于上传）与 `postJson`**。
- `lib/bindings.js`：复制报告插件，把存储路径改为 `~/.fuulea-import/bindings.json`，别名/掩码逻辑一致。
- `lib/murmur3.js`：原样复制。
- `lib/xlsx.js`：复制报告插件的 `readWorkbook`（Node 侧只读解析源表/模板用）。
- Python 填充/预检：`scripts/fill_template.py` 与 `scripts/precheck.py`（用 openpyxl 读写 xlsx，
  直接内联 skillpack 里 `fill.py` 的 read_tpl/read_src 逻辑与 `precheck_upload.py` 的 check 逻辑），
  Host 用 `spawn` 调 `python3`，输入输出走临时目录 JSON。
- 输出目录：`~/.fuulea-import/output/`，填好的模板存那里，`POST open` 可打开。
- 版本检查/一键更新（GitHub）：第一版**可不做**，保留版本号即可（不做 updater 以缩小范围）。
- 凭据优先级：请求体账号密码 > 本机绑定 > 技能包 `.credentials`（`~/.workbuddy/skills/fuulea-teaching-cloud/scripts/.credentials`，`别名|账号|密码` 格式）。

## Client 实现要点（client.js）

- 用 `window.__ModuleLoader__.load({id:'dsh-fuulea-import', factory(require){...}})`；
  `require('react')` 取 React，不依赖任何 Harness Client 包。
- 注册：`ctx.slots.inject('sidebar.panellist', ...)` 注册 id=`fuulea-import`、label=`导入成绩` 的面板项
  （带 `PanelIcon` 组件）；`ctx.slots.inject('main', ...)` 注册 key=`fuulea-import` 的整页组件。
- 页面结构（自上而下）：
  1. 顶栏：学校下拉（已绑定学校切换 + 「＋绑定其他学校」）+ 任务选择（考试×学科分组下拉/搜索）
     + 右上角版本号。
  2. 主区左：拖放区（拖入 xlsx/xls/csv/zip；选中后列文件清单，每份显示 学科猜测/学生数/题数/总分列）。
  3. 主区中：匹配到任务后，显示「下载模板」→ 模板题号列与名单摘要。
  4. 主区右/下：操作按钮流——「解析文件」→「填充模板」→「预检」→「导入」→「核对回执」，
     每步显示结果卡片（预检空格数、导入提交状态、回执 成功/失败+人数）。
  5. 底部：本次会话操作日志（时间 + 步骤 + 结果）。
- 样式：只用 `--dsw-alias-*` / `--dsw-specific-*` 主题 token（浅色/深色自适应）；
  参考报告插件 `client.js` 的 `.flr-page` 样式做法，本插件用 `.fli-` 前缀。不 append 到 body。
- 文件读取：浏览器 `FileReader.readAsDataURL` → base64 传给 Host；zip 也原样传，Host 解压。
- 文案：界面中文为主。

## 文件清单（插件目录 `fuulea-import/`）

```
fuulea-import/
  package.json          # name=dsh-fuulea-import, dsh.bundle.patch + dsh.client
  cordis.patch.yml      # insert id=fuulea-import name='dsh-fuulea-import'
  index.js              # Host 半边（路由 + 工具注册）
  client.js             # Client 半边（工作台页面）
  lib/api.js            # FuuleaApi（含 postForm/postJson）
  lib/murmur3.js        # murmurhash3
  lib/bindings.js       # 学校绑定存储（~/.fuulea-import/bindings.json）
  lib/xlsx.js           # Node 只读 xlsx 解析
  lib/parse.js          # 源成绩文件解析（识别姓名/题号/总分列）
  lib/template.js       # 下模板 + 解析模板结构
  lib/qmap.js           # 题号标准化 + 规则映射 + 填充计划
  lib/ai.js             # AI 题号映射建议（只出映射，不出分值）
  scripts/fill_template.py   # openpyxl 填充
  scripts/precheck.py        # openpyxl 预检
  locale/zh.json        # meta.title=导入成绩 meta.description
  locale/en.json
  icon.svg
  README.md
```

## 安装与验收

- 用 `plugin_manager` `install_bundle`（target=仓库绝对路径），或 `dsh plugin --profile <p> add github:100759/dsh-fuulea-import`。
- 验收：`list_plugins` / `cordis_inspect_query` 确认行出现且 enabled；页面工作台左侧出现「导入成绩」。
- 因为生产站写操作，实际「导入」联调只允许在测试站或用户明确同意时对生产站执行。
