# -*- coding: utf-8 -*-
"""stt.py — 共用語音辨識模組（faster-whisper + OpenCC 繁體後處理）

單一職責：給一個音檔 → 回文字。會議錄製（meeting_record.py）、portal 麥克風
（/api/stt → F4）、Telegram 語音（F5）全部呼叫這支。

設計見 specs/SPEC-meeting-transcriber.md §3 與 SPEC-floating-chat.md §6。

函式介面：
    transcribe_file(audio_path, lang="auto", model_size="medium", initial_prompt=None) -> dict
回傳：
    { "text": str,            # 已做繁體轉換（若偵測/指定為 zh）
      "language": str, "duration": float,
      "segments": [ {"start": float, "end": float, "text": str}, ... ] }

CLI（給 node spawn）：
    python stt.py <audio> --lang zh --model medium [--prompt "人名/術語"]
    → 把上述 dict 以 JSON 單行印到 stdout；錯誤走 stderr + 非 0 exit。

鐵律：寫檔/輸出一律 utf-8；呼叫端帶 PYTHONUTF8=1（Windows console 是 cp950）。
"""
import sys
import os
import re
import json
import argparse

# Windows console 是 cp950，印中文/® 會炸 → 強制 stdout/stderr 走 utf-8。
# 用 reconfigure（保留原串流物件）而非重包 TextIOWrapper——後者在行程 teardown 時會丟
# "I/O operation on closed file"。
try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:
    pass

# Windows 上 pip 裝的 nvidia-cublas-cu12/nvidia-cudnn-cu12 不會自動掛進 DLL 搜尋路徑。
# ctranslate2 用 cuda 時是靠 PATH 環境變數找 cublas64_12.dll/cudnn64_9.dll（實測
# os.add_dll_directory 對它無效，它認的是 PATH）——沒掛上會在第一次 encode() 才炸，
# 不是 import 期，容易誤以為模型已經在吃 GPU。
if sys.platform == "win32":
    _venv_root = os.path.dirname(os.path.dirname(sys.executable))  # ...\.venv\Scripts\python.exe → ...\.venv
    _bins = [os.path.join(_venv_root, "Lib", "site-packages", "nvidia", _pkg, "bin")
             for _pkg in ("cublas", "cudnn", "cuda_nvrtc")]
    _bins = [b for b in _bins if os.path.isdir(b)]
    if _bins:
        os.environ["PATH"] = os.pathsep.join(_bins) + os.pathsep + os.environ.get("PATH", "")
        # ctypes 不吃 PATH（Python 3.8 起改用 LOAD_LIBRARY_SEARCH_DEFAULT_DIRS），
        # 所以下面 _cuda_runtime_ready() 的探測要另外把目錄掛進 DLL 搜尋路徑，
        # 否則 DLL 明明裝好了仍會誤判成「缺元件」而白白退回 CPU。
        for _b in _bins:
            try:
                os.add_dll_directory(_b)
            except OSError:
                pass

# ── 模型快取（singleton per size）──────────────────────────────────────────
# WhisperModel 載入要 ~3-20s；同 size 在行程內只載一次。會議錄製是長駐行程，
# 每個 chunk 都呼叫 transcribe_file → 絕不可每次重載。
_MODEL_CACHE = {}
# OpenCC 轉換器也快取（簡體→台灣繁體用語）。
_OPENCC = None

# 模型快取目錄：電腦共用（多專案/多 whisper 用途都吃同一份），不專屬 _harness，
# 故不放專案目錄下，改放 D:\Models（可用 HANA_STT_MODEL_DIR 覆蓋）。
MODEL_DOWNLOAD_ROOT = os.environ.get("HANA_STT_MODEL_DIR", r"D:\Models\huggingface\hub")

_DEVICE = None  # (device, compute_type) 快取，避免每次都重新偵測


