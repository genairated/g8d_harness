#!/usr/bin/env python3
"""
DTS-B (SPEC-document-templates.md §8.2): 把填好的 doc.md 內容『注入』DTS-A 的版式外殼
(.templates/<家族>.docx) → 產出帶企業版式的 .documents/<uuid>/source.docx（衍生交付物）。

真身方向（勿搞混，見 §8.0）：生成文件 **doc.md 才是真身**，source.docx 是「doc.md ＋家族版式外殼」
烤出的衍生交付物；本器只做『穿外殼』——把每章內容注入外殼對應的具名 bookmark 錨點。

外殼契約（DTS-A / docx-template-shell.py 產）：
  - 內容錨點：`<w:p>`（空 pPr＝正文樣式 style-donor）＋ `<w:bookmarkStart w:name="SEC_<章節>">`
    ＋哨兵文字「〔本節內容〕」。本器把該章 doc.md 正文（段落/清單/表格）注入此處、移除哨兵段落。
  - BPMN 錨點：`<w:p>`＋`<w:bookmarkStart w:name="BPMN_<slot>">`＋可見佔位「〔流程圖：…〕」。
    **保留佔位框、不烤圖**（供 FX-B/C 日後放 PNG）；本器完全不碰。
  - 章節標題段落：已套 donor Heading 樣式，本器不動；用「錨點前最近的標題段落文字」認章節。

保真：沿用 image-writeback `_read_zip`/`_write_zip`（逐 part 原封複製、只重寫 word/document.xml），
頁首頁尾/logo/樣式/頁面設定自動保留。復用 docx-writeback `_make_run_elem`、docx-template-shell
`_para_styles`/`_level_to_style`/`_norm`/`_existing_para_ids`——**不引新依賴**。

清單以字面前綴（`• ` / `1. `）＋左縮排呈現（外殼無 list 段落可當 numPr donor，字面前綴最穩、免碰
numbering.xml）；假圖 `![](placeholder)` 與內嵌 ```bpmn``` fence 以可見佔位段落（〔示意圖：…〕/〔流程圖〕）
呈現、不烤圖。source.docx 為衍生物、不進版本快照（register-born 只快照 doc.md）。

用法：
  python docx-inject.py --shell <.templates/<家族>.docx> --md <doc.md> --out <source.docx>
stdout: JSON { ok, out, injected[], unmatchedAnchors[], unmatchedSections[], counts, warnings }
"""
import sys, os, re, json, copy, argparse, importlib.util, random as _random
from lxml import etree

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


_imgwb = _load('image_writeback', 'image-writeback.py')       # _read_zip / _write_zip（保真讀寫）
_dwb   = _load('docx_writeback', 'docx-writeback.py')          # _make_run_elem（run 建構）
_shell = _load('docx_template_shell', 'docx-template-shell.py')  # 樣式解析 / paraId / _norm 復用

_make_run_elem   = _dwb._make_run_elem
_para_styles     = _shell._para_styles
_level_to_style  = _shell._level_to_style
_norm            = _shell._norm
_existing_para_ids = _shell._existing_para_ids


# ── inline markdown → plain text（保留清單編號，僅去行內強調/行內碼/連結殼/錨點註解） ─────────

def _strip_inline(text):
    text = re.sub(r'<!--.*?-->', '', text)
    text = re.sub(r'\*{3}([^*\n]+)\*{3}', r'\1', text)
    text = re.sub(r'\*{2}([^*\n]+)\*{2}', r'\1', text)
    text = re.sub(r'\*([^*\n]+)\*',       r'\1', text)
    text = re.sub(r'`([^`]+)`',           r'\1', text)
    text = re.sub(r'\[([^\]]+)\]\([^)]*\)', r'\1', text)   # [文字](url) → 文字
    return text.strip()


def _gen_pid(used):
    while True:
        pid = '%08X' % _random.randint(0, 0xFFFFFFFF)
        if pid not in used:
            used.add(pid)
            return pid


# ── doc.md → sections（依標題切段，每段留原始正文行） ───────────────────────────────

def parse_sections(md):
    """Return ordered list [ [level, title, body_lines[]] ]. Strips front-matter; lines before the
    first heading (doc title area) are dropped."""
    body = md.lstrip()
    if body.startswith('---'):
        end = body.find('\n---', 3)
        if end >= 0:
            nl = body.find('\n', end + 1)
            body = body[nl + 1:] if nl >= 0 else ''
    sections = []
    cur = None
    for ln in body.split('\n'):
        hm = re.match(r'^(#{1,6})\s+(.*)', ln)
        if hm:
            if cur is not None:
                sections.append(cur)
            cur = [len(hm.group(1)), hm.group(2).strip(), []]
        elif cur is not None:
            cur[2].append(ln)
    if cur is not None:
        sections.append(cur)
    return sections


