#!/usr/bin/env python3
"""
DTS-A (SPEC-document-templates.md §8.1): 範本真身（版式外殼）抽取器.

以家族「donor source.docx」為外殼，保留其企業版式（styles / theme / 頁首頁尾 parts + logo media /
sectPr 頁面設定 / numbering），清掉正文，改鋪一份「帶樣式的章節骨架 + 內容錨點 + BPMN 具名錨點」，
輸出 `.templates/<家族>.docx`（範本真身）。**不烤 BPMN 圖進去**，只留具名 bookmark + paraId 錨點，
供 DTS-B（doc-new 注入內容）與 FX-B/C（bake 流程圖 PNG）日後接手。

核心真身方向（勿搞混）：生成文件 doc.md 才是真身，source.docx 是「doc.md + 家族版式外殼」的衍生交付物。
本器只做『抽外殼』——不碰家族既有文件、不烤圖。

保真手法：沿用 image-writeback 的 `_read_zip` / `_write_zip`（逐 part 保留、保留壓縮型別），
只重寫 `word/document.xml` 的 body；其餘 part（styles/theme/header*/footer*/media/numbering/rels/
[Content_Types]）逐 byte 原封複製 → 頁首頁尾/logo/樣式/頁面設定自動保留。

Donor 挑選：從家族各候選 source.docx 中，挑「章節覆蓋最貼近超集骨架、內容最完整」者；平手取頁數最多。
純生成家族（無任何 source.docx）→ 退回 md-to-docx 乾淨版型當外殼，notes 標「此家族無版式外殼」。

用法：
  python docx-template-shell.py build --config <config.json>
  python docx-template-shell.py select-donor --config <config.json>   # 只回報挑選結果不建檔

config.json（由 doc-template skill 依家族分析結果寫出）：
{
  "family": "情境流程",
  "workspace": "D:/Projects/.../客戶專案",           # 用來把輸出路徑正規化成 .templates/ 相對路徑
  "outDocx":  "D:/.../.documents/.templates/情境流程.docx",
  "notesPath":"D:/.../.documents/.templates/情境流程.notes.md",   # 章節樣式對照 append 於此
  "indexPath":"D:/.../.documents/.templates/index.json",
  "donorDocId": null,                             # 可覆寫；null → 自動挑
  "candidates": [                                 # 家族各文件的 donor 候選
    {"docId":"<uuid>", "docx":"<abs source.docx>", "md":"<abs doc.md>"}
  ],
  "chapters": [                                   # 超集骨架（Hana 於步驟 3 歸納）
    {"title":"目的", "level":1, "bookmark":"SEC_目的"},
    {"title":"應用情境流程與解決方案", "level":1, "children":[
        {"title":"流程", "level":2, "bpmn":true, "bpmnSlot":"main", "bpmnLabel":"流程"},
        {"title":"解決方案說明", "level":2, "bookmark":"SEC_解決方案說明"}
    ]},
    ...
  ]
}

stdout: JSON report { ok, donorDocId, isFallback, chapters, anchors, styleMap, frameEmu, outDocx }.
"""
import sys, os, re, json, argparse, importlib.util, tempfile, random as _random
from lxml import etree

# ── namespaces ────────────────────────────────────────────────────────────────
_NS_W   = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
_NS_W14 = 'http://schemas.microsoft.com/office/word/2010/wordml'
_W   = '{%s}' % _NS_W
_W14 = '{%s}' % _NS_W14

_HERE = os.path.dirname(os.path.abspath(__file__))


def _load(mod_name, filename):
    spec = importlib.util.spec_from_file_location(mod_name, os.path.join(_HERE, filename))
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


_imgwb = _load('image_writeback', 'image-writeback.py')   # _read_zip / _write_zip (保真讀寫)

# EMU per inch / per twip (twip = 1/20 pt, 914400 EMU/in, 1440 twip/in → 635 EMU/twip)
_EMU_PER_TWIP = 635
_EMU_PER_IN = 914400


# ── paragraph style analysis (章節→樣式/字型/級數 對照) ──────────────────────────

