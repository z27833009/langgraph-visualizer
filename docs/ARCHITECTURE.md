# 架构参考 (ARCHITECTURE)

> 这是项目的**稳定契约**文档。事件协议、数据流、目录结构变了再改这里。
> 「下一步做什么」看 `docs/IMPLEMENTATION_PLAN.md`,不要写进这里。

## 数据流

```
你的 LangGraph agent
   │  watch(compiled_graph)  → 自动挂 callback + 取结构
   ▼
client (langgraph_visualizer/)  ──POST /event──►  FastAPI 后端 (backend/main.py)
                                                      │  ① 自动算 state diff
                                                      │  ② 落库 SQLite
                                                      │  ③ WebSocket 广播
                                                      ▼
                                              前端 (frontend/, 原生 JS+SVG)
                                              实时高亮 / 状态面板 / 时间轴回放
```

要点:
- client 与 agent 同进程,**只负责采集和发送**,后端没起时静默降级。
- 所有"计算"(diff、汇总、持久化)集中在后端,保证单一事实源。
- 前端是纯展示层,既能吃实时 WebSocket,也能从 REST 拉历史 run 回放。

## 事件协议 (Event Protocol) —— 前后端与 client 的唯一契约

所有事件统一为以下结构 (`backend/main.py` 的 `GraphEvent`):

```python
event_type: str          # "graph_init" | "node_start" | "node_end" | "node_error"
run_id: str              # 一次完整运行的 uuid (分组/回放的主键)
step: int                # 该 run 内单调递增的步号
node_name: str
ts: float                # 事件时间戳 (epoch seconds)
duration_ms: float|None  # node_end 时填
state_delta: dict        # node_end:本步改了哪些 key (后端自动算,client 不必传)
full_state: dict         # node_end:该步之后的完整 state
tokens: dict|None        # {"input","output","total"}
cost_usd: float|None
error: dict|None         # {"type","message","traceback"} (node_error)
structure: dict|None      # graph_init:{"nodes":[{"id","label"}], "links":[{"source","target"}]}
```

升级协议时**保持向后兼容**:新增字段给默认值,前端对缺失字段要优雅处理。

## 目录结构

```
langgraph-visualizer/
├── CLAUDE.md                  # 项目总纲 (每次必读,保持精简)
├── docs/
│   ├── ARCHITECTURE.md        # 本文件:稳定契约 (协议/数据流/目录)
│   └── IMPLEMENTATION_PLAN.md # 分阶段路线图与任务 (随进度更新)
├── backend/
│   ├── main.py                # FastAPI:/event 接收、/ws 广播、托管前端
│   └── requirements.txt
├── frontend/
│   ├── index.html
│   └── main.js                # 原生 JS + SVG 可视化
├── langgraph_visualizer/      # [Phase 0 新增] client 包
│   ├── __init__.py            # 暴露 watch()
│   ├── tracer.py              # 结构提取 + VisualizerCallbackHandler
│   └── client.py              # 异步 HTTP 发送器 (降级安全)
├── example_agent.py           # [Phase 0 改] 真实可跑的小 LangGraph 示例
├── pyproject.toml             # uv 管理
└── visualizer.db              # [Phase 2 新增] SQLite,本地,已 gitignore
```

## 关键技术决策记录

- **为什么 callback + stream 两条路并用**:callback 拿 timing/token/error 干净,但 LangGraph 节点级完整 state 用 `stream(stream_mode="values")` 更可靠。两者用同一 `run_id` 关联。
- **为什么 diff 放后端**:单一事实源,client 保持极薄,前端纯展示。
- **为什么坚持原生 JS**:零构建、零依赖、易嵌入,符合"本地/轻量"定位。