# ── section body lines → blocks ────────────────────────────────────────────────

_UL_RE = re.compile(r'^[-*+]\s+')
_OL_RE = re.compile(r'^\d+\.\s+')
_IMG_RE = re.compile(r'^!\[(.*?)\]\((.*?)\)\s*$')
_SEP_RE = re.compile(r'^\|?[\s:\-|]+\|?$')


def parse_blocks(lines):
    blocks = []
    i, n = 0, len(lines)
    while i < n:
        raw = lines[i]
        s = raw.strip()
        if not s:
            i += 1
            continue
        # fenced code (```bpmn assets/x.bpmn``` 或其它) → 可見佔位、不烤圖
        if s.startswith('```'):
            i += 1
            while i < n and not lines[i].strip().startswith('```'):
                i += 1
            i += 1  # 跳過收尾 fence
            blocks.append({'type': 'bpmn'})
            continue
        # HTML 註解（鷹架殘留，理應已刪）→ 跳過
        if s.startswith('<!--'):
            while i < n and '-->' not in lines[i]:
                i += 1
            i += 1
            continue
        # 假圖 / 圖片 → 可見佔位
        m = _IMG_RE.match(s)
        if m:
            blocks.append({'type': 'image', 'alt': m.group(1).strip(), 'src': m.group(2).strip()})
            i += 1
            continue
        # GFM 表格
        if s.startswith('|'):
            rows = [s]
            i += 1
            while i < n and lines[i].strip().startswith('|'):
                rows.append(lines[i].strip())
                i += 1
            blocks.append({'type': 'table', 'rows': rows})
            continue
        # 無序清單
        if _UL_RE.match(s):
            items = []
            while i < n and _UL_RE.match(lines[i].strip()):
                items.append(_UL_RE.sub('', lines[i].strip()))
                i += 1
            blocks.append({'type': 'ul', 'items': items})
            continue
        # 有序清單（保留原編號字面）
        if _OL_RE.match(s):
            items = []
            while i < n and _OL_RE.match(lines[i].strip()):
                items.append(lines[i].strip())
                i += 1
            blocks.append({'type': 'ol', 'items': items})
            continue
        # 引用（多為 > ⚠️ 鷹架，理應已刪）→ 併成一般段落
        if s.startswith('>'):
            para = []
            while i < n and lines[i].strip().startswith('>'):
                para.append(re.sub(r'^\s*>\s?', '', lines[i]))
                i += 1
            blocks.append({'type': 'para', 'text': ' '.join(x.strip() for x in para).strip()})
            continue
        # 內文子標題（正常家族結構不會出現；防禦性處理）
        hm = re.match(r'^(#{1,6})\s+(.*)', s)
        if hm:
            blocks.append({'type': 'heading', 'level': len(hm.group(1)), 'text': hm.group(2).strip()})
            i += 1
            continue
        # 一般段落：併連續非特殊行
        para = []
        while i < n:
            t = lines[i].strip()
            if not t:
                break
            if (t.startswith(('|', '```', '>', '#', '<!--')) or _UL_RE.match(t)
                    or _OL_RE.match(t) or t.startswith('![')):
                break
            para.append(t)
            i += 1
        if para:
            blocks.append({'type': 'para', 'text': ' '.join(para).strip()})
    return blocks


# ── lxml paragraph / list / table / heading builders ───────────────────────────

def _clone_pPr(donor_pPr):
    if donor_pPr is not None and donor_pPr.tag == _W + 'pPr':
        return copy.deepcopy(donor_pPr)
    return etree.Element(_W + 'pPr')


def make_para(donor_pPr, text, used):
    p = etree.Element(_W + 'p')
    p.set(_W14 + 'paraId', _gen_pid(used))
    p.append(_clone_pPr(donor_pPr))
    p.append(_make_run_elem(_strip_inline(text), None))
    return p


def make_list_para(donor_pPr, text, used):
    p = etree.Element(_W + 'p')
    p.set(_W14 + 'paraId', _gen_pid(used))
    pPr = _clone_pPr(donor_pPr)
    if pPr.find(_W + 'ind') is None:
        ind = etree.SubElement(pPr, _W + 'ind')
        ind.set(_W + 'left', '480')          # 約 0.33in 左縮排，讓清單看得出層級
    p.append(pPr)
    p.append(_make_run_elem(text, None))
    return p