def _para_styles(styles_root):
    """Return {styleId(original case): {'id','name','level','font','sizePt'}} for paragraph styles
    that resolve a heading outlineLvl (directly or via basedOn). level = outlineLvl+1 (1..9).
    font: eastAsia rFonts (CJK) preferred, else ascii; sizePt from sz/2. Both fall back to docDefaults."""
    # docDefaults (fallback font/size)
    dd_font = dd_size = None
    dd = styles_root.find(_W + 'docDefaults')
    if dd is not None:
        rpr = dd.find(_W + 'rPrDefault')
        rpr = rpr.find(_W + 'rPr') if rpr is not None else None
        if rpr is not None:
            rf = rpr.find(_W + 'rFonts')
            if rf is not None:
                dd_font = rf.get(_W + 'eastAsia') or rf.get(_W + 'ascii')
            sz = rpr.find(_W + 'sz')
            if sz is not None and sz.get(_W + 'val'):
                try: dd_size = int(sz.get(_W + 'val')) / 2.0
                except ValueError: pass

    raw_lvl, based, meta = {}, {}, {}
    for st in styles_root.findall(_W + 'style'):
        if (st.get(_W + 'type') or '') != 'paragraph':
            continue
        sid = st.get(_W + 'styleId')
        if not sid:
            continue
        name_el = st.find(_W + 'name')
        name = name_el.get(_W + 'val') if name_el is not None else sid
        lvl = None
        pPr = st.find(_W + 'pPr')
        if pPr is not None:
            ol = pPr.find(_W + 'outlineLvl')
            if ol is not None:
                try: lvl = int(ol.get(_W + 'val', ''))
                except (TypeError, ValueError): lvl = None
        font = size = None
        rpr = st.find(_W + 'rPr')
        if rpr is not None:
            rf = rpr.find(_W + 'rFonts')
            if rf is not None:
                font = rf.get(_W + 'eastAsia') or rf.get(_W + 'ascii')
            sz = rpr.find(_W + 'sz')
            if sz is not None and sz.get(_W + 'val'):
                try: size = int(sz.get(_W + 'val')) / 2.0
                except ValueError: pass
        raw_lvl[sid] = lvl
        meta[sid] = {'id': sid, 'name': name, 'font': font, 'sizePt': size}
        bo = st.find(_W + 'basedOn')
        if bo is not None:
            based[sid] = bo.get(_W + 'val')

    out = {}
    for sid in raw_lvl:
        cur, seen, lvl = sid, set(), None
        while cur and cur not in seen:            # walk basedOn chain (cycle-safe)
            seen.add(cur)
            if raw_lvl.get(cur) is not None:
                lvl = raw_lvl[cur]; break
            cur = based.get(cur)
        if lvl is None or not (0 <= lvl <= 8):
            continue
        m = dict(meta[sid])
        m['level'] = lvl + 1
        m['font'] = m['font'] or dd_font
        m['sizePt'] = m['sizePt'] if m['sizePt'] is not None else dd_size
        out[sid] = m
    return out


def _level_to_style(para_styles):
    """{level: styleId} — pick, per level, the style whose name looks most like 'heading N' / '標題 N'."""
    best = {}
    for sid, m in para_styles.items():
        lvl = m['level']; nm = m['name'] or ''
        pref = bool(re.search(r'heading\s*%d\b' % lvl, nm.lower()) or ('標題' in nm and str(lvl) in nm))
        rank = 1 if pref else 0
        if lvl not in best or rank > best[lvl][1]:
            best[lvl] = (sid, rank)
    return {lvl: v[0] for lvl, v in best.items()}


# ── donor selection ───────────────────────────────────────────────────────────

def _md_headings(md_path):
    out = []
    try:
        with open(md_path, encoding='utf-8') as f:
            for line in f:
                m = re.match(r'^#{1,6}\s+(.*)', line.strip())
                if m:
                    out.append(m.group(1).strip())
    except Exception:
        pass
    return out


def _docx_pages(docx_path):
    """Read docProps/app.xml <Pages> (Word's last-saved page count). 0 if unavailable."""
    try:
        import zipfile
        with zipfile.ZipFile(docx_path) as z:
            if 'docProps/app.xml' not in z.namelist():
                return 0
            app = z.read('docProps/app.xml').decode('utf-8', 'replace')
        m = re.search(r'<Pages>(\d+)</Pages>', app)
        return int(m.group(1)) if m else 0
    except Exception:
        return 0


