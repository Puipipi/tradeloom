"""把已写好的内容填进官方的《作品信息收集表》模板，生成一份可提交的 docx。

用法：
    tradeloom\\.venv\\Scripts\\python.exe tradeloom\\scripts\\fill_form.py

输入：competition/templates/【赛题2-模板1】…（本地权威模板，原样保留）
输出：competition/submissions/赛题2-作品信息收集表-TradeLoom-填写稿.docx
可用 TRADELOOM_COMPETITION_DIR 指向其他本地资料目录。

设计取舍：
- 只填空单元格，不动模板里的固定文案（赛题、应用领域、应用技术那几行是官方原文）。
- 字体沿用同行标题单元格的字体，避免填出来的字比模板大一号。
- 内容集中在下面的 FIELDS 里改；改完重跑即可，不用手动编辑 Word。
"""

from __future__ import annotations

import copy
import os
from pathlib import Path

import docx

ROOT = Path(__file__).resolve().parents[1]
COMPETITION = Path(
    os.environ.get("TRADELOOM_COMPETITION_DIR", ROOT.parent / "competition")
)
SRC = (
    COMPETITION
    / "templates"
    / "【赛题2-模板1】创新赛-作品信息收集表-学校-队名-队长姓名-手机号 （初赛阶段）.docx"
)
DST = COMPETITION / "submissions" / "赛题2-作品信息收集表-TradeLoom-填写稿.docx"

TBD = "（待填）"

# ---------------------------------------------------------------- 内容
FIELDS: dict[str, str] = {
    "学校名称": TBD,
    "队伍名称": "贸织队" + TBD,
    "队伍成员": (
        "指导老师：待填（1 人）\n"
        "队员：待填 / 待填\n"
        "说明：创新赛须 3 名学生 + 1 名指导教师，且来自同一所高校。"
    ),
    "队长联系电话": TBD,
    "队长联系邮箱": TBD,
    "作品名称": "TradeLoom 贸织 —— 工贸一体外贸企业的「展会作战室 + 报价陪跑」智能体",
    "作品介绍": (
        "广交会前十五天，一家二十人的工贸一体外贸企业里，样品要拍、图片要整理成印刷厂能用的格式、"
        "画册要排版、报价单要重算，全部压在老板一个人身上。这家企业没有 ERP、没有 CRM，"
        "价格底线、客户脾气、哪家供应商靠得住，全在一个人脑子里。\n"
        "TradeLoom（贸织）不是一个更会聊天的客服机器人，而是把「样品图 → 印刷级画册页 → 有依据的报价单」"
        "这条链路交给一个能自己跑完的智能体。它不认识这家公司，但它认识印刷厂的要求：CMYK、300ppi、"
        "3mm 出血、字体转曲、PDF/X-4；它也不替老板拍板，只给出报价区间、依据与风险提示——"
        "每一个数字都能点回到哪张成本表、哪一单历史成交。\n"
        "更关键的是，它把老板的每一次改价记下来，成为下一次的依据。一个原本只存在于老板脑子里的「度」，"
        "第一次变成可以被别人复核、可以被交接的东西。\n"
        "作品基于华为云 AgentArts 构建、编排与部署：三个智能体分工、一条主控工作流编排，"
        "知识库承接历史单据，效果用合格率、区间命中率等可量化指标验证。"
    ),
    "技术方案介绍": (
        "一、场景定义\n"
        "死线明确：展会前把样品图整理成可交付印刷厂的文件，并同步产出报价单。"
        "输入为 20 张样品原图 + 1 份价格表；输出为画册页 PDF（符合印刷厂规格）与报价单（含依据）。\n\n"
        "二、编排思路\n"
        "把「一次展会备展」拆成三段可独立验证的能力：认图与规格化、排版与交付、报价与依据。"
        "三段由一个主控工作流按用户意图分流，最后统一进人工确认环节，决策写入日志回流。\n\n"
        "三、工作流架构（AgentArts）\n"
        "ExpoWorkflow（主控）→ Curator（视觉与规格化）→ Composer（排版与交付）→ 规格校验器（不通过自动重排）\n"
        "ExpoWorkflow → Pricer（报价陪跑：知识库检索 + 成本拆解 + 区间与依据）→ 人工确认 → 决策日志\n"
        "AgentArts 组件映射：智能体与提示词用「智能体管理」；多步流程用「工作流编排画布」；"
        "图片处理/PDF 合成/成本计算用「代码节点」；外部能力用 HTTP 请求节点或插件。\n\n"
        "四、知识库 / 语料的构建方法\n"
        "语料分四类：历史报价单与成交单（脱敏后结构化）、成本表与工价表、印刷交付规格、客户画像字段。"
        "入库前统一做三件事：字段归一（品类/国家/数量/单价/付款方式）、单位统一（USD、件、kg）、"
        "敏感信息替换（客户名 → Customer-A）。检索侧用「品类 + 国家 + 数量区间」组合召回，"
        "每条召回结果保留来源单据编号，保证报价依据可点回原文。\n\n"
        "五、自定义 Skill / MCP：印刷规格校验器\n"
        "把「符合印刷厂要求」做成可执行判定，8 项逐条检查：色彩模式全 CMYK、图片 ≥300ppi、"
        "四边 3mm 出血、字体转曲或嵌入、PDF/X-4、总墨量 ≤300%、小字单黑 K100、页数为 4 的倍数。"
        "任一项不通过即返回结构化诊断，驱动 Composer 重排后复检。\n\n"
        "六、使用文档与操作指引\n"
        "三步：① 拖入样品图与原图；② 上传价格表，选择「做画册 / 报价 / 两个都要」；③ 确认并下载 PDF。"
        "仓库内附环境自检脚本（scripts/check_env.py），一条命令验证「字体 → PDF → CMYK」链路是否可用。\n\n"
        "七、效果指标（可量化）\n"
        "画册页合格率：20 张图逐项过校验表，目标 ≥90%；\n"
        "报价区间命中率：20 单历史回测，实际成交价落入建议区间，目标 ≥70%；\n"
        "依据可追溯率：抽查 10 条建议能否点回原始单据，目标 100%；\n"
        "单页耗时：从上传到出 PDF，目标 <90 秒。\n\n"
        "八、已知边界\n"
        "本阶段只做「样品图 → 画册页 → 报价单」一条链路；生产日报、供应商比价、现金流预测列入后续迭代，"
        "不作为本期交付承诺。"
    ),
    "作品展示": (
        "Demo 视频：待补（脚本见仓库 docs/specs 设计文档第三节，3 分钟内，含 AgentArts 画布镜头与一次失败重试）\n"
        "作品分享帖：待补（华为云开发者社区，按赛题建议的五段结构撰写）\n"
        "Demo 页面地址：待补（AgentArts 发布后填写）"
    ),
}