def make_heading(level, text, lvl_style, used):
    p = etree.Element(_W + 'p')
    p.set(_W14 + 'paraId', _gen_pid(used))
    pPr = etree.SubElement(p, _W + 'pPr')
    sid = lvl_style.get(level)
    if sid:
        ps = etree.SubElement(pPr, _W + 'pStyle')
        ps.set(_W + 'val', sid)
    p.append(_make_run_elem(_strip_inline(text), None))
    return p


def _tbl_cells(line):
    line = line.strip()
    if line.startswith('|'):
        line = line[1:]
    if line.endswith('|'):
        line = line[:-1]
    return [c.strip() for c in line.split('|')]


def make_table(rows_md, used):
    header = _tbl_cells(rows_md[0])
    data_rows = [_tbl_cells(ln) for ln in rows_md[1:] if not _SEP_RE.match(ln)]
    ncol = max(1, len(header))

    tbl = etree.Element(_W + 'tbl')
    tblPr = etree.SubElement(tbl, _W + 'tblPr')
    tblW = etree.SubElement(tblPr, _W + 'tblW'); tblW.set(_W + 'w', '0'); tblW.set(_W + 'type', 'auto')
    borders = etree.SubElement(tblPr, _W + 'tblBorders')
    for edge in ('top', 'left', 'bottom', 'right', 'insideH', 'insideV'):
        b = etree.SubElement(borders, _W + edge)
        b.set(_W + 'val', 'single'); b.set(_W + 'sz', '4'); b.set(_W + 'space', '0'); b.set(_W + 'color', 'auto')
    grid = etree.SubElement(tbl, _W + 'tblGrid')
    for _ in range(ncol):
        etree.SubElement(grid, _W + 'gridCol')

    def make_row(cells_text, bold=False):
        tr = etree.Element(_W + 'tr')
        cells_text = (list(cells_text) + [''] * ncol)[:ncol]
        for ct in cells_text:
            tc = etree.SubElement(tr, _W + 'tc')
            etree.SubElement(tc, _W + 'tcPr')
            p = etree.SubElement(tc, _W + 'p')
            p.set(_W14 + 'paraId', _gen_pid(used))
            etree.SubElement(p, _W + 'pPr')
            rPr = None
            if bold:
                rPr = etree.Element(_W + 'rPr')
                etree.SubElement(rPr, _W + 'b')
            p.append(_make_run_elem(_strip_inline(ct), rPr))
        return tr

    tbl.append(make_row(header, bold=True))
    for dr in data_rows:
        tbl.append(make_row(dr))
    return tbl


def build_block_elems(blocks, donor_pPr, lvl_style, used, counts):
    out = []
    for b in blocks:
        t = b['type']
        if t == 'para':
            if b['text']:
                out.append(make_para(donor_pPr, b['text'], used)); counts['paras'] += 1
        elif t == 'ul':
            for it in b['items']:
                out.append(make_list_para(donor_pPr, '• ' + _strip_inline(it), used))
            counts['lists'] += 1
        elif t == 'ol':
            for it in b['items']:
                out.append(make_list_para(donor_pPr, _strip_inline(it), used))
            counts['lists'] += 1
        elif t == 'table':
            out.append(make_table(b['rows'], used)); counts['tables'] += 1
        elif t == 'image':
            out.append(make_para(donor_pPr, '〔示意圖：%s〕' % (b['alt'] or '待補'), used))
            counts['images'] += 1
        elif t == 'bpmn':
            out.append(make_para(donor_pPr, '〔流程圖〕', used))
            counts['bpmnPlaceholders'] += 1
        elif t == 'heading':
            out.append(make_heading(b['level'], b['text'], lvl_style, used))
            counts['paras'] += 1
    return out


# ── BPMN 佔位『一流程一槽』：依 doc.md fence 展開外殼單槽 ─────────────────────────────
# 外殼（DTS-A）每個「流程」章節只切一個插入點 `BPMN_<slot>`（家族層級、無從得知某份文件有幾張圖）。
# 真正的圖數只有 doc.md 才知道，故在注入（DTS-B）此處把該單一插入點『展開』成一 fence 一槽——
# 每張流程圖各得一個 `BPMN_image<n>` 具名書籤＋新 paraId 佔位段。錨點身分（paraId）由 extract_flow_anchors
# 抽出、擬真層（index.html）據 n→paraId 把 bpmn-svg 貼回原位；bake 管線日後亦可據具名書籤放 PNG。