def _docx_shell(docx_path):
    """Count the version-shell parts we extract: (#header parts, #footer parts, #media parts).
    A donor with headers+footers actually carries the enterprise letterhead/logo — extracting a
    header-less doc would defeat the '版式外殼' purpose, so this drives donor ranking."""
    try:
        import zipfile
        with zipfile.ZipFile(docx_path) as z:
            n = z.namelist()
        return (len([x for x in n if x.startswith('word/header')]),
                len([x for x in n if x.startswith('word/footer')]),
                len([x for x in n if x.startswith('word/media/')]))
    except Exception:
        return (0, 0, 0)


def _norm(s):
    return re.sub(r'\s+', '', s or '')


def select_donor(candidates, chapter_titles):
    """Rank candidates for the version-shell donor. Priority:
      1. hasShell — carries the enterprise letterhead (≥1 header AND ≥1 footer part). A header-less
         doc cannot fulfil '保留頁首頁尾+logo', so shell-bearing donors always outrank content-richer
         header-less ones (§8.1 intent).
      2. coverage — # superset chapters present as headings (representative family member).
      3. completeness — doc.md content length.
      4. pages — Word's last-saved page count (tie-break, per spec 平手取頁數最多).
    Only candidates whose docx exists on disk are eligible. Returns ranked list (best first)."""
    want = {_norm(t) for t in chapter_titles}
    ranked = []
    for c in candidates:
        docx = c.get('docx') or ''
        if not docx or not os.path.exists(docx):
            continue
        heads = {_norm(h) for h in _md_headings(c.get('md') or '')}
        coverage = sum(1 for t in want if t in heads)
        content_len = 0
        md = c.get('md') or ''
        if md and os.path.exists(md):
            try: content_len = len(open(md, encoding='utf-8').read())
            except Exception: content_len = 0
        nh, nf, nm = _docx_shell(docx)
        has_shell = 1 if (nh > 0 and nf > 0) else 0
        ranked.append({'docId': c.get('docId'), 'docx': docx,
                       'hasShell': has_shell, 'headerParts': nh, 'footerParts': nf, 'mediaParts': nm,
                       'coverage': coverage, 'contentLen': content_len,
                       'pages': _docx_pages(docx)})
    ranked.sort(key=lambda r: (r['hasShell'], r['coverage'], r['contentLen'], r['pages']), reverse=True)
    return ranked


# ── shell body building ───────────────────────────────────────────────────────

def _gen_para_id(used):
    while True:
        pid = '%08X' % _random.randint(0, 0xFFFFFFFF)
        if pid not in used:
            used.add(pid)
            return pid


def _existing_para_ids(all_data):
    used = set()
    for name, data in all_data.items():
        if not name.endswith('.xml'):
            continue
        try: s = data.decode('utf-8', 'replace')
        except Exception: continue
        used.update(m.group(1).upper() for m in re.finditer(r'w14:paraId="([0-9A-Fa-f]{8})"', s))
    return used


def _max_bookmark_id(all_data):
    mx = 0
    for name, data in all_data.items():
        if not name.endswith('.xml'):
            continue
        try: s = data.decode('utf-8', 'replace')
        except Exception: continue
        for m in re.finditer(r'<w:bookmarkStart[^>]*\bw:id="(\d+)"', s):
            mx = max(mx, int(m.group(1)))
    return mx


def _flatten(chapters):
    """Depth-first flatten: yield (chapter_dict, is_child)."""
    out = []
    for ch in chapters:
        kids = ch.get('children') or []
        out.append((ch, False, bool(kids)))
        for k in kids:
            out.append((k, True, False))
    return out


def _content_frame_emu(sectPr):
    """Default flow-frame size = content width (page width − L/R margins), height = width × 0.6."""
    w_emu = int(6.1 * _EMU_PER_IN)   # sane A4 default (matches md-to-docx CONTENT_WIDTH_IN)
    if sectPr is not None:
        pgSz = sectPr.find(_W + 'pgSz')
        pgMar = sectPr.find(_W + 'pgMar')
        if pgSz is not None and pgSz.get(_W + 'w'):
            try:
                pw = int(pgSz.get(_W + 'w'))
                ml = int(pgMar.get(_W + 'left')) if (pgMar is not None and pgMar.get(_W + 'left')) else 1440
                mr = int(pgMar.get(_W + 'right')) if (pgMar is not None and pgMar.get(_W + 'right')) else 1440
                w_emu = max(int((pw - ml - mr) * _EMU_PER_TWIP), int(_EMU_PER_IN))
            except (ValueError, TypeError):
                pass
    return {'cx': w_emu, 'cy': int(w_emu * 0.6)}