# ---------------------------------------------------------------- 行位
# 模板里「队伍成员」占两行（第 3 行是表头，第 4 行才填名字），
# 所以按行号定位，不按标签定位；标签只用来校验模板没被改过。
ROW_PLAN: dict[int, tuple[str, str]] = {
    1: ("学校名称", FIELDS["学校名称"]),
    2: ("队伍名称", FIELDS["队伍名称"]),
    4: ("队伍成员", FIELDS["队伍成员"]),
    5: ("队长联系电话", FIELDS["队长联系电话"]),
    6: ("队长联系邮箱", FIELDS["队长联系邮箱"]),
    10: ("作品名称", FIELDS["作品名称"]),
    13: ("作品介绍", FIELDS["作品介绍"]),
    14: ("技术方案介绍", FIELDS["技术方案介绍"]),
    15: ("作品展示", FIELDS["作品展示"]),
}


# ---------------------------------------------------------------- 填充
def clear_cell(cell) -> None:
    """清空单元格，但保留第一个段落对象。"""
    for para in cell.paragraphs[1:]:
        para._element.getparent().remove(para._element)
    first = cell.paragraphs[0]
    for run in list(first.runs):
        run._element.getparent().remove(run._element)


def font_of(cell):
    for para in cell.paragraphs:
        for run in para.runs:
            if run.font.name or run.font.size:
                return run.font
    return None


def set_cell(cell, text: str, ref_cell) -> None:
    ref_font = font_of(ref_cell)
    clear_cell(cell)
    first = True
    for line in text.split("\n"):
        para = cell.paragraphs[0] if first else cell.add_paragraph()
        first = False
        run = para.add_run(line)
        if ref_font is not None:
            run.font.name = ref_font.name
            run.font.size = ref_font.size
            run.font.bold = ref_font.bold


def append_cell(cell, text: str, ref_cell) -> None:
    """保留单元格里原有的说明文字，在其下方追加内容。"""
    ref_font = font_of(ref_cell)
    for line in text.split("\n"):
        para = cell.add_paragraph()
        run = para.add_run(line)
        if ref_font is not None:
            run.font.name = ref_font.name
            run.font.size = ref_font.size
            run.font.bold = ref_font.bold


def main() -> int:
    if not SRC.is_file():
        raise SystemExit(f"找不到模板：{SRC}")

    doc = docx.Document(str(SRC))
    table = doc.tables[0]

    filled: list[str] = []
    for idx, (label, text) in ROW_PLAN.items():
        row = table.rows[idx]
        actual = row.cells[0].text.strip()
        if actual != label:
            raise SystemExit(f"模板结构变了：第 {idx} 行期望「{label}」，实际「{actual}」")

        # 合并单元格在 python-docx 里会重复返回同一个 tc，去重
        seen, uniq = set(), []
        for c in row.cells[1:]:
            key = id(c._tc)
            if key not in seen:
                seen.add(key)
                uniq.append(c)
        if not uniq:
            continue

        empties = [c for c in uniq if not c.text.strip()]
        if empties:
            set_cell(empties[0], text, row.cells[0])
        else:
            # 模板里已写了填写说明，就接在说明下面，不覆盖官方文案
            append_cell(uniq[-1], text, row.cells[0])
        filled.append(label)

    missing = [k for k in FIELDS if k not in filled]
    DST.parent.mkdir(parents=True, exist_ok=True)
    doc.save(str(DST))

    print(f"已填充 {len(filled)} 个字段：{'、'.join(filled)}")
    if missing:
        print(f"未找到可填单元格（可能已存在内容）：{'、'.join(missing)}")
    print(f"输出：{DST}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