def _cuda_runtime_ready():
    """ctranslate2 的 cuda 後端要到第一次 encode() 才去載 cublas/cudnn，載不到不只是丟例外——
    實測會把整個行程打死（會議錄製的症狀＝錄十幾秒就無聲中止、逐字稿全空、畫面永遠沒字）。
    偵測到 GPU 不代表跑得動：driver 有、但 venv 裡沒裝 nvidia-cublas-cu12/nvidia-cudnn-cu12
    （例如重建 venv 時只裝了 torch 的 +cpu 版）就是這個情形。
    這裡先用 ctypes 把它會用到的 DLL 實際載一次；載不起來就當作沒有 GPU，退回 CPU+int8
    （原本驗證過的組態，small 的 RTF≈0.37，即時錄製跟得上）——寧可慢，也不要中途死掉。"""
    if sys.platform != "win32":
        return True
    import ctypes
    for _dll in ("cublas64_12.dll", "cudnn64_9.dll"):
        try:
            _full = next((os.path.join(_b, _dll) for _b in _bins
                          if os.path.isfile(os.path.join(_b, _dll))), _dll)
            # winmode=0 → 用預設搜尋順序解相依（含 PATH），與 ctranslate2 原生載入一致
            ctypes.WinDLL(_full, winmode=0)
        except OSError as e:
            print("[stt] GPU 偵測到但 CUDA 執行庫缺 %s，改用 CPU（int8）：%s" % (_dll, e),
                  file=sys.stderr)
            return False
    return True


def _detect_device():
    global _DEVICE
    if _DEVICE is None:
        try:
            import ctranslate2
            if ctranslate2.get_cuda_device_count() > 0 and _cuda_runtime_ready():
                _DEVICE = ("cuda", "float16")
            else:
                _DEVICE = ("cpu", "int8")
        except Exception:
            _DEVICE = ("cpu", "int8")
    return _DEVICE

# F6d：中文辨識常整段黏一串、無標點——Whisper 對中文的已知脾氣（OpenCC 只管簡→繁，不加標點）。
# 預設餵一段「本身帶標點」的中文 initial_prompt，讓 Whisper 模仿其書寫風格補逗號/句號/斷句。
# 只在呼叫端未指定 prompt 且語言為中文/auto 時套用；呼叫端仍可傳自己的 --prompt（人名/術語）覆蓋。
DEFAULT_PUNCT_PROMPT_ZH = "以下是一段中文對話，語氣自然，包含逗號、句號、問號等標點符號。"

# ── VAD（輸入端剪音）參數：放寬預設值，別把「兩句話中間有人在講話」的段落剪掉 ──────
# faster-whisper 的 vad_filter=True 預設吃 Silero VAD 的內建預設值（threshold=0.5、
# min_silence_duration_ms=2000、speech_pad_ms=400）；這是「輸入端」在送進 Whisper 之前
# 就把判定為靜音的段落整段剪掉，剪掉的音訊不可逆、Whisper 根本沒看到，這才是「時間軸
# 憑空跳一段」的主因（診斷見 SPEC-meeting-transcriber）。三個值分別放寬：
#   threshold：降低＝更多幀被判為「有語音」、少剪。小聲/氣音/語尾拖尾常卡在 0.5 邊緣被剪掉，
#              降到 0.35 讓這些邊緣情況多半留下來，同時仍濾得掉真正的靜音/背景雜音。
#   min_silence_duration_ms：提高＝只把「夠長」的靜音當一段真的靜音來剪，短暫停頓（換氣、
#              思考、句間停頓後接話）不會被切開。**實測發現這個值不是越高越好**：用
#              edge-tts 合成「正常音量→小聲片段→正常音量」的音檔實測（.tmp-sv-test/
#              run_variant3.py 掃過 2000~4000），拉到 2500 以上時，小聲片段反而更容易整段
#              消失——faster-whisper 的 VAD 是用「觸發後直到累積靜音達門檻才真正結束語音段」
#              的邊界演算法，值拉太高會讓語音段的結束邊界往回摺到小聲片段開始之前，反而把它
#              排除在外，這跟直覺（拉高＝少剪）相反。故只從預設 2000 溫和提到 2200（與
#              threshold/speech_pad_ms 放寬合併後，實測在 -9~-12dB 的邊界案例都比預設组合更
#              能保住小聲片段，見 run_variant4.py）。低於 -15dB 這種已經逼近雜訊底噪的音量，
#              任何 VAD 參數都救不回來，這是麥克風/音量問題不是 VAD 問題。
#   speech_pad_ms：加大＝語音段前後多留一點緩衝，避免切到語頭起音或語尾拖音（尤其中文
#              聲調字的尾音、或講到一半突然停頓那一瞬間的字）。從 400 提到 600。
VAD_PARAMETERS = {
    "threshold": 0.35,
    "min_silence_duration_ms": 2200,
    "speech_pad_ms": 600,
}
# no_speech_threshold：這不是 VAD 參數，是 Whisper 解碼器自己對「這段是不是沒人講話」的
# 信心門檻（越低＝越容易把一段判成 no-speech 而丟棄文字）。VAD 放寬後，原本會被 VAD 直接
# 剪掉的邊緣安靜段落，現在有更多機會被送進模型；這裡維持預設 0.6（不特別放寬也不收緊），
# 讓解碼器自己的幻聽防線繼續把關，避免「VAD 放寬」反而讓幻聽跟著回升。
NO_SPEECH_THRESHOLD = 0.6