def build_shell(all_data, chapters, family):
    """Rewrite word/document.xml body into the styled chapter skeleton with anchors, in-place on all_data.
    Returns report dict {chapters, anchors, styleMap, frameEmu}."""
    doc_xml = all_data.get('word/document.xml')
    if not doc_xml:
        raise RuntimeError('donor docx has no word/document.xml')
    root = etree.fromstring(doc_xml)
    body = root.find(_W + 'body')
    if body is None:
        raise RuntimeError('donor docx has no <w:body>')

    styles_root = etree.fromstring(all_data.get('word/styles.xml', b'<x/>'))
    pstyles = _para_styles(styles_root)
    lvl_style = _level_to_style(pstyles)

    used_pids = _existing_para_ids(all_data)
    bmid = _max_bookmark_id(all_data) + 1

    # preserve the trailing body-level sectPr (page size + header/footer references)
    sectPr = None
    for ch in list(body):
        if ch.tag == _W + 'sectPr':
            sectPr = ch
    frame = _content_frame_emu(sectPr)

    # clear every body child (paragraphs / tables / sdt / TOC / cover) — sectPr re-appended last
    for ch in list(body):
        body.remove(ch)

    anchors = []
    style_map = []

    def add_heading(title, level):
        sid = lvl_style.get(level)
        info = pstyles.get(sid) if sid else None
        p = etree.SubElement(body, _W + 'p')
        p.set(_W14 + 'paraId', _gen_para_id(used_pids))
        pPr = etree.SubElement(p, _W + 'pPr')
        if sid:
            ps = etree.SubElement(pPr, _W + 'pStyle'); ps.set(_W + 'val', sid)
        r = etree.SubElement(p, _W + 'r')
        t = etree.SubElement(r, _W + 't'); t.text = title
        style_map.append({
            'title': title, 'level': level,
            'styleId': sid, 'styleName': (info or {}).get('name') if info else None,
            'font': (info or {}).get('font') if info else None,
            'sizePt': (info or {}).get('sizePt') if info else None,
        })

    def add_content_anchor(bookmark, label):
        nonlocal bmid
        p = etree.SubElement(body, _W + 'p')
        pid = _gen_para_id(used_pids)
        p.set(_W14 + 'paraId', pid)
        etree.SubElement(p, _W + 'pPr')            # Normal (正文樣式) → style-donor for doc-new
        bs = etree.SubElement(p, _W + 'bookmarkStart'); bs.set(_W + 'id', str(bmid)); bs.set(_W + 'name', bookmark)
        r = etree.SubElement(p, _W + 'r')
        t = etree.SubElement(r, _W + 't'); t.text = label
        be = etree.SubElement(p, _W + 'bookmarkEnd'); be.set(_W + 'id', str(bmid))
        anchors.append({'kind': 'content', 'bookmark': bookmark, 'paraId': pid, 'bookmarkId': bmid})
        bmid += 1

    def add_bpmn_anchor(slot, label):
        # 外殼是家族層級、無從得知某份文件有幾張流程圖，故每個流程章節只放**一個插入點** `BPMN_<slot>`。
        # 真正的「一流程一槽」在 DTS-B（docx-inject）注入時展開：依該份 doc.md 的 ```bpmn``` fence 數，
        # 把此單一插入點切成 N 個 `BPMN_image<n>` 具名書籤佔位段（唯一知道圖數之處）。
        nonlocal bmid
        name = 'BPMN_%s' % slot
        p = etree.SubElement(body, _W + 'p')
        pid = _gen_para_id(used_pids)
        p.set(_W14 + 'paraId', pid)
        etree.SubElement(p, _W + 'pPr')
        bs = etree.SubElement(p, _W + 'bookmarkStart'); bs.set(_W + 'id', str(bmid)); bs.set(_W + 'name', name)
        r = etree.SubElement(p, _W + 'r')
        t = etree.SubElement(r, _W + 't'); t.text = '〔流程圖：%s〕' % (label or slot)
        be = etree.SubElement(p, _W + 'bookmarkEnd'); be.set(_W + 'id', str(bmid))
        anchors.append({'kind': 'bpmn', 'bookmark': name, 'slot': slot, 'paraId': pid,
                        'bookmarkId': bmid, 'frameEmu': frame})
        bmid += 1

    chapter_names = []
    for ch, is_child, has_kids in _flatten(chapters):
        title = ch.get('title') or ''
        level = int(ch.get('level') or (2 if is_child else 1))
        chapter_names.append(title)
        add_heading(title, level)
        if ch.get('bpmn'):
            add_bpmn_anchor(ch.get('bpmnSlot') or 'main', ch.get('bpmnLabel') or title)
        elif not has_kids:
            bm = ch.get('bookmark') or ('SEC_%s' % _norm(title))
            add_content_anchor(bm, '〔本節內容〕')

    # re-append the preserved sectPr so page setup + header/footer refs survive
    if sectPr is not None:
        body.append(sectPr)

    # ensure w14 namespace is declared (we injected w14:paraId)
    new_xml = etree.tostring(root, xml_declaration=True, encoding='UTF-8', standalone=True)
    all_data['word/document.xml'] = new_xml

    return {'chapters': chapter_names, 'anchors': anchors, 'styleMap': style_map, 'frameEmu': frame}


