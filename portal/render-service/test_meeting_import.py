# -*- coding: utf-8 -*-
"""test_meeting_import.py — 字幕 parser 單元測試（MTG-IMP-01）。

零依賴：只測純 Python 字幕路徑（不 import stt / faster_whisper）。
    python test_meeting_import.py   → 全過印 OK 並 exit 0；任一斷言失敗 exit 1。
"""
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import meeting_import as mi

_fail = 0


def check(cond, msg):
    global _fail
    if cond:
        print("  ok  - %s" % msg)
    else:
        _fail += 1
        print("  FAIL- %s" % msg)


# ── parse_timestamp ──────────────────────────────────────────────────────────
def test_timestamp():
    print("[parse_timestamp]")
    check(mi.parse_timestamp("00:00:05.000") == 5.0, "vtt HH:MM:SS.mmm")
    check(mi.parse_timestamp("00:01:30,500") == 90.5, "srt HH:MM:SS,mmm 逗號毫秒")
    check(mi.parse_timestamp("01:02:03.250") == 3723.25, "含小時")
    check(mi.parse_timestamp("02:05.000") == 125.0, "MM:SS.mmm 無小時")
    check(mi.parse_timestamp("garbage") == 0.0, "壞值回 0")


# ── VTT ──────────────────────────────────────────────────────────────────────
VTT_SAMPLE = """WEBVTT

NOTE 這是一段註解，應被忽略

00:00:00.000 --> 00:00:02.500
<v 王經理>大家好，今天開會討論專案進度。</v>

2
00:00:02.500 --> 00:00:05.000 align:start
<c.yellow>我們先看<00:00:03.000>第一項<00:00:04.000>待辦。</c>

00:00:10.100 --> 00:00:12.000
This is English line one.
"""


def test_vtt():
    print("[parse_vtt]")
    cues = mi.parse_vtt(VTT_SAMPLE)
    check(len(cues) == 3, "三個 cue（NOTE/標頭/識別行被略過），實得 %d" % len(cues))
    check(cues[0][0] == 0.0, "第一 cue 起始 0s")
    check(cues[0][1] == "王經理", "抓到說話者 <v 王經理>")
    check("大家好" in cues[0][2] and "<" not in cues[0][2], "去標籤留純文字")
    check("<" not in cues[1][2] and "第一項" in cues[1][2], "去 inline timing/樣式標籤")
    tx = mi.cues_to_transcript(cues)
    lines = tx.strip().split("\n")
    check(lines[0].startswith("[00:00:00] 王經理：大家好"), "轉出 [HH:MM:SS] + 說話者前綴：%r" % lines[0])
    check(lines[1].startswith("[00:00:02] "), "第二行時間戳去毫秒")
    check(lines[2].startswith("[00:00:10] This is English"), "英文行保留")
    check(tx.endswith("\n"), "以換行結尾")


# ── SRT ──────────────────────────────────────────────────────────────────────
SRT_SAMPLE = """1
00:00:00,000 --> 00:00:02,000
第一句話。

2
00:00:02,000 --> 00:00:04,000
- 甲：你好
- 乙：你也好

3
00:00:04,000 --> 00:00:06,000
最後一句。
"""


def test_srt():
    print("[parse_srt]")
    cues = mi.parse_srt(SRT_SAMPLE)
    check(len(cues) == 3, "三個 cue（序號行被略過），實得 %d" % len(cues))
    check(cues[0][0] == 0.0 and "第一句話" in cues[0][2], "第一 cue 內容正確")
    check("甲：你好" in cues[1][2] and "-" not in cues[1][2][:1], "去對話破折號、多行合併")
    tx = mi.cues_to_transcript(cues)
    lines = tx.strip().split("\n")
    check(len(lines) == 3, "三行 transcript")
    check(all(l.startswith("[00:00:0") for l in lines), "每行 [HH:MM:SS] 開頭")


# ── 同秒合併 ──────────────────────────────────────────────────────────────────
def test_same_second_merge():
    print("[cues_to_transcript same-second merge]")
    cues = [(1.0, None, "前半句"), (1.4, None, "後半句"), (2.0, None, "下一句")]
    tx = mi.cues_to_transcript(cues)
    lines = tx.strip().split("\n")
    check(len(lines) == 2, "同秒(1s)無說話者合併為一行 → 2 行，實得 %d" % len(lines))
    check("前半句 後半句" in lines[0], "合併內容相接：%r" % lines[0])


if __name__ == "__main__":
    test_timestamp()
    test_vtt()
    test_srt()
    test_same_second_merge()
    if _fail:
        print("\n%d 條斷言失敗" % _fail)
        sys.exit(1)
    print("\n全部通過 ✅")
    sys.exit(0)
