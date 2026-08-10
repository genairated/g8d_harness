# -*- coding: utf-8 -*-
"""gmail_bridge.py — 薄橋接：連 Gmail、抓信、建草稿、(受控)刪信 / 貼標。

規格：specs/SPEC-gmail.md（v1.0）。這是該 spec 唯一要寫的新 code。

單一職責：把 Gmail REST 的手腳包成一支 CLI 工具，Hana 在排程/指令中用 shell 呼叫、
讀它的單行 JSON 輸出（比照 stt.py 等 render-service 工具的模式；走 harness 共用 venv）。
「智慧」（看信判斷真垃圾/誤判/要回覆）在 Hana，不在這支程式。

安全鐵律（本檔負責落實的部分）：
  · 憑證不外洩：token 值（access / refresh）**永不進 stdout、stderr、log**；只讀寫 secrets 檔。
  · 讀自動、動要核准：list-spam / get / create-draft 是「唯讀 + 建草稿」，可自動跑；
    trash / add-label / remove-label 是「能力」，預設不被自動呼叫——**只在指揮官指令路徑用**
    （見下方 _DESTRUCTIVE / DEFAULT-OFF 說明），本檔不自己決定何時呼叫。
  · get 只抽純文字：**不 render HTML、不執行、不抓任何外部資源**（不下載圖片/不跟連結）。
  · create-draft 只建草稿、**絕不寄出**（v1 不實作 send）。
  · email＝不信任輸入：本橋接只「原樣取回文字」；是否被信件內文操縱（prompt injection）由
    上層 Hana 判斷時警惕，橋接不依信件內容做任何動作。

相依：**零新增**。只用 harness 共用 venv 既有的 `google-auth`（Credentials + AuthorizedSession）
      與 `requests`；不裝 `google-api-python-client`（REST 直打即可，取最小相依）。故無新 pip 相依
      需登記進 /setup（SPEC-setup §13）——本檔刻意不引入任何新套件。

CLI：
    python gmail_bridge.py list-spam [--max N]
    python gmail_bridge.py get <messageId>
    python gmail_bridge.py create-draft --to <addr> --subject <s> --body <b> [--reply-to <messageId>]
    python gmail_bridge.py trash <messageId>            # 破壞性、受控（只在指揮官指令路徑）
    python gmail_bridge.py add-label <messageId> --label <name>      # 非破壞、受控
    python gmail_bridge.py remove-label <messageId> --label <name>   # 非破壞、受控
  成功 → 單行 JSON 到 stdout；錯誤 → stderr + 非 0 exit。

鐵律：寫檔/輸出一律 utf-8（Windows console 是 cp950）。
"""
import sys
import os
import re
import json
import base64
import argparse
from email.mime.text import MIMEText
from email.utils import formataddr

# Windows console 是 cp950，印中文會炸 → 強制 stdout/stderr 走 utf-8（比照 stt.py）。
try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:
    pass

# ── 路徑：secrets 走 HARNESS_HOME 組，不寫死機器路徑（開源友善）──────────────
# 本檔在 portal/render-service/ 底下 → 往上三層是 harness 根目錄（HARNESS_HOME 未設時的 fallback）。
ROOT = os.environ.get("HARNESS_HOME") or os.path.dirname(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
)
SECRETS = os.path.join(ROOT, "global-knowledge", "secrets")
TOKEN_PATH = os.path.join(SECRETS, "gmail_token.json")

# 完整 Gmail 存取（read / send / modify / delete）——與 gmail_authorize.py 授權時的 scope 一致。
SCOPES = ["https://mail.google.com/"]

API = "https://gmail.googleapis.com/gmail/v1/users/me"

