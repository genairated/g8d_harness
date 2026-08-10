# -*- coding: utf-8 -*-
"""meeting_import.py — V 段（會議匯入）：既有音檔／字幕 → 標準 meeting 目錄的 transcript.txt

由 portal spawn（POST /api/meeting/import）。只負責「生一個含 transcript.txt 的 meeting 目錄」，
之後 server 端的 finalizeMeetingSummary()＋MTG-SUM-04 lazy backfill 會自動接手多模型摘要——分析零新碼。
設計見 specs/SPEC-meeting-import.md。

兩條路徑：
  • 字幕（vtt/srt）→ 純 Python 解析（**零依賴、不經 STT、秒完成**）。
  • 音檔（mp3/mp4/m4a/wav）→ 重用 stt.transcribe_file()（faster_whisper + PyAV，**免 ffmpeg**）。
    stt 為延遲載入（lazy import），故字幕路徑與單元測試不需要 faster_whisper。

輸出格式**必須對齊 meeting_record.py**：`[HH:MM:SS] 文字\n`（fmt_ts 同款），繁中沿用 stt 的 OpenCC 後處理。

CLI：
    python meeting_import.py --dir <meetingDir> --source <檔案路徑> --kind auto|audio|subtitle \
        [--lang zh --model medium]
    → 產出 <meetingDir>/transcript.txt，並更新 meta.json 的 status（importing→transcribing→done／error）。

鐵律：讀寫一律 utf-8；呼叫端帶 PYTHONUTF8=1（Windows console 是 cp950）。
"""
import sys
import os
import re
import json
import time
import argparse

try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:
    pass

AUDIO_EXTS = (".mp3", ".mp4", ".m4a", ".wav")
SUBTITLE_EXTS = (".vtt", ".srt")

# 去除 vtt 樣式/計時標籤：<c>、</c>、<v 名字>、<00:00:00.000> inline timing 等。
_TAG_RE = re.compile(r"<[^>]*>")
# vtt cue 內的說話者標記 <v Name> → 取名字當前綴（利於後續 diarize 對齊）。
_VOICE_RE = re.compile(r"<v\s+([^>]*)>", re.IGNORECASE)


def log(msg):
    print("[import] %s" % msg, file=sys.stderr)
    sys.stderr.flush()


