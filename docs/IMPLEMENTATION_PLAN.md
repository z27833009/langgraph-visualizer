# 实施计划：LangGraph Local Visualizer 升级

> 给 Claude Code 的说明：这是一份分阶段的实施计划。请**按 Phase 顺序**实现，每个 Phase 结束后都应该是可独立运行、可验收的。每个任务都给了验收标准（Acceptance），实现完请自检是否满足。遇到 LangGraph / LangChain 的具体 API 不确定时，以当前安装版本的实际行为为准，可以先写个最小脚本验证再集成。

## 0. 项目现状（实现前请先读一遍这几个文件）

- `backend/main.py`：FastAPI。`POST /event` 接收 `GraphEvent`，通过 WebSocket `/ws` 广播给前端。事件类型目前只有 `graph_init | node_start | node_end`。同时托管前端静态文件。
- `frontend/main.js`：原生 JS + SVG。`initGraph()` 用 BFS 分层布局画节点和边，`setActiveNode/setCompletedNode` 做高亮，`updateState()` 显示 state（**直接覆盖，无历史**）。
- `example_agent.py`：**目前是一段假模拟**——手动 `send_event` + `time.sleep`，节点/边写死，`state_delta` 手填。**没有真正连接 LangGraph。**
- `pyproject.toml` + `uv.lock`：用 uv 管理依赖。

## 1. 目标与定位（一句话，别偏离）

做一个**本地运行、隐私优先、不上传任何数据、能告诉你"哪一步错了"的 LangGraph 调试可视化器**。差异化对手：LangSmith（要上云）、LangGraph Studio（闭源）。我们的护城河 = 本地 + 隐私 + 根因定位。

## 2. 全局约束（Non-negotiable）

- **本地优先**：所有数据只存在本机，绝不发往任何外部服务。不加任何 telemetry / analytics。
- **前端保持轻量**：继续用原生 JS + SVG/CSS，**不要引入 React/Vue 等框架**。可以用极小的工具库（如布局算法），但能不加就不加。
- **后端继续用 FastAPI + uv**，Python 3.11+（LangGraph 要求）。
- **向后兼容**：升级事件协议时，旧的三种事件类型行为不能破坏（前端要能优雅处理缺失字段）。
- **零侵入集成**：用户接入只需「一行 wrap」或「挂一个 callback」，不需要改他们的图定义。

## 3. 统一事件协议（核心契约 —— 先把这个定下来）

把 `backend/main.py` 里的 `GraphEvent` 升级成下面的结构。前端和 client 都按它走。

```python
class GraphEvent(BaseModel):
    event_type: str          # "graph_init" | "node_start" | "node_end" | "node_error"
    run_id: str              # 新增：一次完整运行的 uuid，用于分组/回放
    step: int = 0            # 新增：该 run 内单调递增的步号
    node_name: str = ""
    ts: float = 0.0          # 新增：事件时间戳 (epoch seconds)
    duration_ms: float | None = None   # 新增：node_end 时填，节点耗时
    state_delta: dict = {}   # node_end：本步改了哪些 key（后端自动算，见 Phase 1）
    full_state: dict = {}    # node_end：该步之后的完整 state
    tokens: dict | None = None         # 新增：{"input":int,"output":int,"total":int}
    cost_usd: float | None = None      # 新增：本步 LLM 成本
    error: dict | None = None          # 新增：{"type","message","traceback"} (node_error)
    structure: dict | None = None      # graph_init：{"nodes":[...], "links":[...]}
```

---

## Phase 0（P0）— 真正接上 LangGraph【最高优先级，没有这个一切免谈】

**问题**：现在 `example_agent.py` 是假模拟，没人能把工具指向自己真实的 agent。

### 任务 0.1：新建 client 包 `langgraph_visualizer/`