_BPMN_FENCE_RE = re.compile(r'```bpmn[ \t]*([^\n]*)\r?\n(.*?)```', re.S)
_IMG_N_RE = re.compile(r'image(\d+)(?:_([^./]*))?\.bpmn', re.I)


def md_bpmn_flows(md):
    """doc.md 的 ```bpmn``` fences（文件順序）→ [{'n':圖號, 'label':子流程名}]。與 index.html 同一套
    命名解析（imageN[_<階段>].bpmn）→ 保證『圖號 n』在注入與擬真兩端一致。"""
    flows = []
    for m in _BPMN_FENCE_RE.finditer(md):
        ref = (next((s.strip() for s in m.group(2).split('\n') if s.strip()), '') or (m.group(1) or '').strip())
        mn = _IMG_N_RE.search(ref)
        if not mn:
            continue
        sfx = (mn.group(2) or '')
        flows.append({'n': int(mn.group(1)), 'label': (sfx if sfx and sfx.lower() != 'pending' else '')})
    return flows


def _distribute_flows(nph, flows):
    """把 flows 依序切成 nph 組（一插入點一組）。常見情形 nph==1 → 全部進那一槽（本案 OSP 兩張圖）。"""
    groups = [[] for _ in range(max(nph, 0))]
    if nph <= 0 or not flows:
        return groups
    if nph == 1:
        groups[0] = list(flows)
        return groups
    per = len(flows) / nph
    for i, f in enumerate(flows):
        groups[min(int(i / per), nph - 1)].append(f)
    return groups


def _bpmn_bmk_name(p):
    """段落內第一個 `BPMN_*` bookmark 名（無則 None）。"""
    for bs in p.findall(_W + 'bookmarkStart'):
        nm = bs.get(_W + 'name') or ''
        if nm.startswith('BPMN_'):
            return nm
    return None


def make_bpmn_placeholder(donor_pPr, n, label, bmid, used):
    """一張流程圖 → 一個 `BPMN_image<n>` 具名書籤＋新 paraId 的可見佔位段（沿用外殼原槽 pPr 樣式）。"""
    p = etree.Element(_W + 'p')
    p.set(_W14 + 'paraId', _gen_pid(used))
    p.append(_clone_pPr(donor_pPr))
    bs = etree.SubElement(p, _W + 'bookmarkStart'); bs.set(_W + 'id', str(bmid)); bs.set(_W + 'name', 'BPMN_image%d' % n)
    p.append(_make_run_elem('〔流程圖：%s〕' % (label or ('流程%d' % n)), None))
    etree.SubElement(p, _W + 'bookmarkEnd').set(_W + 'id', str(bmid))
    return p


# ── inject driver ──────────────────────────────────────────────────────────────

def _para_text(p):
    return ''.join(t.text or '' for t in p.iter(_W + 't'))