# 破壞性 / 受控子指令：預設不被自動流程呼叫；只有指揮官明確指令的呼叫路徑才會帶這些子指令進來。
# 這裡列出只是為了「文件化 + 未來若要加自動化護欄時有單一事實來源」，橋接本身不做時間/來源判斷——
# 「何時呼叫」由上層（Hana 依指揮官指令）決定，符合 spec「動要核准」。
_CONTROLLED = {"trash", "add-label", "remove-label"}
_DESTRUCTIVE = {"trash"}  # 真正不可逆（移垃圾桶）；add/remove-label 只是貼標、可還原。


# ── 憑證：讀 token → 需要時自動 refresh（寫回檔案）→ 回一個 AuthorizedSession ──────
def _load_session():
    """讀 secrets 的 refresh token，換/續 access token，回 AuthorizedSession。

    token 值全程留在 Credentials 物件與 secrets 檔內，**不進任何輸出**。
    """
    if not os.path.exists(TOKEN_PATH):
        raise FileNotFoundError(
            "找不到 gmail_token.json（請先跑 gmail_authorize.py 完成 OAuth）：" + TOKEN_PATH
        )
    from google.oauth2.credentials import Credentials
    from google.auth.transport.requests import Request, AuthorizedSession

    creds = Credentials.from_authorized_user_file(TOKEN_PATH, SCOPES)
    # 過期且有 refresh token → 續一張新的 access token，並寫回檔案（下次免再換）。
    if not creds.valid:
        if creds.expired and creds.refresh_token:
            creds.refresh(Request())
            # to_json() 內含 refresh/access token → 只寫進 git-ignored 的 secrets 檔，絕不印出。
            with open(TOKEN_PATH, "w", encoding="utf-8") as f:
                f.write(creds.to_json())
        else:
            raise RuntimeError("憑證無效且無法 refresh（refresh_token 缺失或已撤銷，請重跑授權）。")
    return AuthorizedSession(creds)


def _api(session, method, path, **kwargs):
    """打一個 Gmail REST 呼叫；非 2xx → 拋錯（錯誤訊息不含 token，Authorization 由 session 內部帶）。"""
    url = path if path.startswith("http") else (API + path)
    resp = session.request(method, url, timeout=30, **kwargs)
    if resp.status_code // 100 != 2:
        # 只帶 Gmail 回的錯誤主體（不含我方 token）。截斷避免超長。
        detail = (resp.text or "")[:500]
        raise RuntimeError("Gmail API %s %s → HTTP %d：%s" % (method, path, resp.status_code, detail))
    if resp.status_code == 204 or not resp.content:
        return {}
    return resp.json()


# ── 純文字抽取：走 MIME 樹只收 text/plain；沒有純文字才退而把 HTML 去標籤（不 render、不抓外部）──
def _b64url_decode(data):
    if not data:
        return ""
    # Gmail 的 body.data 是 urlsafe base64、可能少 padding。
    pad = "=" * (-len(data) % 4)
    try:
        return base64.urlsafe_b64decode(data + pad).decode("utf-8", "replace")
    except Exception:
        return ""


def _strip_html(html):
    """把 HTML 粗略去成純文字：移除 script/style、拿掉標籤、還原基本 entity。
    **不 render、不跟任何連結、不抓外部資源**——純字串處理。
    """
    if not html:
        return ""
    html = re.sub(r"(?is)<(script|style)[^>]*>.*?</\1>", " ", html)
    html = re.sub(r"(?i)<br\s*/?>", "\n", html)
    html = re.sub(r"(?i)</p>", "\n", html)
    text = re.sub(r"(?s)<[^>]+>", " ", html)
    for a, b in (("&nbsp;", " "), ("&amp;", "&"), ("&lt;", "<"),
                 ("&gt;", ">"), ("&quot;", '"'), ("&#39;", "'")):
        text = text.replace(a, b)
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n\s*\n\s*\n+", "\n\n", text)
    return text.strip()


