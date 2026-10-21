# Workbench Shell Implementation Plan

> 实现栈更新（2026-10-19）：本计划保留首版实施过程；正式工作台已迁移为 Django + templates + PostgreSQL，FastAPI/Vue/SQLite 主流程停用。当前运行说明以 README 和 architecture 为准。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 构建一个真实可运行的 TradeLoom 工作台骨架，打通演示/CSV 导入、产品资料确认和 UTF-8 CSV 导出，并建立可扩展的多 Agent 接口。

**Architecture:** Vue 3 前端通过 HTTP 调用 FastAPI；FastAPI 使用 SQLite 持久化任务、产品和文件引用。产品资料能力由本地确定性执行器实现，其他能力只登记描述并在调用时返回明确错误。AgentArts 只保留适配边界，当前界面和文档明确标记演示模式。

**Tech Stack:** Vue 3、TypeScript、Vite、Python 3、FastAPI、SQLite、pytest、Playwright。

**Spec:** `docs/specs/2026-10-18-workbench-shell.md`

## Global Constraints

- 基线提交：`8799523b562325133492114c6cc403043e9dfda9`。
- 分支：`feature/workbench-shell`。
- 默认地址：后端 `localhost:8000`，前端 `localhost:5173`；不 kill 未知进程。
- 运行数据：`data/runtime/`；Python 环境：`backend/.venv/`；前端依赖：`frontend/node_modules/`。三者不提交。
- 产品必填字段：`sku`、`name`、`category`、`material`、`size`、`color`、`image_filename`。
- 图片只按文件名去扩展名后与货号精确匹配，不做视觉识别。
- `image_filename` 是只读派生字段；货号变化时重新匹配，API 拒绝手工改写。
- 询报价与目录备样只登记为未接入能力，不生成占位成果。
- 不修改 `data/raw/`、`data/private/`、既有设计文档、既有脚本或父级 ICT 仓库。
- 每个新增业务行为必须先有失败的自动化测试。

---

### Task 1: 后端契约失败用例

**Files:**
- Create: `backend/requirements.txt`
- Create: `backend/tests/conftest.py`
- Create: `backend/tests/test_workbench_api.py`
- Create: `backend/tests/test_agent_registry.py`

**Interfaces:**
- Consumes: `create_app(data_dir: Path) -> FastAPI`。
- Produces: 测试期望的任务、产品、Agent API 契约。

- [ ] **Step 1:** 写一个使用临时目录和真实 SQLite 的 app fixture，并写六个行为测试：

```python
def test_export_requires_confirmation(client):
    task = client.post("/api/tasks/demo").json()
    response = client.get(f"/api/tasks/{task['id']}/export.csv")
    assert response.status_code == 409

def test_missing_field_blocks_confirmation(client):
    task = client.post("/api/tasks/demo").json()
    response = client.post(f"/api/tasks/{task['id']}/confirm")
    assert response.status_code == 409
    assert "材质" in response.json()["detail"]

def test_edit_confirm_export_csv(client):
    task = client.post("/api/tasks/demo").json()
    product = next(item for item in task["products"] if item["missing_fields"])
    client.patch(f"/api/products/{product['id']}", json={"material": "缎面织物"})
    assert client.post(f"/api/tasks/{task['id']}/confirm").status_code == 200
    response = client.get(f"/api/tasks/{task['id']}/export.csv")
    assert response.status_code == 200
    assert "DEMO-002,装饰蝴蝶结 香槟金,蝴蝶结,缎面织物,8cm,香槟金,DEMO-002.svg" in response.text

def test_task_survives_new_app_instance(tmp_path):
    first = TestClient(create_app(tmp_path))
    task_id = first.post("/api/tasks/demo").json()["id"]
    second = TestClient(create_app(tmp_path))
    assert second.get(f"/api/tasks/{task_id}").status_code == 200

def test_unimplemented_agent_is_explicit(client):
    task = client.post("/api/tasks/demo").json()
    response = client.post(f"/api/tasks/{task['id']}/agents/quotation")
    assert response.status_code == 409
    assert "尚未接入" in response.json()["detail"]

def test_csv_upload_matches_image_only_by_exact_sku_filename(client):
    response = client.post(
        "/api/tasks",
        data={"title": "上传测试"},
        files={
            "products_csv": (
                "products.csv",
                "sku,name,category,material,size,color,image_filename\n"
                "UP-001,上传样品,家居,陶,10cm,白,UP-001.png\n",
                "text/csv",
            ),
            "images": ("UP-001-extra.png", b"not-an-image", "image/png"),
        },
    )
    task = response.json()
    assert task["products"][0]["image_url"] is None
    assert "图片" in task["products"][0]["missing_fields"]
```

- [ ] **Step 2:** 写 registry 测试，验证三个能力可见、仅产品能力有执行器、未实现能力错误含能力名称：

```python
def test_registry_exposes_three_capabilities():
    registry = build_default_registry()
    assert [item.id for item in registry.list_capabilities()] == [
        "product_profile", "quotation", "catalog_package"
    ]

def test_registry_rejects_unimplemented_capability():
    registry = build_default_registry()
    with pytest.raises(CapabilityUnavailableError, match="目录备样"):
        asyncio.run(registry.dispatch(request_for("catalog_package")))
```