def inject(all_data, md_text):
    doc_xml = all_data.get('word/document.xml')
    if not doc_xml:
        raise RuntimeError('shell docx has no word/document.xml')
    root = etree.fromstring(doc_xml)
    body = root.find(_W + 'body')
    if body is None:
        raise RuntimeError('shell docx has no <w:body>')

    used = _existing_para_ids(all_data)
    styles_root = etree.fromstring(all_data.get('word/styles.xml', b'<x/>'))
    lvl_style = _level_to_style(_para_styles(styles_root))

    sections = parse_sections(md_text)
    sec_map = {}      # norm(title) -> body_lines
    for level, title, lines in sections:
        sec_map.setdefault(_norm(title), lines)

    counts = {'paras': 0, 'lists': 0, 'tables': 0, 'images': 0, 'bpmnPlaceholders': 0}
    injected, unmatched_anchors, matched_keys = [], [], set()
    last_heading = None

    # BPMN『一流程一槽』：先算 doc.md 有幾張流程圖、外殼有幾個 BPMN 插入點，把 fences 依序分配給各插入點。
    flows = md_bpmn_flows(md_text)
    bpmn_slots = [c for c in list(body) if c.tag == _W + 'p' and _bpmn_bmk_name(c)]
    slot_groups = _distribute_flows(len(bpmn_slots), flows)
    bmid = _shell._max_bookmark_id(all_data) + 1
    slot_idx = 0

    for child in list(body):
        if child.tag != _W + 'p':
            continue
        bstart = child.find(_W + 'bookmarkStart')
        bname = _bpmn_bmk_name(child) or (bstart.get(_W + 'name') if bstart is not None else None)

        if bname and bname.startswith('SEC_'):
            key = _norm(last_heading) if last_heading else None
            lines = sec_map.get(key) if key else None
            if lines is None:                                  # 標題認不出 → 退回 bookmark 尾綴
                key2 = _norm(bname[4:])
                lines = sec_map.get(key2)
                if lines is not None:
                    key = key2
            if lines is None:
                unmatched_anchors.append({'bookmark': bname, 'heading': last_heading})
                continue                                        # 找不到內容 → 保留哨兵、不清空
            blocks = parse_blocks(lines)
            elems = build_block_elems(blocks, child.find(_W + 'pPr'), lvl_style, used, counts)
            idx = list(body).index(child)
            for off, e in enumerate(elems):
                body.insert(idx + 1 + off, e)
            body.remove(child)                                  # 移除哨兵段落（含 bookmark，任務已達）
            matched_keys.add(key)
            injected.append({'title': last_heading or bname[4:], 'bookmark': bname, 'elems': len(elems)})
        elif bname and bname.startswith('BPMN_'):
            grp = slot_groups[slot_idx] if slot_idx < len(slot_groups) else []
            slot_idx += 1
            if not grp:
                continue                                        # 這份文件此槽無對應流程圖 → 保留原佔位
            idx = list(body).index(child)                       # 一 fence 一槽：展開成多個 BPMN_image<n> 佔位
            donor_pPr = child.find(_W + 'pPr')
            for off, f in enumerate(grp):
                body.insert(idx + 1 + off, make_bpmn_placeholder(donor_pPr, f['n'], f['label'], bmid, used))
                bmid += 1
                counts['bpmnPlaceholders'] += 1
            body.remove(child)                                  # 移除外殼原本的單一佔位段
        else:
            txt = _para_text(child).strip()
            if txt:
                last_heading = txt

    # md 有內容、外殼卻無對應錨點的章節（如標題區或多出的段落）
    unmatched_sections = []
    for level, title, lines in sections:
        k = _norm(title)
        if k in matched_keys:
            continue
        if any(ln.strip() for ln in lines):
            unmatched_sections.append({'title': title, 'level': level})

    all_data['word/document.xml'] = etree.tostring(root, xml_declaration=True, encoding='UTF-8', standalone=True)
    return {'injected': injected, 'unmatchedAnchors': unmatched_anchors,
            'unmatchedSections': unmatched_sections, 'counts': counts}


def run_inject(shell_path, md_path, out_path):
    if not os.path.exists(shell_path):
        return {'ok': False, 'error': 'shell docx not found: %s' % shell_path}
    if not os.path.exists(md_path):
        return {'ok': False, 'error': 'doc.md not found: %s' % md_path}
    with open(md_path, encoding='utf-8') as f:
        md = f.read()
    all_data, compress = _imgwb._read_zip(shell_path)
    rep = inject(all_data, md)
    out_dir = os.path.dirname(os.path.abspath(out_path))
    if out_dir:
        os.makedirs(out_dir, exist_ok=True)
    _imgwb._write_zip(out_path, all_data, compress)

    warnings = []
    if rep['unmatchedAnchors']:
        warnings.append('%d 個外殼錨點在 doc.md 找不到對應章節（保留哨兵）' % len(rep['unmatchedAnchors']))
    if rep['unmatchedSections']:
        warnings.append('%d 個 doc.md 章節在外殼無對應錨點（未注入）' % len(rep['unmatchedSections']))
    return {'ok': True, 'out': out_path, **rep, 'warnings': warnings}


if __name__ == '__main__':
    ap = argparse.ArgumentParser(description='DTS-B: inject doc.md content into a family shell docx → source.docx')
    ap.add_argument('--shell', required=True, help='path to .templates/<家族>.docx（版式外殼）')
    ap.add_argument('--md',    required=True, help='path to filled doc.md（真身）')
    ap.add_argument('--out',   required=True, help='path to output source.docx（衍生交付物）')
    args = ap.parse_args()

    try:
        result = run_inject(args.shell, args.md, args.out)
    except Exception as e:
        result = {'ok': False, 'error': '%s: %s' % (type(e).__name__, e)}
    print(json.dumps(result, ensure_ascii=False))
    sys.exit(0 if result.get('ok') else 2)