def _walk_bodies(payload, plain_parts, html_parts):
    mime = (payload or {}).get("mimeType", "") or ""
    body = (payload or {}).get("body", {}) or {}
    data = body.get("data")
    if mime.startswith("multipart/"):
        for part in payload.get("parts", []) or []:
            _walk_bodies(part, plain_parts, html_parts)
    elif mime == "text/plain" and data:
        plain_parts.append(_b64url_decode(data))
    elif mime == "text/html" and data:
        html_parts.append(_b64url_decode(data))
    elif data and mime.startswith("text/"):
        plain_parts.append(_b64url_decode(data))


def _extract_text(payload):
    plain, html = [], []
    _walk_bodies(payload, plain, html)
    if plain:
        return "\n".join(p for p in plain if p).strip(), "plain"
    if html:
        return _strip_html("\n".join(html)), "html-stripped"
    return "", "none"


def _headers_map(payload):
    out = {}
    for h in (payload or {}).get("headers", []) or []:
        out[(h.get("name") or "").lower()] = h.get("value") or ""
    return out


# ── 子指令 ──────────────────────────────────────────────────────────────────
def cmd_list_spam(session, args):
    max_n = max(1, min(int(args.max), 100))
    listing = _api(session, "GET", "/messages",
                   params={"labelIds": "SPAM", "maxResults": max_n})
    ids = [m["id"] for m in (listing.get("messages") or [])]
    items = []
    for mid in ids:
        # metadata 格式只取表頭 → 快、且不下載內文附件。
        msg = _api(session, "GET", "/messages/%s" % mid,
                   params={"format": "metadata",
                           "metadataHeaders": ["From", "Subject", "Date"]})
        hdr = _headers_map(msg.get("payload"))
        items.append({
            "id": mid,
            "threadId": msg.get("threadId"),
            "from": hdr.get("from", ""),
            "subject": hdr.get("subject", ""),
            "date": hdr.get("date", ""),
            "snippet": msg.get("snippet", ""),
        })
    return {"labelIds": ["SPAM"], "count": len(items), "messages": items}


def cmd_get(session, args):
    msg = _api(session, "GET", "/messages/%s" % args.id, params={"format": "full"})
    payload = msg.get("payload") or {}
    hdr = _headers_map(payload)
    text, source = _extract_text(payload)
    return {
        "id": msg.get("id"),
        "threadId": msg.get("threadId"),
        "labelIds": msg.get("labelIds", []),
        "from": hdr.get("from", ""),
        "to": hdr.get("to", ""),
        "subject": hdr.get("subject", ""),
        "date": hdr.get("date", ""),
        "snippet": msg.get("snippet", ""),
        "bodyText": text,        # 只純文字；無外部資源、無 HTML render
        "bodySource": source,    # plain | html-stripped | none
    }


def cmd_create_draft(session, args):
    # 若是回覆，抓原信表頭以正確串接 thread（In-Reply-To / References / 相同 Subject 前綴）。
    thread_id = None
    in_reply_to = None
    references = None
    if args.reply_to:
        orig = _api(session, "GET", "/messages/%s" % args.reply_to,
                    params={"format": "metadata",
                            "metadataHeaders": ["Message-ID", "References", "Subject"]})
        thread_id = orig.get("threadId")
        oh = _headers_map(orig.get("payload"))
        in_reply_to = oh.get("message-id")
        references = (oh.get("references", "") + " " + (in_reply_to or "")).strip() or in_reply_to

    mime = MIMEText(args.body, "plain", "utf-8")
    mime["To"] = args.to
    mime["Subject"] = args.subject
    if in_reply_to:
        mime["In-Reply-To"] = in_reply_to
    if references:
        mime["References"] = references
    raw = base64.urlsafe_b64encode(mime.as_bytes()).decode("ascii")

    message = {"raw": raw}
    if thread_id:
        message["threadId"] = thread_id
    created = _api(session, "POST", "/drafts", json={"message": message})
    # **只建草稿、不寄**。回傳 draftId 供上層記錄/報告。
    return {
        "action": "create-draft",
        "sent": False,
        "draftId": created.get("id"),
        "messageId": (created.get("message") or {}).get("id"),
        "threadId": (created.get("message") or {}).get("threadId"),
        "to": args.to,
        "subject": args.subject,
        "replyTo": args.reply_to,
    }