- [ ] **Step 3:** 在 `backend/.venv` 安装独立依赖后运行：

```powershell
backend\.venv\Scripts\python.exe -m pytest backend\tests -q
```

Expected RED：导入 `app.main` 或 `app.agents` 失败，证明应用契约尚不存在。

### Task 2: SQLite 工作台与 Agent 接口

**Files:**
- Create: `backend/app/__init__.py`
- Create: `backend/app/domain.py`
- Create: `backend/app/database.py`
- Create: `backend/app/workbench.py`
- Create: `backend/app/agents/__init__.py`
- Create: `backend/app/agents/contracts.py`
- Create: `backend/app/agents/registry.py`
- Create: `backend/app/agents/local.py`
- Create: `backend/app/main.py`

**Interfaces:**
- Produces: `create_app(data_dir)`, `WorkbenchService`, `AgentRegistry`, `build_default_registry()`.
- `WorkbenchService.create_demo_task()` 返回含产品和缺项的任务快照。
- `WorkbenchService.update_product()`、`confirm_task()`、`export_csv()` 实现状态约束。
- `AgentResult` 字段固定为 `status`、`output`、`pending_items`、`artifact_refs`。

- [ ] **Step 1:** 实现 SQLite schema、事务和 app 工厂，使重启 fixture 使用同一数据库路径。
- [ ] **Step 2:** 实现 demo 数据：罗纹丝带与装饰蝴蝶结两条标记为演示的产品，其中 `DEMO-002` 缺少材质；图片引用为 `DEMO-001.svg`、`DEMO-002.svg`。
- [ ] **Step 3:** 实现产品资料执行器、能力注册与 409 错误映射。
- [ ] **Step 4:** 实现 CSV multipart 导入、精确文件匹配、产品更新、确认和 UTF-8 CSV 导出。
- [ ] **Step 4a:** 货号更新时按当前任务图片重新匹配；无匹配则清空图片关联、列入“图片”缺项并阻止确认。`image_filename` 不接受 PATCH 写入。
- [ ] **Step 5:** 运行 `backend\.venv\Scripts\python.exe -m pytest backend\tests -q`，Expected GREEN：全部通过。

### Task 3: 浏览器 smoke 失败用例

**Files:**
- Create: `e2e/workbench-smoke.cjs`

**Interfaces:**
- Consumes: `http://localhost:5173`、`frontend/node_modules/playwright`；本机验证时可复用既有 `tools/pw` 浏览器缓存。
- Produces: 真实页面端到端验收和下载后的 CSV 内容断言。

- [ ] **Step 1:** 写 Playwright 脚本：打开页面、点击“加载演示任务”、展开缺项产品、编辑材质、保存、确认、等待导出按钮可用、下载 CSV。
- [ ] **Step 2:** 校验导出内容包含 `DEMO-002` 和编辑后的材质，再刷新页面确认任务仍为“已确认”，并把任务详情截图保存到 `data/runtime/workbench-preview.png`。
- [ ] **Step 3:** 在前端尚未实现时运行脚本，Expected RED：页面不存在或演示按钮不可用。

### Task 4: Vue 工作台界面

**Files:**
- Create: `frontend/package.json`
- Create: `frontend/tsconfig.json`
- Create: `frontend/vite.config.ts`
- Create: `frontend/index.html`
- Create: `frontend/src/main.ts`
- Create: `frontend/src/App.vue`
- Create: `frontend/src/api.ts`
- Create: `frontend/src/types.ts`
- Create: `frontend/src/styles.css`
- Create: `frontend/src/components/TaskList.vue`
- Create: `frontend/src/components/NewTaskPanel.vue`
- Create: `frontend/src/components/TaskDetail.vue`
- Create: `frontend/src/components/AgentPanel.vue`

**Interfaces:**
- 侧栏视图：`tasks`、`new`、`agents`，三项均可切换。
- API 类型与后端响应字段一致；任务详情刷新后仍从后端加载。
- 产品编辑保存后重新读取任务；有缺项时确认按钮 disabled 并显示原因。

- [ ] **Step 1:** 创建 Vite/Vue/TypeScript 配置与 API 类型。
- [ ] **Step 1a:** 在开发依赖中加入 `playwright`；文档提供 `npm install` 与 `npx playwright install chromium`，避免依赖父目录的私有模块路径。
- [ ] **Step 2:** 实现深靛蓝侧栏、浅灰蓝内容区、青绿状态色和响应式布局。
- [ ] **Step 3:** 实现任务列表、演示任务、上传表单、产品资料与图片对照、编辑确认、导出和 Agent 能力页。
- [ ] **Step 3a:** 任务加载响应落地前校验当前 hash 与请求序号；`openTask` 只切换一次路由，避免重复请求和过期响应覆盖 Agent 页。
- [ ] **Step 4:** 为表单添加 label，为按钮添加 busy/disabled 状态，提供错误、空状态和 `focus-visible` 样式。
- [ ] **Step 5:** 运行 `npm run build`，Expected GREEN：`vue-tsc` 与 Vite 构建均成功。

