# 前端改版设计:模块拆分 + 可拖拽面板 + 高级视觉

> 日期:2026-06-25  ·  范围:**纯前端**(不动后端/事件协议/client 包)
> 约束:守住「本地优先 / 零构建 / 无外部资源 / 原生 JS+SVG」底线;功能行为不变,只做重组 + 换皮 + 加分隔条。

## 目标

1. 把 640 行的 `main.js` 拆成职责单一的 ES6 模块。
2. 三个板块(Graph / State / Log)之间的分割线可拖拽调整大小。
3. 图中 `__start__` / `__end__` 用不同形状区分。
4. 整体视觉走「开发者工具高级感」(近黑暗色),去掉所有 emoji 图标。

## 1. 模块拆分(原生 ES6 module,`index.html` 已是 `type="module"`)

| 文件 | 职责 | 依赖 |
|---|---|---|
| `state.js` | 共享可变状态(`graphData/mode/totals/replayTimeline/nodeDurations/flaggedAnomalies`)+ 常量 | 无 |
| `icons.js` | 内联 SVG 图标字符串(clock/hash/coin/warning/chevron/play…) | 无 |
| `graph.js` | 布局、画节点/边、active/completed/error、热力、start/end 形状 | state, icons |
| `inspector.js` | state JSON、三色 delta、错误/traceback、首次异常检测 | state, icons |
| `replay.js` | run 列表、时间轴、时间旅行、键盘左右键 | state, graph, inspector |
| `panels.js` | 三块的可拖拽分隔条 + 尺寸 localStorage 持久化 | 无 |
| `main.js` | 入口:建 WS、事件分发、初始化、装配各模块 | 以上全部 |

每文件约 80–150 行,单一职责、可独立读懂、通过明确接口通信。

## 2. 布局与可拖拽分隔条

- 结构:`Graph(左) | [State(上) / Log(下)](右)`。
- 两条分隔条(= 板块之间的分割线):
  - 竖线:拖动改变 图 / 右栏 宽度。
  - 横线:拖动改变 State / Log 高度。
- 实现:原生 `pointerdown/move/up`,无库;hover 高亮 + `cursor: col-resize/row-resize`;设最小尺寸防止拖没。
- 尺寸写入 `localStorage`,刷新后保持。
- 错误/traceback 不再单独占块,改为 State 面板内、报错时出现的可折叠红色区。

## 3. 视觉语言(design tokens,`:root` 变量)

- 背景层次:app `#0a0b0e` → 面板 `#101216` → 卡片/输入 `#16181e`;描边 `#23262e`(克制)。
- 文字:主 `#e6e8eb` / 次 `#8b909a` / 弱 `#5a606b`。
- 单一强调色:靛蓝 `#7c83ff`(active);语义色降饱和:完成 `#34d399`、错误 `#f87171`、改动/异常 `#fbbf24`。
- 字体:UI 用系统栈;数据/JSON/数字用等宽(`ui-monospace, SF Mono…`)。字阶更小更紧、留白更多。
- 层次:厚重发光阴影 → 1px 描边 + 极淡阴影;仅 active 节点保留轻微辉光。
- 去 emoji:汇总条 / 日志 / 时间轴 / run 选择器 / 错误标题全部换成 1.5px 描边内联 SVG;日志行首用小色点表状态。

## 4. start / end 节点

- 中间业务节点:仍是圆角卡片(耗时/token 叠加 + 热力)。
- `__start__`:绿色小实心圆(入口点),下方小字 `START`。
- `__end__`:双环终止符(空心带环),下方小字 `END`。
- start/end 不画卡片、不参与热力;布局算法不变,仅该位置换绘制方式。

## 5. 明确不动

- 不碰后端、事件协议、`langgraph_visualizer/` client 包。
- 不引入框架/构建/外部资源。
- 回放 / diff / 错误 / 热力等功能行为不变。

## 验收(浏览器内逐项截图)

- [ ] 三块布局正确,拖竖线改图/右栏宽度、拖横线改 State/Log 高度;刷新后尺寸保持。
- [ ] `__start__` 绿点、`__end__` 双环,中间节点仍是卡片。
- [ ] 全站无 emoji,改为 SVG 图标;暗色高级感配色生效。
- [ ] 实时高亮、三色 delta、错误红节点+traceback、首次异常、回放/时间旅行/热力/汇总条 —— 全部行为不变。
- [ ] 页面零外部请求(仅 127.0.0.1)。
