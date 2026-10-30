# -*- coding: utf-8 -*-
"""test_transcript_template.py — MTGT-1/6 單元測試（樣板切段/套用/命中率）。

零依賴（不需 python-docx）：只測 split_blocks / apply_template / match_rate / _norm_time /
import-text 的純文字路徑。docx 抽取與端到端走隔離埠鏡射另外驗證（見 MTGT-6）。
    python test_transcript_template.py   → 全過印 OK 並 exit 0；任一斷言失敗 exit 1。
"""
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import transcript_template as tt

_fail = 0


def check(cond, msg):
    global _fail
    if cond:
        print("  ok  - %s" % msg)
    else:
        _fail += 1
        print("  FAIL- %s" % msg)


TEAMS_TEMPLATE = {
    "id": "teams",
    "blockPattern": "^(?P<speaker>.+?)\\s+(?P<time>\\d{1,2}:\\d{2}(:\\d{2})?)\\n(?P<text>.+)$",
}

SAMPLE_TEXT = (
    "王小明 0:12\n大家早，我們開始。\n\n"
    "李小華 0:45\n好的，我先報告進度，這件事分兩個部分：第一部分已完成，\n第二部分預計下週。\n\n"
    "王小明 1:03\n了解，謝謝。\n"
)


def test_split_blocks():
    print("[split_blocks]")
    blocks = tt.split_blocks(SAMPLE_TEXT)
    check(len(blocks) == 3, "三段（空白行分隔），實得 %d" % len(blocks))


def test_apply_template_teams():
    print("[apply_template teams]")
    rows, total, matched, warnings = tt.apply_template(SAMPLE_TEXT, TEAMS_TEMPLATE)
    check(total == 3, "共 3 段")
    check(matched == 3, "全部命中，實得 %d" % matched)
    check(rows[0]["speaker"] == "王小明", "第一段講者：%r" % rows[0]["speaker"])
    check(rows[0]["time"] == "0:12", "第一段時間：%r" % rows[0]["time"])
    check("大家早" in rows[0]["text"], "第一段內容含關鍵字")
    check("第二部分" in rows[1]["text"], "多行內容（DOTALL）完整吃到：%r" % rows[1]["text"])
    check(tt.match_rate(total, matched) == 100.0, "命中率 100%%")


def test_apply_template_js_named_group():
    print("[apply_template JS 具名群組正規化]")
    js_template = {"blockPattern": r"^(?<speaker>.+?)\s+(?<time>\d{1,2}:\d{2}(:\d{2})?)\n(?<text>.+)$"}
    rows, total, matched, warnings = tt.apply_template(SAMPLE_TEXT, js_template)
    check(matched == 3, "JS (?<name>) 語法自動轉 Python (?P<name>) 後仍全部命中，實得 %d" % matched)


def test_apply_template_fail():
    print("[apply_template 格式不符 → 低命中率]")
    bad_text = "這是一份完全不同格式的檔案\n沒有講者也沒有時間戳\n純粹只是幾行文字\n"
    rows, total, matched, warnings = tt.apply_template(bad_text, TEAMS_TEMPLATE)
    check(matched == 0, "沒有段落命中 teams 樣板，實得 %d" % matched)
    check(tt.match_rate(total, matched) < 60.0, "命中率低於門檻")


def test_apply_template_none():
    print("[apply_template 不套樣板]")
    rows, total, matched, warnings = tt.apply_template(SAMPLE_TEXT, None)
    check(matched == 0 and total == 3, "template=None 時 matched=0、total 仍算出段數")


def test_norm_time():
    print("[_norm_time]")
    check(tt._norm_time("0:12") == "00:00:12", "mm:ss 補零：%r" % tt._norm_time("0:12"))
    check(tt._norm_time("12:34") == "00:12:34", "mm:ss")
    check(tt._norm_time("1:02:03") == "01:02:03", "hh:mm:ss")
    check(tt._norm_time("garbage") == "00:00:00", "壞值回 00:00:00")


def test_import_text_with_template():
    print("[action_import_text 邏輯（透過 apply_template 手動組字串驗證格式）]")
    rows, total, matched, warnings = tt.apply_template(SAMPLE_TEXT, TEAMS_TEMPLATE)
    lines = []
    for r in rows:
        prefix = (r["speaker"] + "：") if r["speaker"] else ""
        lines.append("[%s] %s%s" % (tt._norm_time(r["time"]), prefix, r["text"]))
    check(lines[0] == "[00:00:12] 王小明：大家早，我們開始。", "第一行格式對齊 [HH:MM:SS] 講者：文字：%r" % lines[0])


if __name__ == "__main__":
    test_split_blocks()
    test_apply_template_teams()
    test_apply_template_js_named_group()
    test_apply_template_fail()
    test_apply_template_none()
    test_norm_time()
    test_import_text_with_template()
    if _fail:
        print("\n%d 條斷言失敗" % _fail)
        sys.exit(1)
    print("\n全部通過 ✅")
    sys.exit(0)