# ── 幻覺尾詞黑名單（Whisper 在靜音/雜音段吐的 YouTube 罐頭字幕）─────────────────
# 來源：模型訓練吃了大量 YouTube 字幕，遇到「沒有語音可辨識」時照慣性補一句罐頭出來，
# 跟音檔真實內容無關（見 SPEC-meeting-transcriber §3 觀察）。這是「輸出端」後處理，
# 跟音訊主題 initial_prompt（輸入端）互不衝突。全域生效：所有工作區的轉錄都會濾。
#
# 策略＝「片段全域移除」：對每段文字用 re.sub 清掉所有命中（連同被複讀的多次一起清），
# 再修掉殘留的連接標點。因此：
#   ① 整段都是罐頭 → 清成空字串 → 該段不進輸出（達成「沒語音就別吐罐頭」）；
#   ② 真話尾巴黏了罐頭、或罐頭黏在真話前面 → 只清罐頭、保留真內容。
# 只收「真人會議對話幾乎不可能講」的高特異性句型，避免誤傷正常內容。
_HALLUCINATION_PATTERNS = [re.compile(p) for p in (
    # A. 點讚 / 訂閱 / 鈴鐺 / 打賞 / 欄目 / 關注（特異性高者在前，孤立「訂閱」殿後）
    r"有興趣的話\s*(請)?\s*[點点]\s*[讚贊赞]\s*[、,，]?\s*訂?閱?",
    r"請?\s*不吝\s*[點点]?\s*[讚贊赞]",
    r"[點点]\s*[讚贊赞]\s*[、,，]?\s*訂閱",
    r"訂閱\s*[、,，]?\s*(開啟|按)?\s*小?\s*鈴鐺",
    r"開啟\s*小?\s*鈴鐺",
    r"[點点]\s*[點点]\s*欄目",
    r"打賞\s*(支[持援]\s*明鏡|支[持援])?",
    r"(請大家|大家)?\s*多多\s*關注",
    # 孤立「訂閱」（列表項）——前後都不是中文/英數才算，避免誤傷「先訂閱這個版本」
    r"(?<![一-鿿A-Za-z])訂閱(?![一-鿿A-Za-z])",
    # B. 字幕來源 / 製作
    r"這段?\s*(中文)?字幕\s*由.{0,25}?提供",
    r"此\s*字幕\s*由.{0,25}?提供",
    r"Amara\.?\s*org",
    # 「中(?!文字幕)」：可吃「製作中」的中，但不吃下一句「中文字幕」開頭的中
    r"中文字幕\s*(製作|制作)(?:人數不足|組織|人|中(?!文字幕))?",
    r"字幕\s*by.*",
    r"字幕\s*(製作|制作)\s*人.*",
    r"中文字幕\s*提供\s*by.*",
    r"中文字幕君",
    # C. 收尾 / 道別
    r"謝謝\s*(大家)?\s*(觀|观)看",
    r"多謝\s*(觀|观)看",
    r"謝謝\s*(大家)?\s*收看",
    r"感謝\s*(大家)?\s*(觀|观|收)看",
    r"我們\s*下[次期]\s*(節目)?\s*(再)?見",
    r"下[集期]\s*(節目)?\s*再見",
    r"這段?\s*(影片|視頻)\s*就\s*到\s*此\s*(為止)?",
    # D. 標點誘導 prompt 洩漏（DEFAULT_PUNCT_PROMPT_ZH 在空白段被複讀回來）
    r"以下是一段中文對話.*?標點符號\s*[。.]?",
    r"語氣自然\s*[，,]\s*包含逗號.*?標點符號\s*[。.]?",
    # E. 英文常見罐頭（faster-whisper 對英文/混語同樣會吐）
    r"(?i)thank(s| you)\s+(you\s+)?for\s+watching",
    r"(?i)please\s+(like\s*(,|and)?\s*)?subscribe",
    r"(?i)don'?t\s+forget\s+to\s+(like|subscribe)",
    r"(?i)subtitles?\s+by\s+.*",
)]

