#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""传前体检（JSON 进出）：对填好的全通教育上传模板逐份检查会被平台拒收的条件。

判据（来自实测）：
  * 模板 `小题分` 表：表头第 3 行、B 列=姓名、第 9 列(I)起=题号列、数据从第 4 行。
  * `班级对照表` 表：无表头，数据从第 1 行开始（A 列=姓名）。
  * 平台「一有空格就整份拒收」⇒ 整行空 与 部分空 都算必拒。
  * 名单必须两表一致；小题分有、对照表没有的学生会引发「学生班级未找到」。

用法（stdin 给 JSON，stdout 回 JSON）：
  echo '{"file":"/abs/path.xlsx"}' | python3 precheck.py
  # 或 {"file":"<base64>"} —— 需要 base64 落盘到临时目录后处理
"""
import base64
import json
import os
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
    只认整数会把 5 列数成 3 列，后续列数校验与满分比对都会错位。
    """
    if v in (None, ""):
        return None
    s = str(v).strip()
    if not s:
        return None
    import re
    if re.fullmatch(r"\d+(\.\d+)?", s):
        return s.lstrip("0") or "0"
    m = re.search(r"(\d+(?:\.\d+)?)", s)
    if m and (re.search(r"题", s) or s.upper().startswith("T")):
        return m.group(1).lstrip("0") or "0"
    return None


def check(path, max_scores=None):
    """max_scores: {题号(str): 满分} 或 None（无满分数据时跳过越界校验）。"""
    wb = openpyxl.load_workbook(path, data_only=True)
    r = dict(sheets=wb.sheetnames, students=0, qcols=0, empty_cells=0,
             blank_rows=[], partial_rows=[], extra_in_scores=[], missing_in_map=[],
             no_subscores=False, over_limit=[], over_limit_cells=0,
             maxScoreChecked=bool(max_scores), unknownQuestions=[])
    if "小题分" not in wb.sheetnames:
        r["error"] = "缺 `小题分` 表"
        wb.close()
        return r
    ws = wb["小题分"]
    hdr_ok = str(ws.cell(HDR_ROW, HDR_NAME_COL).value or "").strip() == "姓名"
    if not hdr_ok:
        r["error"] = "第 %d 行 %s 列不是「姓名」——坐标可能变了" % (
            HDR_ROW, openpyxl.utils.get_column_letter(HDR_NAME_COL))
        wb.close()
        return r
    maxc = ws.max_column
    qcols = [c for c in range(QCOL_START, maxc + 1)
             if qno_of(ws.cell(HDR_ROW, c).value) is not None]
    qnos = [str(qno_of(ws.cell(HDR_ROW, c).value)) for c in qcols]
    r["qcols"] = len(qcols)
    if not qcols:
        r["no_subscores"] = True
    # 题号在满分表里找不到的（用于提示满分数据可能对不上）
    if max_scores:
        r["unknownQuestions"] = [q for q in qnos if q not in max_scores]
    names = []
    over = {}
    for row in range(DATA_ROW, ws.max_row + 1):
        nm = ws.cell(row, HDR_NAME_COL).value
        if nm in (None, ""):
            continue
        name = str(nm).strip()
        names.append(name)
        vals = [ws.cell(row, c).value for c in qcols]
        blanks = sum(1 for v in vals if v in (None, ""))
        r["empty_cells"] += blanks
        if not qcols or blanks == len(qcols):
            r["blank_rows"].append(name)
        elif blanks:
            r["partial_rows"].append([name, blanks])
        # 分值上限校验：任一格 > 该题满分即整份会被平台拒收
        if max_scores:
            for j, v in enumerate(vals):
                if v in (None, ""):
                    continue
                try:
                    num = float(v)
                except (TypeError, ValueError):
                    continue
                cap = max_scores.get(qnos[j])
                if cap is None:
                    continue
                if num > float(cap) + 1e-9:
                    r["over_limit_cells"] += 1
                    over.setdefault(qnos[j], []).append(name)
    r["students"] = len(names)
    # 每题的越界人数（只留前 20 题，避免输出过大）
    for qno, ns in list(over.items())[:20]:
        r["over_limit"].append({"question": qno, "maxScore": max_scores.get(qno), "students": ns[:10], "count": len(ns)})
    cmap = set()
    if "班级对照表" in wb.sheetnames:
        ws2 = wb["班级对照表"]
        for row in range(1, ws2.max_row + 1):
            v = ws2.cell(row, 1).value
            if v not in (None, ""):
                cmap.add(str(v).strip())
    r["extra_in_scores"] = [n for n in names if n not in cmap]
    r["missing_in_map"] = sorted(cmap - set(names))
    wb.close()
    ok = not r["blank_rows"] and not r["partial_rows"] and not r["extra_in_scores"]
    r["ok"] = bool(ok and not r["no_subscores"] and not r["over_limit"])
    return r


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

    tmpdir = None
    path = payload.get("file", "")
    try:
        if "data" in payload and payload["data"]:
            tmpdir = tempfile.mkdtemp(prefix="fli-precheck-")
            path = os.path.join(tmpdir, "input.xlsx")
            with open(path, "wb") as f:
                f.write(base64.b64decode(payload["data"]))
        if not path or not os.path.exists(path):
            print(json.dumps({"error": "file not found: %s" % path}, ensure_ascii=False))
            return 2
        # 满分表：{题号: 满分}；Host 从试卷 questions 取，取不到时为 None（跳过越界校验）
        raw_max = payload.get("maxScores") or {}
        max_scores = {}
        for k, v in raw_max.items():
            try:
                max_scores[str(k)] = float(v)
            except (TypeError, ValueError):
                continue
        result = check(path, max_scores or None)
        print(json.dumps(result, ensure_ascii=False))
        return 0 if result.get("ok") else 5
    except Exception as e:
        print(json.dumps({"error": str(e)}, ensure_ascii=False))
        return 2
    finally:
        if tmpdir:
            try:
                import shutil
                shutil.rmtree(tmpdir, ignore_errors=True)
            except Exception:
                pass


if __name__ == "__main__":
    sys.exit(main())
