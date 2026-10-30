# -*- coding: utf-8 -*-
"""transcript_template.py — MTGT: 逐字稿樣板解析（docx / txt → 講者／時間／內容）

見 specs/SPEC-meeting-import.md §11。樣板存於 global-knowledge/transcript-templates/<id>.json
（跨工作區共用）。本檔是純文字比對引擎，零 LLM——「樣板解析」（transcript-learn）呼叫 LLM
產生候選樣板 JSON 的動作在 server.js；本檔只負責：①docx/txt 取純文字、②依樣板切段套 regex、
③算命中率、④正式匯入時吐出 transcript.txt 格式的文字。

實作備註：spec §11.2 範例 JSON 的 blockPattern 寫成 JS 具名群組語法 `(?<speaker>...)`；因為
解析引擎是 Python（python-docx 已在 venv、零新依賴），本檔的內建 teams 樣板改存
`(?P<speaker>...)` 這種 Python re 語法，語意一致。為保險，apply_template() 對任何樣板的
blockPattern 都會自動把 `(?<name>` 正規化成 `(?P<name>`，所以就算「樣板解析」(LLM) 有時
輸出 JS 語法也能直接吃。

CLI（皆輸出一行 JSON 到 stdout；log 走 stderr）：
    python transcript_template.py --action list    --templates-dir <dir>
    python transcript_template.py --action extract --source <path>
    python transcript_template.py --action preview --source <path> --template-id teams|none --templates-dir <dir>
    python transcript_template.py --action validate --source <path> --template-json <path或原始JSON字串> --templates-dir <dir>
    python transcript_template.py --action import-text --source <path> --template-id teams|none --templates-dir <dir>

鐵律：讀寫一律 utf-8；呼叫端（server.js）帶 venvSpawnEnv() 已含 PYTHONUTF8=1。
"""
import sys
import os
import re
import json
import argparse

try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:
    pass

MATCH_RATE_THRESHOLD = 60.0
# 把 JS 具名群組語法 (?<name>...)（但不含 lookbehind (?<= (?<!）正規化成 Python 的 (?P<name>...)。
_JS_NAMED_GROUP_RE = re.compile(r"\(\?<(?![=!])")


def log(msg):
    print("[transcript_template] %s" % msg, file=sys.stderr)
    sys.stderr.flush()


# ── 取文字（docx 走 python-docx；txt 自動偵測編碼）───────────────────────────

def extract_docx_text(path_):
    from docx import Document  # 已在 venv，零新依賴
    doc = Document(path_)
    return "\n".join(p.text for p in doc.paragraphs)


def extract_txt_text(path_):
    for enc in ("utf-8-sig", "utf-8", "big5"):
        try:
            with open(path_, "r", encoding=enc) as f:
                return f.read()
        except (UnicodeDecodeError, UnicodeError):
            continue
    with open(path_, "r", encoding="utf-8", errors="replace") as f:
        return f.read()


def extract_text(path_):
    ext = os.path.splitext(path_)[1].lower()
    if ext == ".docx":
        return extract_docx_text(path_)
    return extract_txt_text(path_)


# ── 樣板存取（global-knowledge/transcript-templates/<id>.json）──────────────

def templates_dir_default():
    here = os.path.dirname(os.path.abspath(__file__))
    return os.path.join(here, "..", "..", "global-knowledge", "transcript-templates")


def load_template(templates_dir, template_id):
    if not template_id or template_id == "none":
        return None
    p = os.path.join(templates_dir, template_id + ".json")
    with open(p, "r", encoding="utf-8") as f:
        return json.load(f)


def list_templates(templates_dir):
    out = []
    if os.path.isdir(templates_dir):
        for fn in sorted(os.listdir(templates_dir)):
            if not fn.endswith(".json"):
                continue
            try:
                with open(os.path.join(templates_dir, fn), "r", encoding="utf-8") as f:
                    t = json.load(f)
                if t.get("id"):
                    out.append({"id": t["id"], "name": t.get("name", t["id"]), "createdBy": t.get("createdBy", "")})
            except Exception as e:
                log("讀樣板失敗 %s: %s" % (fn, e))
    return out


# ── 切段＋套樣板（v1 只支援 blockSplit=blank-line，見 spec §11.7）──────────

def split_blocks(text):
    raw = re.split(r"\n\s*\n+", text.replace("\r\n", "\n").replace("\r", "\n"))
    return [b.strip() for b in raw if b.strip()]


def _compile_block_pattern(pattern_str):
    normalized = _JS_NAMED_GROUP_RE.sub("(?P<", pattern_str)
    return re.compile(normalized, re.DOTALL)   # DOTALL：內容可能跨多行