# 清掉罐頭被挖掉後殘留的連接/孤立標點與空白（頭尾）
_LEFTOVER_EDGE = re.compile(r"^[\s、，,。.！!？?~～…·\-]+|[\s、，,。.！!？?~～…·\-]+$")
# 命中罐頭後、若剩下的只是標點＋連接詞/語助詞碎屑 → 整段判定為罐頭殘渣，丟掉
_TRIVIAL_RESIDUE = re.compile(r"^[\s、，,。.！!？?~～…·\-和與及跟還有的了啊呀嗎吧喔哦嘿呢]*$")

# F. 短語連續重複（不管 prompt/黑名單，抓「同一個詞連續出現 4 次以上」的空轉退化——
#   audio-topic 帶了長專有名詞清單後常見，如「追溯、追溯、追溯…」），跟 A~E 是完全不同機制
#   （那些是固定字面比對，這裡是結構性偵測，抓得住任何主題詞彙、不必窮舉字面）。
#   分隔符做成「可有可無、含冒號/分號/空白」——實測 Whisper 的重複退化有三種黏法：頓號/逗號
#   分隔（「追溯、追溯」）、冒號分隔（「我只玩了一段時間：我只玩了一段時間：…」）、完全無分隔
#   （「這部樂這部樂這部樂…」）。舊版只認 [、，,] 分隔，後兩種整段漏網（實測會議段落殘留）。
#   短語用非貪婪 {1,15}? 以鎖定最小重複單元；門檻仍是「首次後再重複 3 次」＝共 4 次以上，真人
#   自然的「對對對」「好好好」三連不會誤傷。
_REPEAT_RUN = re.compile(r"([一-鿿A-Za-z0-9]{1,15}?)([、，,：:；;\s]{0,4}\1){3,}")

# F2. 單一字元（含標點）連續重複 5 次以上（如「：：：：：：…」）——跟 F 是同類退化但沒有
#   詞與詞之間的分隔符，是另一種模式，需要獨立的 regex 才抓得到。排除句點/刪節號/破折號/
#   波浪號/空白——這些真的會連續出現在正常語句（「……」表示語氣停頓、「-----」分隔線）。
_CHAR_REPEAT_RUN = re.compile(r"([^\s.。…\-~])\1{4,}")

_PUNCT_STRIP = re.compile(r"[\s，,。.、：:；;！!？?（）()「」『』\"'“”‘’]")

# F3. 多詞循環／低多樣性清單退化：Whisper 對長專有名詞清單常吐成週期性清單——
#   「MOM、ERP、載具、REEL、MOM、ERP、載具、REEL…」（多 token 循環）或
#   「CM、電話：CM、電話：CM、電話…」（重複單元的分隔符裡夾了字母，如「：CM、」）。
#   F/F2 的 regex 只抓「單一 token 緊鄰重複」，重複單元一旦跨了分隔符或本身是多個 token 的循環就整段漏網
#   （實測就是這兩種佔了殘留幻覺的大宗）。這裡改用結構性偵測：用標點/空白切成 token，
#   token 夠多（≥10）且相異 token 佔比過低（≤0.35）＝這段就是空轉清單、無實質資訊 → 整段丟。
#   真人列舉多為相異詞（佔比高，接近 1.0），不會誤傷；門檻 10 個 token 才啟動，也避開「對、對、對」這種短自然三連。
_LIST_SPLIT = re.compile(r"[、，,：:；;／/｜|\s]+")


def _has_token_cycle(text):
    """token 序列裡有「長度 2~6 的多詞區塊連續重複 ≥3 次」的循環（如「MOM、ERP、載具、REEL」× n）。
    這比「相異佔比」更精準：能抓到「回吐前綴＋循環清單尾」混在同一段的情形（前綴會拉高相異佔比、
    讓純比例法漏掉），又不會誤傷「合格、合格…」這種單詞重複（那由 _collapse_repeat_runs 處理）。
    """
    tokens = [t for t in _LIST_SPLIT.split(text) if t]
    n = len(tokens)
    for p in range(2, 7):
        if n < 3 * p:
            break
        streak = 0
        for k in range(n - p):
            if tokens[k] == tokens[k + p]:
                streak += 1
                if streak >= 2 * p:        # 連續 2p 個位置吻合 ＝ 該 p 詞區塊至少重複 3 次
                    return True
            else:
                streak = 0
    return False