def _resolve_label_id(session, name, create_if_missing=False):
    labels = _api(session, "GET", "/labels").get("labels", []) or []
    for lb in labels:
        if (lb.get("name") or "").lower() == name.lower():
            return lb.get("id")
    if create_if_missing:
        made = _api(session, "POST", "/labels",
                    json={"name": name, "labelListVisibility": "labelShow",
                          "messageListVisibility": "show"})
        return made.get("id")
    return None


def cmd_trash(session, args):
    # 破壞性、受控：移到垃圾桶。只有指揮官指令路徑會帶 `trash` 子指令進來。
    _api(session, "POST", "/messages/%s/trash" % args.id)
    return {"action": "trash", "id": args.id, "trashed": True}


def cmd_add_label(session, args):
    lid = _resolve_label_id(session, args.label, create_if_missing=True)
    _api(session, "POST", "/messages/%s/modify" % args.id,
         json={"addLabelIds": [lid]})
    return {"action": "add-label", "id": args.id, "label": args.label, "labelId": lid}


def cmd_remove_label(session, args):
    lid = _resolve_label_id(session, args.label, create_if_missing=False)
    if not lid:
        raise RuntimeError("找不到標籤：%s" % args.label)
    _api(session, "POST", "/messages/%s/modify" % args.id,
         json={"removeLabelIds": [lid]})
    return {"action": "remove-label", "id": args.id, "label": args.label, "labelId": lid}


def _build_parser():
    ap = argparse.ArgumentParser(description="Gmail 薄橋接（唯讀+建草稿為自動可用；trash/label 受控）")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("list-spam", help="列 Spam 匣（id/from/subject/date/snippet）")
    p.add_argument("--max", default=25, help="最多列幾封（1~100）")
    p.set_defaults(func=cmd_list_spam)

    p = sub.add_parser("get", help="取單封純文字內文（不 render HTML、不抓外部資源）")
    p.add_argument("id", help="messageId")
    p.set_defaults(func=cmd_get)

    p = sub.add_parser("create-draft", help="建 Gmail 草稿（不寄出）")
    p.add_argument("--to", required=True)
    p.add_argument("--subject", required=True)
    p.add_argument("--body", required=True)
    p.add_argument("--reply-to", dest="reply_to", default=None, help="要回覆的原信 messageId（串 thread）")
    p.set_defaults(func=cmd_create_draft)

    p = sub.add_parser("trash", help="[受控/破壞性] 移到垃圾桶——只在指揮官指令路徑用")
    p.add_argument("id", help="messageId")
    p.set_defaults(func=cmd_trash)

    p = sub.add_parser("add-label", help="[受控/非破壞] 貼標籤（不存在則建立）——只在指揮官指令路徑用")
    p.add_argument("id", help="messageId")
    p.add_argument("--label", required=True)
    p.set_defaults(func=cmd_add_label)

    p = sub.add_parser("remove-label", help="[受控/非破壞] 移除標籤——只在指揮官指令路徑用")
    p.add_argument("id", help="messageId")
    p.add_argument("--label", required=True)
    p.set_defaults(func=cmd_remove_label)
    return ap


def _main(argv):
    ap = _build_parser()
    args = ap.parse_args(argv)
    session = _load_session()
    result = args.func(session, args)
    # 單行 JSON 到 stdout（比照 stt.py；上層 JSON.parse）。ensure_ascii=False 保留中文。
    sys.stdout.write(json.dumps(result, ensure_ascii=False))
    sys.stdout.flush()
    return 0


if __name__ == "__main__":
    try:
        sys.exit(_main(sys.argv[1:]))
    except Exception as e:
        # 錯誤走 stderr（不含 token；Authorization 從不出現在例外訊息裡）。
        print("[gmail_bridge] 錯誤：%s" % e, file=sys.stderr)
        sys.exit(1)