新建目录 `langgraph_visualizer/`，包含 `__init__.py`、`tracer.py`、`client.py`。
- `client.py`：一个轻量 HTTP 发送器，`post_event(event_dict)` → `POST {BACKEND_URL}/event`。后端没起时**静默降级**（打印一行 warning，不抛异常，不阻塞用户的 agent）。建议用后台线程 / 队列异步发送，避免拖慢 agent。

### 任务 0.2：结构自动提取（不再手敲 nodes/links）

在 `tracer.py` 里实现：从已编译的图自动取结构。
```python
def extract_structure(compiled_graph) -> dict:
    g = compiled_graph.get_graph()
    nodes = [{"id": n.id, "label": getattr(n, "name", n.id)} for n in g.nodes.values()]
    links = [{"source": e.source, "target": e.target} for e in g.edges]
    return {"nodes": nodes, "links": links}
```
（注意核对当前 LangGraph 版本里 `get_graph()` 返回对象的字段名，可能是 `.nodes` dict / `.edges` list，以实测为准。）

### 任务 0.3：执行期事件采集 —— `VisualizerCallbackHandler`

在 `tracer.py` 里实现一个继承 `langchain_core.callbacks.BaseCallbackHandler` 的 handler，挂到 LangGraph 运行的 config 上即可自动采集：

- `on_chain_start`：从 `metadata.get("langgraph_node")` 拿当前节点名（LangGraph 会注入），记录 start 时间，发 `node_start`。
- `on_chain_end`：算 `duration_ms`，发 `node_end`，带上该节点输出。
- `on_llm_end`：从 response 的 usage（`usage_metadata` / `response_metadata`）累计 token，按当前节点归集，估算 `cost_usd`（成本表先用一个可配置的 dict，找不到模型就置 null）。
- `on_chain_error` / `on_tool_error` / `on_llm_error`：捕获异常，`traceback.format_exc()`，发 `node_error`。

> 说明：节点级 `full_state` 用 callback 不一定拿得全。**推荐**额外提供一个基于 `stream` 的封装作为获取完整 state 的来源（见 0.4），callback 主要负责 timing / token / error。两者用同一个 `run_id` 关联。

### 任务 0.4：一行接入 API

在 `tracer.py` 暴露一个高层入口，让用户最省事：
```python
from langgraph_visualizer import watch

graph = watch(builder.compile())   # 自动发 graph_init + 挂 callback
graph.invoke(inputs)               # 正常调用，事件自动流到后端
```
`watch(compiled_graph)` 要做的：(1) 生成 `run_id`；(2) 调 `extract_structure` 发 `graph_init`；(3) 返回一个包装对象，其 `invoke/stream/ainvoke` 自动注入 `VisualizerCallbackHandler`，并通过 `stream(stream_mode="values")` 在每步采集 `full_state`。

### 任务 0.5：把 `example_agent.py` 换成真 agent

删掉手写模拟。写一个**真实、能跑**的小 LangGraph：一个 supervisor + 一个调用 LLM 的节点 + 一个工具节点 + 一条会回环的边（体现 cycle），用 `watch()` 包起来跑。
- LLM 用环境变量配置（如 `OPENAI_API_KEY`），**拿不到 key 时降级成一个 fake LLM 节点**（返回固定文本),保证没有 key 也能演示。

### Phase 0 验收（每条都要可复现 + 有客观判据）
- [x] **结构自动**:`uv run backend/main.py` 后另开终端 `uv run example_agent.py`,打开 `http://127.0.0.1:8000/`,图中节点集合与 `compiled_graph.get_graph()` 返回的节点完全一致(代码里不存在任何手写的 nodes/links 字典)。
- [x] **实时高亮**:执行过程中节点按真实执行顺序依次进入 active → completed,带 cycle 的节点会二次点亮。
- [x] **协议字段齐全**:抓一条 `node_end` 事件(浏览器 Network 或后端日志),确认它带非空 `full_state`、非 None 的 `duration_ms`、合法 `run_id` 与单调递增的 `step`。这是 Phase 1/2 的数据前提,缺一不可。
- [x] **零手填**:`example_agent.py` 里没有任何 `send_event` / 手填 `state_delta` / 手写结构;接入只通过 `watch()`。
- [x] **降级安全**:**不**起后端,直接 `uv run example_agent.py`,agent 正常跑完并退出码 0,仅打印一行 warning(不抛异常、不卡住)。
- [x] **无 key 可演示**:不设 `OPENAI_API_KEY` 时,示例走 fake LLM 节点仍能完整跑完。
- [x] **单测通过**:`uv run pytest`(或等价命令)全绿,至少覆盖结构提取 + 事件序列化。

