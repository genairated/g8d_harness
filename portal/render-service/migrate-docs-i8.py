#!/usr/bin/env python3
# DOC-I8-01 — 舊 md 回填：把客戶專案現有 md 納入 .documents/ registry
# 用法：python migrate-docs-i8.py
# 工作區根目錄硬寫為客戶專案（D:/Projects/客戶專案）
# 執行後產生 .documents/index.json + 各 <uuid>/ 資料夾
import os, sys, json, uuid, shutil, re
from datetime import datetime, timezone

WORKSPACE_ROOT = r"D:\Projects\客戶專案"
MD_SRC_DIR     = os.path.join(WORKSPACE_ROOT, "情境流程_md")
DOCX_SRC_DIR   = os.path.join(WORKSPACE_ROOT, "情境流程_客戶專案")
DOCS_DIR       = os.path.join(WORKSPACE_ROOT, ".documents")
INDEX_PATH     = os.path.join(DOCS_DIR, "index.json")

def read_registry():
    if os.path.exists(INDEX_PATH):
        with open(INDEX_PATH, encoding="utf-8") as f:
            return json.load(f)
    return {"documents": []}

def write_registry(reg):
    os.makedirs(DOCS_DIR, exist_ok=True)
    with open(INDEX_PATH, "w", encoding="utf-8") as f:
        json.dump(reg, f, ensure_ascii=False, indent=2)

def parse_frontmatter(content):
    m = re.match(r'^---\r?\n([\s\S]*?)\r?\n---\r?\n?', content)
    if not m:
        return {}, content
    meta = {}
    for line in m.group(1).split("\n"):
        mm = re.match(r'^(\w+):\s*(.*)', line)
        if mm:
            val = mm.group(2).strip()
            if val.startswith("[") and val.endswith("]"):
                val = [s.strip() for s in val[1:-1].split(",") if s.strip()]
            meta[mm.group(1)] = val
    body = content[m.end():]
    return meta, body

def stringify_frontmatter(meta):
    lines = []
    for k, v in meta.items():
        if isinstance(v, list):
            lines.append(f"{k}: [{', '.join(v)}]")
        else:
            lines.append(f"{k}: {v}")
    return "---\n" + "\n".join(lines) + "\n---\n"

def extract_title(body, filename_stem):
    m = re.search(r'^#\s+(.+)$', body, re.MULTILINE)
    if m:
        return m.group(1).strip()
    return filename_stem

def find_docx(md_stem):
    """Try to find matching docx by replacing .md extension with .docx."""
    candidate = md_stem + ".docx"
    full = os.path.join(DOCX_SRC_DIR, candidate)
    if os.path.exists(full):
        return candidate, "情境流程_客戶專案/" + candidate
    return None, None

def is_already_registered(reg, source_path):
    for d in reg["documents"]:
        if d.get("sourcePath") == source_path:
            return True
    return False

def migrate():
    if not os.path.isdir(MD_SRC_DIR):
        print(f"ERROR: md source dir not found: {MD_SRC_DIR}")
        sys.exit(1)

    reg = read_registry()
    now = datetime.now(timezone.utc).isoformat()

    md_files = [
        f for f in os.listdir(MD_SRC_DIR)
        if f.endswith(".md") and os.path.isfile(os.path.join(MD_SRC_DIR, f))
    ]
    md_files.sort()

    ok = skip = err = 0

    for md_fname in md_files:
        md_stem = md_fname[:-3]  # strip .md
        md_full = os.path.join(MD_SRC_DIR, md_fname)

        _docx_name, source_path = find_docx(md_stem)

        # If no matching docx found, use a placeholder path (源檔名未找到)
        if source_path is None:
            source_path = "情境流程_客戶專案/" + md_stem + ".docx"
            print(f"  [WARN] No matching docx for: {md_fname} → sourcePath placeholder: {source_path}")

        # Skip already registered
        if is_already_registered(reg, source_path):
            print(f"  [SKIP] Already in registry: {md_fname}")
            skip += 1
            continue

        try:
            # Read md content
            with open(md_full, encoding="utf-8") as f:
                content = f.read()

            existing_meta, body = parse_frontmatter(content)
            title = existing_meta.get("title") or extract_title(body, md_stem)

            # Generate UUID + create dirs
            doc_id = str(uuid.uuid4())
            doc_dir = os.path.join(DOCS_DIR, doc_id)
            os.makedirs(os.path.join(doc_dir, "assets"),  exist_ok=True)
            os.makedirs(os.path.join(doc_dir, "exports"), exist_ok=True)

            # Build front-matter (preserve existing keys, add missing)
            meta = {**existing_meta, **{
                "type":        existing_meta.get("type", "doc"),
                "title":       title,
                "source":      source_path,
                "convertedAt": existing_meta.get("convertedAt", now),
                "export":      existing_meta.get("export", ["docx", "pdf"]),
            }}
            # Ensure key order: type, title, source, convertedAt, export
            ordered = {}
            for k in ["type", "title", "source", "convertedAt", "export"]:
                if k in meta:
                    ordered[k] = meta[k]
            for k, v in meta.items():
                if k not in ordered:
                    ordered[k] = v

            new_content = stringify_frontmatter(ordered) + body
            dest_md = os.path.join(doc_dir, "doc.md")
            with open(dest_md, "w", encoding="utf-8") as f:
                f.write(new_content)

            # mdPath relative to workspace root
            md_path_rel = ".documents/" + doc_id + "/doc.md"

            # Update registry
            reg["documents"].append({
                "id":          doc_id,
                "title":       title,
                "sourcePath":  source_path,
                "mdPath":      md_path_rel,
                "type":        ordered.get("type", "doc"),
                "exports":     [],
                "convertedAt": now,
                "updatedAt":   now,
            })

            print(f"  [OK] {md_fname} → {doc_id}/doc.md  (source: {source_path})")
            ok += 1

        except Exception as e:
            print(f"  [ERR] {md_fname}: {e}")
            err += 1

    write_registry(reg)
    print(f"\n完成：{ok} 成功，{skip} 略過，{err} 失敗")
    print(f"Registry: {INDEX_PATH}")

if __name__ == "__main__":
    migrate()