### Task 4A: 协作关系图与真实 Agent 结果

**Files:**
- Modify: `frontend/src/components/AgentPanel.vue`
- Modify: `frontend/src/api.ts`
- Modify: `frontend/src/types.ts`
- Modify: `frontend/src/App.vue`
- Modify: `frontend/src/styles.css`
- Modify: `e2e/workbench-smoke.cjs`
- Modify: `docs/architecture.md`

**Interfaces:**
- Consumes: `POST /api/tasks/{task_id}/agents/{capability_id}` 和 `GET /api/agents`。
- Produces: 可点选的产品资料、询报价、目录备样、共享任务资料节点，以及真实 `AgentResult` 面板。

- [ ] **Step 1:** 用原生 HTML/CSS/SVG 画关系图；实线表示当前本地产品资料能力，虚线表示规划接口。
- [ ] **Step 2:** 点击节点显示输入、输出、实现状态；未接入节点明确写“未接入，不会执行”。
- [ ] **Step 3:** 选择真实任务后，仅对 `product_profile` 调用现有 dispatch，展示 status、产品数、待确认项和结构化 output。
- [ ] **Step 4:** 在浏览器 smoke 中断言节点详情、未接入标记和一次真实产品资料调用；不增加聊天、自治或图编辑器。
- [ ] **Step 5:** 重新运行前端构建和完整 smoke。

### Task 4B: Agent 运行记录持久化

**Files:**
- Modify: `backend/app/domain.py`
- Modify: `backend/app/database.py`
- Modify: `backend/app/workbench.py`
- Modify: `backend/app/main.py`
- Modify: `backend/tests/test_workbench_api.py`
- Modify: `frontend/src/types.ts`
- Modify: `frontend/src/api.ts`
- Modify: `frontend/src/components/AgentPanel.vue`
- Modify: `e2e/workbench-smoke.cjs`
- Modify: `docs/architecture.md`
- Modify: `README.md`

**Interfaces:**
- Produces: `GET /api/tasks/{task_id}/runs`，按任务查询运行记录。
- Run 字段：`run_id`、`task_id`、`capability_id`、`status`、`started_at`、`finished_at`、`result`、`error`。

- [ ] **Step 1:** 写 RED 测试，验证产品检查记录在新 app 实例中持久化，未接入能力记录为 `unavailable`。
- [ ] **Step 2:** 增加 `agent_runs` 表与 service 方法；dispatch 成功、未实现和异常路径均写真实终态。
- [ ] **Step 3:** 实现按任务查询接口，前端选择任务时读取运行历史，执行后刷新历史。
- [ ] **Step 4:** 将所选任务 ID 保存在 `#agents/<task_id>`，加载任务后校验并恢复；浏览器 smoke 在刷新后断言同一 task_id 和同一完整 run_id 的记录仍可见。
- [ ] **Step 5:** 应用工厂导入保持无副作用，uvicorn 使用 `app.asgi:app`；切换任务时用请求序号丢弃旧 dispatch/runs 结果。

### Task 5: 样例、文档与启动说明

**Files:**
- Create: `data/samples/products.csv`
- Create: `data/samples/images/DEMO-001.svg`
- Create: `data/samples/images/DEMO-002.svg`
- Create: `docs/architecture.md`
- Modify: `README.md`
- Modify: `.gitignore`

**Interfaces:**
- CSV 表头固定为 `sku,name,category,material,size,color,image_filename`。
- README 提供 PowerShell 从零安装、双窗口启动、默认 URL、演示步骤、测试命令和限制。

- [ ] **Step 1:** 添加不含真实企业资料的小型 CSV 与两张明确标注“演示图片”的 SVG。
- [ ] **Step 2:** 记录前端→API→工作台服务→Agent registry→SQLite 数据流，以及 AgentArts 适配位置和待验证边界。
- [ ] **Step 3:** 更新 README 当前状态与启动说明，保留原有设计、研究和脚本。
- [ ] **Step 4:** 添加 `data/runtime/` 忽略规则；确认 `frontend/node_modules/`、`backend/.venv/` 已被现有规则覆盖。

### Task 6: 完整验证与聚焦提交

**Files:**
- Verify: all changed files

**Interfaces:**
- Produces: RED/GREEN、构建、HTTP、浏览器、Git 审计证据。

- [ ] **Step 1:** 运行 `git diff --check`。
- [ ] **Step 2:** 运行后端测试和前端构建。
- [ ] **Step 3:** 启动后端与前端，使用 HTTP 验证健康检查、演示任务、编辑确认和导出。
- [ ] **Step 4:** 运行真实 Playwright smoke，保存 CSV 到 `data/runtime/e2e-export.csv`，核对表头与内容，并保存任务详情截图到 `data/runtime/workbench-preview.png`。
- [ ] **Step 5:** 只暂存本次新增/修改文件，提交本地 commit；不 push、不创建远程。
- [ ] **Step 6:** 报告分支、状态、提交、启动 URL、所启动 PID 和截图绝对路径；保留工作台供父方视觉审计。