> **Phase 0 实测偏差(LangGraph 1.2.6 / langchain-core 1.4.8)**
> - `on_chain_end` 回调**不带** `metadata`(因此拿不到 `langgraph_node`)。改为按 langchain 的 `run_id` 关联 `on_chain_start`/`on_chain_end`,并用 tag `graph:step:N` 过滤出"真正的节点执行"(节点内部还会有 `seq:step:N` 的嵌套 run,也带 `langgraph_node`,必须排除)。
> - 因此 `node_end` 不在 callback 里发,而是由 `watch().invoke()` 的 `stream(stream_mode=["updates","values"])` 循环驱动:`updates` 给节点名,`values` 给 `full_state`,再用 callback 累积的 timing/token 充实事件。与计划"callback 管 timing/token/error、stream 管 full_state"的方向一致。
> - `run_id` 改为**每次 invoke 生成一个**(并在每次 invoke 开头补发 `graph_init`),为 Phase 2 的按 run 持久化/回放做准备。

---

## Phase 1（P1）— 根因定位：错误 + 自动 diff【核心差异化】

### 任务 1.1：错误可视化
- 后端：处理 `node_error` 事件并广播。
- 前端：收到 `node_error` → 把该节点标**红**（加 `.error` class，写对应 CSS）；右侧/底部展开一个可折叠的 traceback 面板;日志里红色记录一条。

### 任务 1.2：后端自动算 state diff（不再依赖 client 手填）
- 后端按 `run_id` 维护「上一步的 full_state」。收到 `node_end` 时，自动 diff 当前 `full_state` vs 上一步，算出 `state_delta`（哪些 key 新增/修改/删除）。
- diff 实现：可用 `deepdiff`，或手写一个递归 diff（够用就行）。结果写回事件的 `state_delta` 再广播。
- 前端 `updateState()`：把 delta 里变化的 key **高亮显示**（新增=绿、改动=黄、删除=红）。

### 任务 1.3：首次异常节点提示（轻量版根因）
- 前端维护「每个 state key 的值历史」。当某个 key 的值类型突变 / 变成 `None`/空 / 报错节点涉及的 key，在时间轴(见 Phase 2)或日志上标一个「⚠ 首次异常」标记，指向引入该变化的节点。
- MVP 可以做简单规则；不要过度设计成"智能根因分析"。

### Phase 1 验收（每条都要可复现 + 有客观判据）
- [ ] **错误可视化**:在 `example_agent.py` 提供一个可切换的"故意报错"模式(如 `RAISE_AT=web_tool` 环境变量),触发后前端该节点变红、可展开看到完整 traceback,日志有一条红色错误。
- [ ] **diff 自动**:`node_end` 事件的 `state_delta` 由**后端**填充;把 client 端任何手填 delta 的代码删掉后,前端的字段高亮仍正确(新增=绿、改动=黄、删除=红)。
- [ ] **diff 正确性**:diff 计算有单测覆盖,至少包含 新增 key、修改 key、删除 key、嵌套 dict 变化 四种 case,`uv run pytest` 全绿。
- [ ] **首次异常标记**:报错 run 里,前端能标出"⚠ 首次异常"并指向引入问题的节点。
- [ ] **不破坏 Phase 0**:重跑 Phase 0 的全部验收项仍通过(实时高亮、降级安全、协议字段齐全)。

---

## Phase 2（P2）— 成本/耗时叠加 + 持久化回放【从"实时高亮器"升级成"调试器"】

