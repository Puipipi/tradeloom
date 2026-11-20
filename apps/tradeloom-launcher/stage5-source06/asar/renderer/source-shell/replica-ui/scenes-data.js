/* 由 scenes.json 同步生成 —— file:// 下使用本地内联布局数据 */
window.__SCENES__ = {
  "version": 1,
  "note": "织贸工作台五场景布局。业务页面与助手角色按当前桌面配置绑定；缺少配置时显示不可用状态，不创建会话。",
  "scenes": [
    {
      "id": "center",
      "name": "工作总览",
      "description": "总览主区、文件、预览与中心助手。",
      "cols": 4,
      "rows": 4,
      "panels": [
        {
          "id": "overview",
          "title": "总览",
          "type": "doc",
          "path": "/home",
          "col": 1,
          "row": 1,
          "w": 3,
          "h": 2
        },
        {
          "id": "files",
          "title": "文件",
          "type": "files",
          "path": "/artifacts#files",
          "col": 4,
          "row": 1,
          "w": 1,
          "h": 2
        },
        {
          "id": "preview",
          "title": "预览",
          "type": "preview",
          "path": "/artifacts#preview",
          "col": 1,
          "row": 3,
          "w": 1,
          "h": 2
        },
        {
          "id": "center-chat",
          "title": "🔒 中心助手",
          "type": "chat",
          "roleId": "center",
          "col": 2,
          "row": 3,
          "w": 3,
          "h": 2
        }
      ]
    },
    {
      "id": "products",
      "name": "商品",
      "description": "商品主区、文件、预览与商品助手。",
      "cols": 4,
      "rows": 4,
      "panels": [
        {
          "id": "products-main",
          "title": "商品",
          "type": "doc",
          "path": "/products",
          "col": 1,
          "row": 1,
          "w": 3,
          "h": 2
        },
        {
          "id": "files",
          "title": "文件",
          "type": "files",
          "path": "/artifacts#files",
          "col": 4,
          "row": 1,
          "w": 1,
          "h": 2
        },
        {
          "id": "preview",
          "title": "预览",
          "type": "preview",
          "path": "/artifacts#preview",
          "col": 1,
          "row": 3,
          "w": 1,
          "h": 2
        },
        {
          "id": "product-chat",
          "title": "🔒 商品助手",
          "type": "chat",
          "roleId": "product",
          "col": 2,
          "row": 3,
          "w": 3,
          "h": 2
        }
      ]
    },
    {
      "id": "agent-center",
      "name": "工作流",
      "description": "工作流画布主区、文件、预览与中心助手。",
      "cols": 4,
      "rows": 4,
      "panels": [
        {
          "id": "workflow-plan",
          "title": "业务计划",
          "closedByDefault": true,
          "type": "doc",
          "path": "/agent-center",
          "hostPanelId": "business-plan",
          "col": 1,
          "row": 1,
          "w": 1,
          "h": 2
        },
        {
          "id": "workflow-main",
          "title": "工作流画布",
          "type": "canvas",
          "path": "/agent-center",
          "col": 2,
          "row": 1,
          "w": 2,
          "h": 2,
          "standaloneCanvas": true,
          "hostPanelId": "business-main"
        },
        {
          "id": "files",
          "title": "文件",
          "type": "files",
          "path": "/artifacts#files",
          "col": 4,
          "row": 1,
          "w": 1,
          "h": 2
        },
        {
          "id": "preview",
          "title": "预览",
          "type": "preview",
          "path": "/artifacts#preview",
          "col": 1,
          "row": 3,
          "w": 1,
          "h": 2
        },
        {
          "id": "workflow-chat",
          "title": "🔒 中心助手",
          "type": "chat",
          "roleId": "center",
          "col": 2,
          "row": 3,
          "w": 3,
          "h": 2
        }
      ]
    },
    {
      "id": "deliverables",
      "name": "资料与交付",
      "description": "交付物主区、文件、预览与交付助手。",
      "cols": 4,
      "rows": 4,
      "panels": [
        {
          "id": "deliverables-main",
          "title": "交付物",
          "type": "doc",
          "path": "/artifacts#deliverables",
          "col": 1,
          "row": 1,
          "w": 3,
          "h": 2,
          "tabs": [
            "文件",
            "来源资料",
            "交付物",
            "版本"
          ],
          "activeTab": "交付物"
        },
        {
          "id": "files",
          "title": "文件",
          "type": "files",
          "path": "/artifacts#files",
          "col": 4,
          "row": 1,
          "w": 1,
          "h": 2
        },
        {
          "id": "preview",
          "title": "预览",
          "type": "preview",
          "path": "/artifacts#preview",
          "col": 1,
          "row": 3,
          "w": 1,
          "h": 2
        },
        {
          "id": "deliverables-chat",
          "title": "🔒 交付助手",
          "type": "chat",
          "roleId": "delivery",
          "col": 2,
          "row": 3,
          "w": 3,
          "h": 2
        }
      ]
    },
    {
      "id": "runs",
      "name": "运行记录",
      "description": "运行记录主区、任务、资料与中心助手。",
      "cols": 4,
      "rows": 4,
      "panels": [
        {
          "id": "runs-main",
          "title": "运行记录",
          "type": "log",
          "path": "/runs",
          "col": 1,
          "row": 1,
          "w": 3,
          "h": 2
        },
        {
          "id": "tasks",
          "hostPanelId": "auxiliary",
          "title": "任务",
          "type": "doc",
          "path": "/agent-center",
          "col": 4,
          "row": 1,
          "w": 1,
          "h": 2
        },
        {
          "id": "reference-material",
          "hostPanelId": "reference",
          "title": "资料",
          "type": "doc",
          "path": "/artifacts",
          "col": 1,
          "row": 3,
          "w": 1,
          "h": 2
        },
        {
          "id": "runs-chat",
          "title": "🔒 中心助手",
          "type": "chat",
          "roleId": "center",
          "col": 2,
          "row": 3,
          "w": 3,
          "h": 2
        }
      ]
    }
  ]
};
