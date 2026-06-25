# CLAUDE.md

> 本项目的总纲。**每次会话先读这个**,需要细节再按下面导航去 `docs/`。

## 这是什么

一个**本地运行、隐私优先、能告诉你"哪一步错了"的 LangGraph 调试可视化器**。
实时把 agent 的图结构、节点执行、状态变化画出来,并支持回放和根因定位。

差异化对手:LangSmith(要上云)、LangGraph Studio(闭源)。
**我们的护城河 = 本地 + 隐私 + 根因定位。** 任何改动都不能损害这三点。

## 核心原则 (不可妥协)

1. **本地优先**:数据只存本机,绝不发往外部服务,不加任何 telemetry。
2. **一行接入**:用户只需 `watch(graph)`,不改自己的图定义。
3. **前端轻量**:原生 JS + SVG/CSS,**不引入 React/Vue 等框架**。
4. **后端是唯一事实源**:diff / 汇总 / 持久化都在后端算,client 极薄,前端纯展示。
5. **先把 LangGraph 一条做到最好**,不为支持任意框架而过度抽象。
6. **做确定性的事**(diff / 错误 / 回放),不做"LLM 智能诊断"这类大而虚的功能。

## 技术栈

- 后端:Python 3.11+ / FastAPI / uvicorn / WebSocket;持久化用标准库 `sqlite3`。
- 前端:原生 HTML5 + ES6 模块 + SVG(无框架、无构建步骤)。
- client:LangChain `BaseCallbackHandler` + LangGraph `stream` / `get_graph()`。
- 包管理:**uv**(`uv run ...`)。

## 常用命令

```bash
uv run backend/main.py     # 起后端,访问 http://127.0.0.1:8000/
uv run example_agent.py    # 跑示例 agent,事件会流到可视化界面
```

## 开发方式

- **按 Phase 推进**:做完一个 Phase、跑通验收、人工确认后再做下一个,不要攒大 PR。
- 改动涉及事件字段时,先更新 `docs/ARCHITECTURE.md` 的协议,再改代码,保持前后端一致。
- 接 LangGraph 时如遇 API 与计划不符(版本差异),以实际安装版本行为为准,先写最小脚本验证。

## 文档导航 (分级)

- **`docs/ARCHITECTURE.md`** — 稳定契约:事件协议、数据流、目录结构、技术决策。改协议看这里。
- **`docs/IMPLEMENTATION_PLAN.md`** — 路线图:Phase 0/1/2 的具体任务、代码骨架、验收标准。**做什么、怎么做看这里。**
- **`docs/BACKLOG.md`** — 暂不做的方向及原因。**冒出计划外的新功能想法时,先去这里排队,不要直接塞进当前 Phase。**

## 当前进度

- [x] Phase 0:真正接上 LangGraph(结构自动提取 + callback 采集 + 一行 `watch()` + 真示例)
- [x] Phase 1:错误可视化 + 后端自动 state diff(根因定位)
- [ ] Phase 2:耗时/token/成本叠加 + SQLite 持久化 + 时间轴回放

> 完成一项就把对应 `[ ]` 勾上,并在 `docs/IMPLEMENTATION_PLAN.md` 里记录偏差。
