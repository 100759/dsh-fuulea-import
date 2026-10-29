#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把「源成绩表（已解析为 JSON）」填进「全通教育上传模板」。

模板结构（实测）：
  `小题分` 表：表头第 3 行、B 列=姓名、第 9 列(I)起=题号列、数据从第 4 行。
  `班级对照表` 表：无表头，A 列=姓名（全年级选了该科的学生）。
上传单位是「任务」，同 (考试,学科) 组合模板内容相同。

源成绩表（由 Host 的 lib/parse.js 解析后传入）：
  students: [{name, questions:[值...], total}]
  questionCount: 题号列数

填充规则：
  - 题号列数必须等于模板题号列数，否则报错（列数不一致）。
  - 只填「有小题分」的学生；整行小题分全空的学生视为缺考，跳过（不写姓名）。
  - 源表有、对照表没有的学生 → 记入 extra_in_scores（平台会报「学生班级未找到」）。

用法（stdin JSON，stdout JSON）：
{
  "template": "/abs/template.xlsx",        # 或 "templateData": "<base64>"
  "out": "/abs/out.xlsx",                  # 输出路径（可选，默认写到 template 同目录 *_filled.xlsx）
  "students": [{"name":"张三","questions":[3,0,5,..]}, ...],
  "questionCount": 20
}
"""
import base64
import json
import os
import re
import sys
import tempfile

import openpyxl

HDR_ROW = 3
HDR_NAME_COL = 2
QCOL_START = 9
DATA_ROW = HDR_ROW + 1


def qno_of(v):
    """题号表头 → 字符串题号（支持 1 / 4.1 / 第4.1题 / T4.1）。

    ⚠️ 不能只认整数：实测「10月26日任务」模板题号是 1,2,3,4.1,4.2，
    只认整数会把 5 列数成 3 列，导致题数校验失败。
    """
    if v in (None, ""):
        return None
    s = str(v).strip()
    if not s:
        return None
    if re.fullmatch(r"\d+(\.\d+)?", s):
        return s.lstrip("0") or "0"
    m = re.search(r"(\d+(?:\.\d+)?)", s)
    if m and (re.search(r"题", s) or s.upper().startswith("T")):
        return m.group(1).lstrip("0") or "0"
    return None


def load(path_or_none, data_b64, tmpdir):
    """加载模板 workbook（文件路径优先，否则落盘 base64）。返回 (wb, path)。"""
    if path_or_none and os.path.exists(path_or_none):
        return openpyxl.load_workbook(path_or_none), path_or_none
    path = os.path.join(tmpdir, "template.xlsx")
    with open(path, "wb") as f:
        f.write(base64.b64decode(data_b64))
    return openpyxl.load_workbook(path), path


def fill(payload):
    tmpdir = None
    try:
        tmpdir = tempfile.mkdtemp(prefix="fli-fill-")
        wb, tpl_path = load(payload.get("template", ""), payload.get("templateData", ""), tmpdir)
        if "小题分" not in wb.sheetnames:
            return {"error": "模板缺 `小题分` 表"}
        ws = wb["小题分"]
        hdr_ok = str(ws.cell(HDR_ROW, HDR_NAME_COL).value or "").strip() == "姓名"
        if not hdr_ok:
            return {"error": "模板第 %d 行 B 列不是「姓名」，坐标可能变了" % HDR_ROW}
        qcols = [c for c in range(QCOL_START, ws.max_column + 1)
                 if qno_of(ws.cell(HDR_ROW, c).value) is not None]
        qheaders = [str(ws.cell(HDR_ROW, c).value or "").strip() for c in qcols]

        students = payload.get("students", [])
        plan = payload.get("plan")  # [{targetIndex, sources:[...], op:'copy'|'sum'}]

        # 填充模式：
        #   - 给了 plan：按映射指令填（支持多源求和，如 4.1+4.2 → 4）
        #   - 没给 plan：老行为，要求列数完全相等、按位置一一对应
        if plan:
            # 校验 plan 的目标列都在模板题号列范围内
            bad = [p for p in plan if not (0 <= int(p.get("targetIndex", -1)) < len(qcols))]
            if bad:
                return {"error": "映射方案有误", "detail": "目标列越界：%s" % bad[:3]}
            src_max = 0
            for p in plan:
                for s in (p.get("sources") or []):
                    src_max = max(src_max, int(s) + 1)
            src_qcount = int(payload.get("questionCount", 0) or src_max)
        else:
            src_qcount = int(payload.get("questionCount", 0) or 0)
            if src_qcount != len(qcols):
                return {
                    "error": "题数不一致",
                    "detail": "源表 %d 题 vs 模板 %d 列（可在「分析映射」里人工指定对应关系）" % (src_qcount, len(qcols)),
                    "questionCount": len(qcols),
                    "sourceQuestionCount": src_qcount,
                }

        # 对照表名单（A 列）
        roster = set()
        if "班级对照表" in wb.sheetnames:
            ws2 = wb["班级对照表"]
            for row in range(1, ws2.max_row + 1):
                v = ws2.cell(row, 1).value
                if v not in (None, ""):
                    roster.add(str(v).strip())

        filled = 0
        skipped = 0
        blank_cells = 0
        extra_in_scores = []
        row = DATA_ROW
        for st in students:
            name = str(st.get("name", "")).strip()
            if not name:
                continue
            qs = st.get("questions") or []

            if plan:
                # 按映射指令取值：copy 取一个源列；sum 把多个源列相加
                target_vals = {}
                for p in plan:
                    ti = int(p.get("targetIndex"))
                    sis = [int(s) for s in (p.get("sources") or [])]
                    vals_src = [qs[i] if i < len(qs) else None for i in sis]
                    non_null = [v for v in vals_src if v not in (None, "")]
                    if not non_null:
                        target_vals[ti] = None
                    elif p.get("op") == "sum" or len(non_null) > 1:
                        try:
                            target_vals[ti] = sum(float(v) for v in non_null)
                            if float(target_vals[ti]).is_integer():
                                target_vals[ti] = int(target_vals[ti])
                        except (TypeError, ValueError):
                            target_vals[ti] = non_null[0]
                    else:
                        target_vals[ti] = non_null[0]
                cell_pairs = [(qcols[ti], v) for ti, v in sorted(target_vals.items())]
            else:
                vals = list(qs[:len(qcols)]) + [None] * (len(qcols) - len(qs))
                cell_pairs = list(zip(qcols, vals))

            non_empty = sum(1 for _c, v in cell_pairs if v not in (None, ""))
            if non_empty == 0:
                skipped += 1
                continue
            if name not in roster:
                extra_in_scores.append(name)
            ws.cell(row, HDR_NAME_COL).value = name
            for col, v in cell_pairs:
                if v is None or v == "":
                    blank_cells += 1
                    ws.cell(row, col).value = None
                else:
                    ws.cell(row, col).value = v
            row += 1
            filled += 1

        out = payload.get("out", "")
        if not out:
            base = os.path.splitext(tpl_path)[0]
            out = base + "_filled.xlsx"
        wb.save(out)
        wb.close()
        return {
            "ok": True,
            "out": out,
            "students": filled,
            "skipped": skipped,
            "questionCount": len(qcols),
            "qheaders": qheaders,
            "blankCells": blank_cells,
            "extraInScores": extra_in_scores,
            "rosterCount": len(roster),
        }
    finally:
        if tmpdir:
            try:
                import shutil
                shutil.rmtree(tmpdir, ignore_errors=True)
            except Exception:
                pass


def main():
    raw = sys.stdin.read()
    if not raw.strip():
        print(json.dumps({"error": "empty stdin"}, ensure_ascii=False))
        return 2
    try:
        payload = json.loads(raw)
    except Exception as e:
        print(json.dumps({"error": "bad json: %s" % e}, ensure_ascii=False))
        return 2
    try:
        result = fill(payload)
        print(json.dumps(result, ensure_ascii=False))
        return 0 if result.get("ok") else 5
    except Exception as e:
        print(json.dumps({"error": str(e)}, ensure_ascii=False))
        return 2


if __name__ == "__main__":
    sys.exit(main())