def _is_degenerate_list(text):
    tokens = [t for t in _LIST_SPLIT.split(text) if t]
    if len(tokens) >= 10 and len(set(tokens)) / len(tokens) <= 0.35:
        return True
    return _has_token_cycle(text)



# 音訊主題（compileTopic, audio-topics.js）組出的 prompt 除了固定指示語句，還會塞這場會議
# 自己的人名/專有名詞清單（如 MES、MOM、SPC…）——那份清單本來就是特意餵給模型、讓它認得
# 「會議中真的會被講到」的詞。若拿轉錄文字去比對「整份 prompt 的子字串」，與會者逐項照唸
# 這些術語時的真話會剛好變成清單子字串而被誤判回吐、整段吃掉（實測案例：會議唸 MES、MOM、
# SPC 等術語的段落無故消失，見對話討論）。改成只認這些「後設指示語句」（compileTopic 固定
# 版型的文字，跟 DEFAULT_PUNCT_PROMPT_ZH 一樣，是真人對話絕不會照樣講出口的內容），不比對
# 隨主題變動的動態詞彙表。
_PROMPT_SCAFFOLD_MARKERS = tuple(_PUNCT_STRIP.sub("", m) for m in (
    "這是一段繁體中文的",
    "請以自然的繁體中文辨識",
    "常見人名：",
    "常見專有名詞：",
    "保持這些拼法",
    "以下是一段中文對話",
    "語氣自然，包含逗號",
))

# 鷹架句「整句」正規化版（去標點），供模糊回吐比對用。實測 Whisper 回吐 prompt 時不是逐字照抄，
# 而是「漂移／改寫」：「請以自然的繁體中文辨識」被吐成「請以自然的繁體訪問」「請以自然的繁體名字」；
# 「這是一段繁體中文的…請以自然的繁體中文辨識」被吐成「這段繁體中文的需求…請以自然的繁體中文的需求」。
# 精確子字串比對（上面 _PROMPT_SCAFFOLD_MARKERS）抓不到這種漂移，故加一層「片段覆蓋率」模糊比對：
# 看這段文字有多少比例的字，落在「與某句鷹架共有的 ≥3 連續字元」片段裡；比例夠高＝這段幾乎是由
# 鷹架碎片拼成的回吐 → 整段丟。門檻設在 0.6，實測能濾掉上述漂移回吐，又保留真正在談「繁體中文
# 辨識」功能的真話（如「我們要辨識繁體中文」覆蓋率僅 ~0.44，不會誤傷）。
_SCAFFOLD_ECHO_SENTENCES = tuple(_PUNCT_STRIP.sub("", s) for s in (
    "這是一段繁體中文的對話可能夾雜少量英文工具名請以自然的繁體中文辨識包含適當標點",
    "以下是一段中文對話語氣自然包含逗號句號問號等標點符號",
    "常見人名常見專有名詞保持這些拼法",
))


def _scaffold_echo_ratio(nt):
    """nt（已去標點）中，有多少比例的字元落在「與某句鷹架共有的 ≥3 連續字元」片段裡（取各句最大值）。
    以貪婪最長匹配逐字掃描：每個位置找從此起、最長且出現在鷹架句中的子字串（≥3 才算），覆蓋之。
    """
    n = len(nt)
    if n == 0:
        return 0.0
    best = 0.0
    for S in _SCAFFOLD_ECHO_SENTENCES:
        covered = 0
        i = 0
        while i < n:
            j = n
            hit = 0
            while j - i >= 3:
                if nt[i:j] in S:
                    hit = j - i
                    break
                j -= 1
            if hit:
                covered += hit
                i += hit
            else:
                i += 1
        best = max(best, covered / n)
    return best


def _looks_like_prompt_echo(text, prompt=None):
    """text（正規化去標點後）是 prompt 鷹架句的回吐（精確或漂移）→ 判定回吐、整段丟棄。"""
    if not text:
        return False
    nt = _PUNCT_STRIP.sub("", text)
    if len(nt) < 4:
        return False
    if any(marker in nt for marker in _PROMPT_SCAFFOLD_MARKERS):
        return True
    return _scaffold_echo_ratio(nt) >= 0.6