### 任务 2.1：节点级 耗时 / token / 成本 叠加
- 前端在每个节点卡片上显示 `duration_ms` 和 token 数;用颜色深浅做**热力**(越慢/越贵越深)。
- 加一个汇总条：本次 run 总耗时、总 token、总成本。

### 任务 2.2：SQLite 持久化
- 后端引入 SQLite（标准库 `sqlite3` 即可，保持零重依赖）。两张表：
  - `runs(run_id TEXT PK, started_at REAL, status TEXT, structure_json TEXT, total_tokens INT, total_cost REAL)`
  - `events(id INTEGER PK, run_id TEXT, step INT, event_type TEXT, node_name TEXT, ts REAL, duration_ms REAL, tokens_json TEXT, cost_usd REAL, state_json TEXT, delta_json TEXT, error_json TEXT)`
- 每个事件落库；run 结束更新 `runs` 汇总。
- DB 文件放项目本地（如 `./visualizer.db`），加进 `.gitignore`。

### 任务 2.3：回放 REST API
新增端点：
- `GET /runs` → 历史 run 列表（id、时间、状态、汇总）。
- `GET /runs/{run_id}` → 该 run 的结构 + 汇总。
- `GET /runs/{run_id}/events` → 按 step 排序的全部事件。

### 任务 2.4：前端回放 / 时间旅行
- 顶部加一个 **run 选择器**（下拉历史 run）。
- 加一条**时间轴滑块**：拖动到任意 step，图和 state 面板回到那一步的快照（state 来自 `state_json`）。这是"time travel"的核心体验。
- 加键盘左右键步进。

### 任务 2.5（可选，加分）：两次 run 对比
- 选两个 run，并排 diff：走的路径差异、同一节点的 state/耗时/成本差异。

### Phase 2 验收（每条都要可复现 + 有客观判据）
- [ ] **持久化**:跑完一次 run 后,`visualizer.db` 中 `runs` 多一行、`events` 有对应该 run 的全部步;`visualizer.db` 已在 `.gitignore` 中。
- [ ] **回放**:刷新 / 重开浏览器后,从 run 选择器选回历史 run,能完整复现(结构 + 每步状态),不依赖 WebSocket 实时流。
- [ ] **时间旅行**:拖时间轴或按左右方向键,图与 state 面板回到对应 step 的快照;首尾边界不报错。
- [ ] **热力**:节点卡片显示 `duration_ms` 与 token,最慢/最贵节点颜色明显更深;顶部汇总条显示总耗时/总 token/总成本。
- [ ] **REST 正确**:`GET /runs`、`GET /runs/{id}`、`GET /runs/{id}/events` 三个端点返回结构正确(events 按 step 升序)。
- [ ] **本地/隐私**:全程断网(或抓包确认)无任何对外请求;DB 仅在本机。
- [ ] **单测通过 + 不破坏前序**:`uv run pytest` 全绿;Phase 0 与 Phase 1 的实时模式与错误可视化重测仍正常。

---

## 4. 测试方式
- 每个 Phase 都用改造后的 `example_agent.py` 端到端验证（含一个正常 run、一个故意报错的 run）。
- 给 client 包写几个单测：结构提取、diff 计算、事件序列化。
- 用一个**带 cycle 的多节点图**测布局和回环边不乱。

## 5. 明确不要做的事
- 不要引入 React/前端框架，不要引入云服务/账号体系/telemetry。
- 不要做「智能根因分析」「LLM 自动诊断」这类大而虚的功能——先把确定性的 diff / 错误 / 回放做扎实。
- 不要为了支持任意编排框架而过度抽象;**先只把 LangGraph 这一条做到最好**。
- 不要破坏「一行接入」和「本地优先」这两条底线。

## 6. 建议的提交顺序
P0 全部 → 能在真 agent 上跑 → 提一个可用版本；再 P1（错误+diff）→ 再 P2（持久化+回放）。每个 Phase 独立可交付,别攒一个大 PR。