# ── fallback: clean donor (pure-generation family, no source.docx) ─────────────

def _make_clean_donor():
    """Build a clean-template docx (md-to-docx _setup_template) to use as the shell when the family has
    no source.docx donor. Returns path to a temp .docx (caller reads it via _read_zip)."""
    m2d = _load('md_to_docx', 'md-to-docx.py')
    from docx import Document
    d = Document()
    m2d._setup_template(d)
    d.add_paragraph('placeholder')       # ensure a non-empty body (cleared during build)
    tmp = tempfile.mktemp(suffix='.docx')
    d.save(tmp)
    return tmp


# ── notes + index writing ─────────────────────────────────────────────────────

def _rel_to_workspace(path_abs, workspace):
    if not workspace:
        return path_abs
    try:
        rel = os.path.relpath(path_abs, workspace)
        return rel.replace('\\', '/')
    except Exception:
        return path_abs


def append_notes_stylemap(notes_path, family, donor_doc_id, is_fallback, report):
    """Append a '章節→樣式對照' section (and fallback marker) to the family notes.md."""
    lines = []
    lines.append('')
    lines.append('## 章節→樣式對照（範本真身 %s.docx）' % family)
    if is_fallback:
        lines.append('> ⚠️ 此家族**無版式外殼**（家族內無任何 `source.docx` donor），改用 md-to-docx 預設乾淨版型當外殼。')
    else:
        lines.append('> donor：`%s`（章節覆蓋最貼近超集、內容最完整；平手取頁數最多）' % (donor_doc_id or '未知'))
    lines.append('')
    lines.append('| 章節 | 級數 | 樣式名（styleId） | 字型 | 級數大小(pt) |')
    lines.append('|---|---|---|---|---|')
    for r in report.get('styleMap', []):
        sid = r.get('styleId')
        sname = r.get('styleName') or ''
        sid_disp = ('%s（%s）' % (sname, sid)) if sid else '（預設）'
        font = r.get('font') or '（繼承）'
        size = r.get('sizePt')
        size_disp = ('%g' % size) if size is not None else '（繼承）'
        lines.append('| %s | H%d | %s | %s | %s |' % (r.get('title', ''), r.get('level', 0), sid_disp, font, size_disp))
    lines.append('')
    fr = report.get('frameEmu') or {}
    lines.append('BPMN 圖框（家族慣例尺寸）：cx=%s cy=%s EMU（≈ %.2f×%.2f in）；錨點為具名 bookmark `BPMN_<slot>`＋paraId，**未烤圖**，供 doc-new / FX bake 放 PNG。'
                 % (fr.get('cx'), fr.get('cy'), (fr.get('cx', 0) / _EMU_PER_IN), (fr.get('cy', 0) / _EMU_PER_IN)))
    lines.append('')

    existing = ''
    if os.path.exists(notes_path):
        with open(notes_path, encoding='utf-8') as f:
            existing = f.read()
    else:
        existing = '---\nfamily: %s\n---\n# %s 家族慣例\n' % (family, family)
    # idempotent: drop any prior style-map section we appended before
    marker = '## 章節→樣式對照（範本真身'
    idx = existing.find(marker)
    if idx >= 0:
        existing = existing[:idx].rstrip() + '\n'
    with open(notes_path, 'w', encoding='utf-8') as f:
        f.write(existing.rstrip() + '\n' + '\n'.join(lines))