def _collapse_repeat_runs(text):
    """把「同詞連續重複 4 次以上」的退化輸出收斂成一次；一段裡若這種重複片段占比過高，視為
    整段空轉，回傳空字串（真人對話不會連續講同一詞 4 次以上）。
    """
    if not text:
        return text
    total_repeat_len = (sum(len(m.group(0)) for m in _REPEAT_RUN.finditer(text))
                         + sum(len(m.group(0)) for m in _CHAR_REPEAT_RUN.finditer(text)))
    if total_repeat_len == 0:
        return text
    if total_repeat_len >= len(text) * 0.5:
        return ""
    text = _REPEAT_RUN.sub(lambda m: m.group(1), text)
    text = _CHAR_REPEAT_RUN.sub(lambda m: m.group(1), text)
    return text


def _scrub_hallucination(text, prompt=None):
    """移除 Whisper 在無語音段吐的幻覺輸出；回傳清理後文字（可能為空字串）。

    四層，彼此獨立、互不取代：
      1. prompt 回吐（精確或漂移改寫，含 audio-topic 動態內容）→ 整段丟棄。
      2. 多詞循環／低多樣性清單退化（如「MOM、ERP、載具、REEL、MOM…」）→ 整段丟棄。
      3. 同詞連續重複 4 次以上的空轉退化 → 收斂或整段丟棄。
      4. YouTube 罐頭字幕固定字面黑名單（A~E）。
    沒命中任何一層 → 原封不動回傳（不去動正常內容的標點）。
    """
    if not text:
        return text
    if _looks_like_prompt_echo(text, prompt):
        return ""
    if _is_degenerate_list(text):
        return ""
    cleaned = _collapse_repeat_runs(text)
    if not cleaned:
        return cleaned
    for _ in range(3):
        before = cleaned
        for pat in _HALLUCINATION_PATTERNS:
            cleaned = pat.sub("", cleaned)
        if cleaned == before:
            break
    if cleaned == text:
        return text
    cleaned = re.sub(r"[、，,]{2,}", "，", cleaned)   # 中間被挖空造成的連續逗號收斂成一個
    cleaned = _LEFTOVER_EDGE.sub("", cleaned).strip()
    if _TRIVIAL_RESIDUE.match(cleaned):
        return ""
    return cleaned


def _get_model(model_size):
    if model_size not in _MODEL_CACHE:
        from faster_whisper import WhisperModel
        device, compute_type = _detect_device()
        # 有 GPU 用 cuda+float16（快且準）；沒有退回原本驗證過的 CPU+int8。
        _MODEL_CACHE[model_size] = WhisperModel(
            model_size, device=device, compute_type=compute_type,
            download_root=MODEL_DOWNLOAD_ROOT,
        )
    return _MODEL_CACHE[model_size]


def _to_traditional(text):
    """簡體 → 台灣繁體（含用語轉換，如 '程序'→'程式'）。Whisper 預設吐簡體。"""
    global _OPENCC
    if not text:
        return text
    try:
        if _OPENCC is None:
            from opencc import OpenCC
            _OPENCC = OpenCC("s2twp")
        return _OPENCC.convert(text)
    except Exception as e:
        # OpenCC 缺失不該讓整條鏈死掉：退回原文，但在 stderr 留痕。
        print("[stt] OpenCC 轉繁失敗，退回原文：%s" % e, file=sys.stderr)
        return text