def fmt_ts(seconds):
    """與 meeting_record.py.fmt_ts 完全一致：秒 → [HH:MM:SS]（去毫秒）。"""
    s = int(seconds)
    return "%02d:%02d:%02d" % (s // 3600, (s % 3600) // 60, s % 60)


def update_meta(meeting_dir, **fields):
    """就地合併 meta.json（沿用 meeting_record.py.update_meta 慣例）。"""
    meta_path = os.path.join(meeting_dir, "meta.json")
    meta = {}
    try:
        with open(meta_path, "r", encoding="utf-8") as f:
            meta = json.load(f)
    except Exception:
        pass
    meta.update(fields)
    with open(meta_path, "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)


# ── 字幕解析（純 Python，零依賴）──────────────────────────────────────────────

def parse_timestamp(raw):
    """'HH:MM:SS.mmm' / 'HH:MM:SS,mmm' / 'MM:SS.mmm' → 秒（float）。無法解析回 0.0。"""
    raw = (raw or "").strip().replace(",", ".")
    if not raw:
        return 0.0
    parts = raw.split(":")
    try:
        if len(parts) == 3:
            h, m, s = parts
        elif len(parts) == 2:
            h, m, s = "0", parts[0], parts[1]
        else:
            return 0.0
        sec_parts = s.split(".")
        whole = int(sec_parts[0] or 0)
        ms = 0
        if len(sec_parts) > 1 and sec_parts[1]:
            ms = int(sec_parts[1].ljust(3, "0")[:3])
        return int(h) * 3600 + int(m) * 60 + whole + ms / 1000.0
    except (ValueError, IndexError):
        return 0.0


def _extract_cue_text(text_lines):
    """cue 的多行文字 → (speaker|None, 純文字)。去樣式標籤、抓 <v 名字>、去對話破折號。"""
    speaker = None
    parts = []
    for ln in text_lines:
        vm = _VOICE_RE.search(ln)
        if vm and not speaker:
            name = vm.group(1).strip()
            # <v Name.classname> — 只取空白/點前的名字部分
            name = name.split(".")[0].strip()
            if name:
                speaker = name
        clean = _TAG_RE.sub("", ln).strip()
        # srt 常用 "- " 標對話者換行；去掉開頭破折號留純文字
        clean = re.sub(r"^-\s*", "", clean)
        if clean:
            parts.append(clean)
    body = " ".join(parts).strip()
    return speaker, body


def parse_cues(text):
    """通用 cue 解析（vtt/srt 共用）：只在含 '-->' 的計時行起算，抓起始時間 + 後續文字行。

    序號行（srt）、cue 識別行（vtt）、WEBVTT 標頭、NOTE 區塊都只是非計時行 → 自然略過。
    回傳 [(start_seconds, speaker|None, text), ...]，依出現順序。
    """
    lines = text.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    cues = []
    i, n = 0, len(lines)
    while i < n:
        line = lines[i]
        if "-->" in line:
            start_raw = line.split("-->")[0].strip()
            # cue settings（如 'align:start position:50%'）接在結束時間後，不影響起始時間解析
            start = parse_timestamp(start_raw.split()[0] if start_raw.split() else start_raw)
            i += 1
            text_lines = []
            while i < n and lines[i].strip() != "" and "-->" not in lines[i]:
                text_lines.append(lines[i])
                i += 1
            speaker, body = _extract_cue_text(text_lines)
            if body:
                cues.append((start, speaker, body))
        else:
            i += 1
    return cues


def parse_vtt(text):
    return parse_cues(text)


def parse_srt(text):
    return parse_cues(text)


def cues_to_transcript(cues):
    """[(start, speaker, text), ...] → '[HH:MM:SS] 文字\n' 串。連續同秒且同說話者可合併成一行。"""
    out = []
    last_key = None   # (second, speaker) — 用來判斷是否合併
    for start, speaker, body in cues:
        prefix = (speaker + "：") if speaker else ""
        line_text = prefix + body
        key = (int(start), speaker)
        if key == last_key and out:
            out[-1] += " " + body   # 合併時不重覆說話者前綴
        else:
            out.append("[%s] %s" % (fmt_ts(start), line_text))
            last_key = key
    return ("\n".join(out) + "\n") if out else ""


def subtitle_to_transcript(source_path, ext):
    with open(source_path, "r", encoding="utf-8-sig", errors="replace") as f:
        raw = f.read()
    cues = parse_srt(raw) if ext == ".srt" else parse_vtt(raw)
    return cues_to_transcript(cues)


# ── 音檔轉錄（重用 stt.transcribe_file）───────────────────────────────────────

def audio_to_transcript(source_path, transcript_path, lang, model):
    """重用 stt.transcribe_file()：拿回帶時間戳的 segments → 逐段 [HH:MM:SS] 文字 append+flush。"""
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import stt  # lazy：字幕路徑與單元測試不需要 faster_whisper
    res = stt.transcribe_file(source_path, lang=lang, model_size=model)
    segments = res.get("segments") or []
    wrote = False
    with open(transcript_path, "a", encoding="utf-8") as tf:
        for seg in segments:
            t = (seg.get("text") or "").strip()
            if not t:
                continue
            tf.write("[%s] %s\n" % (fmt_ts(seg.get("start") or 0.0), t))
            tf.flush()
            wrote = True
        if not wrote:
            whole = (res.get("text") or "").strip()
            if whole:
                tf.write("[%s] %s\n" % (fmt_ts(0.0), whole))
                wrote = True
    return wrote


# ── CLI ──────────────────────────────────────────────────────────────────────

def main(argv):
    ap = argparse.ArgumentParser(description="會議匯入：音檔／字幕 → transcript.txt")
    ap.add_argument("--dir", required=True, help="meetingDir")
    ap.add_argument("--source", required=True, help="來源檔案的絕對路徑（音檔或字幕）")
    ap.add_argument("--kind", default="auto", choices=["auto", "audio", "subtitle"])
    ap.add_argument("--lang", default="zh")
    ap.add_argument("--model", default="medium")
    args = ap.parse_args(argv)

    meeting_dir = args.dir
    source_path = args.source
    os.makedirs(meeting_dir, exist_ok=True)
    transcript_path = os.path.join(meeting_dir, "transcript.txt")

    ext = os.path.splitext(source_path)[1].lower()
    kind = args.kind
    if kind == "auto":
        kind = "subtitle" if ext in SUBTITLE_EXTS else "audio"

    if not os.path.exists(source_path):
        update_meta(meeting_dir, status="error", error="來源檔案不存在：%s" % source_path)
        log("來源檔案不存在：%s" % source_path)
        return 2

    try:
        if kind == "subtitle":
            if ext not in SUBTITLE_EXTS:
                raise ValueError("不支援的字幕副檔名：%s" % ext)
            update_meta(meeting_dir, status="transcribing", importKind="subtitle")
            text = subtitle_to_transcript(source_path, ext)
            with open(transcript_path, "w", encoding="utf-8") as f:
                f.write(text)
            log("字幕解析完成：%d 字元" % len(text))
        else:
            if ext not in AUDIO_EXTS:
                raise ValueError("不支援的音檔副檔名：%s" % ext)
            update_meta(meeting_dir, status="transcribing", importKind="audio")
            log("開始轉錄音檔（model=%s lang=%s）：%s" % (args.model, args.lang, source_path))
            audio_to_transcript(source_path, transcript_path, args.lang, args.model)
            log("音檔轉錄完成：%s" % transcript_path)

        update_meta(meeting_dir, status="done", finishedAt=time.strftime("%Y-%m-%dT%H:%M:%S"))
        return 0
    except Exception as e:
        update_meta(meeting_dir, status="error", error=str(e))
        log("匯入失敗：%s" % e)
        return 1


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except KeyboardInterrupt:
        sys.exit(0)