def upsert_index(index_path, family, workspace, out_docx, notes_path, donor_doc_id, is_fallback):
    data = {'templates': []}
    if os.path.exists(index_path):
        try:
            data = json.load(open(index_path, encoding='utf-8'))
        except Exception:
            data = {'templates': []}
    if 'templates' not in data or not isinstance(data['templates'], list):
        data['templates'] = []
    shell_rel = _rel_to_workspace(out_docx, workspace)
    notes_rel = _rel_to_workspace(notes_path, workspace) if notes_path else None
    rec = None
    for t in data['templates']:
        if t.get('family') == family:
            rec = t; break
    if rec is None:
        rec = {'family': family}
        data['templates'].append(rec)
    rec['shellPath'] = shell_rel
    rec['donorDocId'] = donor_doc_id
    rec['shellFallback'] = bool(is_fallback)
    if notes_rel and not rec.get('notesPath'):
        rec['notesPath'] = notes_rel
    with open(index_path, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


# ── driver ────────────────────────────────────────────────────────────────────

def _chapter_titles(chapters):
    out = []
    for ch in chapters:
        out.append(ch.get('title', ''))
        for k in (ch.get('children') or []):
            out.append(k.get('title', ''))
    return out


def run_build(config, select_only=False):
    family = config.get('family') or 'template'
    workspace = config.get('workspace') or ''
    chapters = config.get('chapters') or []
    candidates = config.get('candidates') or []
    titles = _chapter_titles(chapters)

    ranked = select_donor(candidates, titles)
    donor_override = config.get('donorDocId')
    chosen = None
    if donor_override:
        chosen = next((r for r in ranked if r['docId'] == donor_override), None)
        if chosen is None:
            # override may point to a candidate whose docx path we still trust
            c = next((c for c in candidates if c.get('docId') == donor_override and c.get('docx') and os.path.exists(c['docx'])), None)
            if c:
                chosen = {'docId': c['docId'], 'docx': c['docx'], 'coverage': None, 'pages': _docx_pages(c['docx'])}
    elif ranked:
        chosen = ranked[0]

    report = {'ok': False, 'family': family, 'donorDocId': None, 'isFallback': False,
              'ranking': ranked, 'outDocx': config.get('outDocx')}

    if select_only:
        report['ok'] = True
        report['donorDocId'] = chosen['docId'] if chosen else None
        report['isFallback'] = chosen is None
        return report

    is_fallback = chosen is None
    tmp_donor = None
    if is_fallback:
        tmp_donor = _make_clean_donor()
        donor_docx = tmp_donor
        donor_doc_id = None
    else:
        donor_docx = chosen['docx']
        donor_doc_id = chosen['docId']

    try:
        all_data, compress = _imgwb._read_zip(donor_docx)
        shell = build_shell(all_data, chapters, family)
        out_docx = config['outDocx']
        os.makedirs(os.path.dirname(out_docx), exist_ok=True)
        _imgwb._write_zip(out_docx, all_data, compress)
    finally:
        if tmp_donor and os.path.exists(tmp_donor):
            try: os.unlink(tmp_donor)
            except Exception: pass

    notes_path = config.get('notesPath')
    if notes_path:
        append_notes_stylemap(notes_path, family, donor_doc_id, is_fallback, shell)
    index_path = config.get('indexPath')
    if index_path:
        upsert_index(index_path, family, workspace, out_docx, notes_path, donor_doc_id, is_fallback)

    report.update({'ok': True, 'donorDocId': donor_doc_id, 'isFallback': is_fallback,
                   'chapters': shell['chapters'], 'anchors': shell['anchors'],
                   'styleMap': shell['styleMap'], 'frameEmu': shell['frameEmu']})
    return report


if __name__ == '__main__':
    ap = argparse.ArgumentParser(description='DTS-A: extract 範本真身 (版式外殼) template.docx from a family donor')
    ap.add_argument('mode', choices=['build', 'select-donor'], help='build = produce .templates/<家族>.docx; select-donor = report choice only')
    ap.add_argument('--config', required=True, help='path to config.json')
    args = ap.parse_args()

    try:
        cfg = json.load(open(args.config, encoding='utf-8'))
    except Exception as e:
        print(json.dumps({'ok': False, 'error': 'bad config: %s' % e}, ensure_ascii=False))
        sys.exit(1)

    result = run_build(cfg, select_only=(args.mode == 'select-donor'))
    print(json.dumps(result, ensure_ascii=False))
    sys.exit(0 if result.get('ok') else 2)