def transcribe_file(audio_path, lang="auto", model_size="medium", initial_prompt=None, beam_size=5):
    if not audio_path or not os.path.exists(audio_path):
        raise FileNotFoundError("找不到音檔：%s" % audio_path)

    model = _get_model(model_size)
    language = None if (not lang or lang == "auto") else lang
    prompt = initial_prompt
    # 音訊主題（initial_prompt）與中文標點誘導的合併策略（SPEC-audio-topic §5 AT1）：
    # 呼叫端帶了主題 prompt 且語言為中文/auto 時，把標點宣告句併到主題「前面」，讓「選了主題」
    # 不會失去「中文補標點」的好處；沒帶主題則沿用原本的純標點誘導。非中文只用呼叫端的 prompt
    # （或None），不套中文標點句。
    if lang in (None, "auto", "zh"):
        prompt = (DEFAULT_PUNCT_PROMPT_ZH + "\n" + prompt) if prompt else DEFAULT_PUNCT_PROMPT_ZH
    segments_iter, info = model.transcribe(
        audio_path,
        language=language,
        initial_prompt=prompt,
        vad_filter=True,             # 去靜音段，降低空轉與幻聽；參數放寬見 VAD_PARAMETERS 註解
        vad_parameters=VAD_PARAMETERS,
        no_speech_threshold=NO_SPEECH_THRESHOLD,
        beam_size=beam_size,        # 互動路徑用 1（greedy，短句夠準又快）；會議可用 5
        temperature=0,              # 關掉預設的升溫 fallback 階梯（[0,0.2…1.0]）——難段升溫正是胡言亂語主因，固定 0 最穩
    )

    detected = info.language if info and getattr(info, "language", None) else (language or "")
    is_zh = (detected or "").lower().startswith("zh")

    segments = []
    parts = []
    for seg in segments_iter:
        t = seg.text or ""
        if is_zh:
            t = _to_traditional(t)
        t = t.strip()
        t = _scrub_hallucination(t, prompt)   # 濾掉 prompt 回吐／重複空轉／YouTube 罐頭幻覺
        segments.append({"start": float(seg.start), "end": float(seg.end), "text": t})
        if t:
            parts.append(t)

    # 中文段間不加空白；其餘語言以空白接合。
    text = ("" if is_zh else " ").join(parts).strip()
    duration = float(getattr(info, "duration", 0.0) or 0.0)
    return {"text": text, "language": detected, "duration": duration, "segments": segments}


def _serve(default_model):
    """常駐模式（F4/F5 延遲修正）：模型只載一次，之後從 stdin 逐行讀 JSON 請求、回 JSON 行。

    每行請求：{"id":N, "audio":path, "lang":"zh", "model":"medium", "beam_size":1, "prompt":null}
    每行回應：{"id":N, "text":..., "language":..., "duration":..., "segments":[...]}  或  {"id":N,"error":...}
    stdout 只寫 JSON 行；所有 log 走 stderr（不可污染 stdout，否則 node 端 JSON.parse 會炸）。
    """
    try:
        _get_model(default_model)   # 啟動時預載 → 連第一個請求都免重載
    except Exception as e:
        print("[stt] 預載模型失敗：%s" % e, file=sys.stderr)
    print("[stt] serve ready (model=%s)" % default_model, file=sys.stderr)
    sys.stderr.flush()
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        rid = None
        try:
            req = json.loads(line)
            rid = req.get("id")
            result = transcribe_file(
                req.get("audio"),
                lang=req.get("lang", "auto"),
                model_size=req.get("model", default_model),
                initial_prompt=req.get("prompt"),
                beam_size=int(req.get("beam_size", 5)),
            )
            result["id"] = rid
            sys.stdout.write(json.dumps(result, ensure_ascii=False) + "\n")
        except Exception as e:
            sys.stdout.write(json.dumps({"id": rid, "error": str(e)}, ensure_ascii=False) + "\n")
        sys.stdout.flush()
    return 0


def _main(argv):
    ap = argparse.ArgumentParser(description="STT：音檔 → 文字（繁體後處理）")
    ap.add_argument("audio", nargs="?", help="輸入音檔路徑（wav/mp3/ogg/...）；--serve 模式可省略")
    ap.add_argument("--lang", default="auto", help="auto | zh | en | ...")
    ap.add_argument("--model", default="medium", help="tiny/base/small/medium/large-v3")
    ap.add_argument("--prompt", default=None, help="領域詞彙（人名/術語）提升準度")
    ap.add_argument("--beam-size", type=int, default=5, help="互動短句建議 1（greedy）；會議用 5")
    ap.add_argument("--serve", action="store_true", help="常駐模式：模型載一次，從 stdin 逐行收 JSON 請求")
    args = ap.parse_args(argv)
    if args.serve:
        return _serve(args.model)
    if not args.audio:
        ap.error("需要 audio 路徑（或加 --serve 進常駐模式）")
    result = transcribe_file(args.audio, lang=args.lang, model_size=args.model,
                             initial_prompt=args.prompt, beam_size=args.beam_size)
    # 單行 JSON 到 stdout（node 端 JSON.parse）。ensure_ascii=False 保留中文原樣。
    sys.stdout.write(json.dumps(result, ensure_ascii=False))
    sys.stdout.flush()
    return 0


if __name__ == "__main__":
    try:
        sys.exit(_main(sys.argv[1:]))
    except Exception as e:
        print("[stt] 錯誤：%s" % e, file=sys.stderr)
        sys.exit(1)