def apply_template(text, template):
    """回 (rows, total, matched, warnings)。rows 為全部命中段（呼叫端自行截前 N 筆顯示）。"""
    blocks = split_blocks(text)
    total = len(blocks)
    rows = []
    warnings = []
    if template is None:
        return rows, total, 0, warnings
    try:
        pat = _compile_block_pattern(template["blockPattern"])
    except (re.error, KeyError) as e:
        warnings.append("樣板 regex 錯誤：%s" % e)
        return rows, total, 0, warnings
    for b in blocks:
        m = pat.match(b)
        if not m:
            continue
        gd = m.groupdict()
        rows.append({
            "speaker": (gd.get("speaker") or "").strip(),
            "time": (gd.get("time") or "").strip(),
            "text": (gd.get("text") or "").strip(),
        })
    matched = len(rows)
    return rows, total, matched, warnings


def match_rate(total, matched):
    return round((matched / total) * 100, 1) if total else 0.0


def _norm_time(raw):
    """'0:12' / '12:34' / '1:02:03' → 'HH:MM:SS'（缺小時補 00）；無法解析回 00:00:00。"""
    raw = (raw or "").strip()
    if not raw:
        return "00:00:00"
    parts = raw.split(":")
    try:
        nums = [int(p) for p in parts]
    except ValueError:
        return "00:00:00"
    if len(nums) == 2:
        h, m, s = 0, nums[0], nums[1]
    elif len(nums) == 3:
        h, m, s = nums
    else:
        return "00:00:00"
    return "%02d:%02d:%02d" % (h, m, s)


# ── actions ──────────────────────────────────────────────────────────────

def action_list(templates_dir):
    return {"ok": True, "templates": list_templates(templates_dir)}


def action_extract(source):
    return {"ok": True, "text": extract_text(source)}


def action_preview(source, template_id, templates_dir, max_rows=10, raw_lines=20):
    text = extract_text(source)
    template = load_template(templates_dir, template_id)
    rows, total, matched, warnings = apply_template(text, template)
    rate = match_rate(total, matched)
    out = {"ok": True, "total": total, "matched": matched, "matchRate": rate,
           "rows": rows[:max_rows], "warnings": warnings}
    if template is None or rate < MATCH_RATE_THRESHOLD:
        out["rawPreview"] = "\n".join(text.splitlines()[:raw_lines])
    return out


def action_validate(source, template_json_raw, templates_dir):
    """驗證候選樣板（供「樣板解析」落檔前使用）：template_json_raw 可以是檔案路徑也可以是原始 JSON 字串。"""
    text = extract_text(source)
    if os.path.exists(template_json_raw):
        with open(template_json_raw, "r", encoding="utf-8") as f:
            template = json.load(f)
    else:
        template = json.loads(template_json_raw)
    rows, total, matched, warnings = apply_template(text, template)
    rate = match_rate(total, matched)
    return {"ok": True, "total": total, "matched": matched, "matchRate": rate,
            "rows": rows[:10], "warnings": warnings, "passed": rate >= MATCH_RATE_THRESHOLD}


def action_import_text(source, template_id, templates_dir):
    """正式匯入：整份文字依樣板切成 `[HH:MM:SS] 講者：文字` 逐行；不套樣板則整份原文（保底路徑）。"""
    text = extract_text(source)
    template = load_template(templates_dir, template_id)
    if template is None:
        return {"ok": True, "transcript": text, "matched": 0, "total": 0}
    rows, total, matched, warnings = apply_template(text, template)
    lines = []
    for r in rows:
        prefix = (r["speaker"] + "：") if r["speaker"] else ""
        lines.append("[%s] %s%s" % (_norm_time(r["time"]), prefix, r["text"]))
    transcript = ("\n".join(lines) + "\n") if lines else ""
    return {"ok": True, "transcript": transcript, "matched": matched, "total": total, "warnings": warnings}


# ── CLI ──────────────────────────────────────────────────────────────────

def main(argv):
    ap = argparse.ArgumentParser(description="逐字稿樣板解析（docx/txt）")
    ap.add_argument("--action", required=True, choices=["list", "extract", "preview", "validate", "import-text"])
    ap.add_argument("--source")
    ap.add_argument("--template-id", default="none")
    ap.add_argument("--template-json")
    ap.add_argument("--templates-dir", default=templates_dir_default())
    args = ap.parse_args(argv)

    try:
        if args.action == "list":
            out = action_list(args.templates_dir)
        elif args.action == "extract":
            out = action_extract(args.source)
        elif args.action == "preview":
            out = action_preview(args.source, args.template_id, args.templates_dir)
        elif args.action == "validate":
            out = action_validate(args.source, args.template_json or "{}", args.templates_dir)
        elif args.action == "import-text":
            out = action_import_text(args.source, args.template_id, args.templates_dir)
        else:
            out = {"ok": False, "error": "unknown action"}
    except Exception as e:
        out = {"ok": False, "error": str(e)}
    print(json.dumps(out, ensure_ascii=False))
    return 0 if out.get("ok") else 1


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except KeyboardInterrupt:
        sys.exit(0)
