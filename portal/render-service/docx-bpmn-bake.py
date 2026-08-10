"""
FX-B (SPEC-doc-fidelity-export.md §4): 擬真 docx 交付檔 — OOXML 影像置換器.

以 source.docx 為底，只把「被辨識為流程圖」的那幾張圖元換成前端渲好的 BPMN 光柵 PNG。
純圖 / 文字 / 表格 / 版面 (header / 頁碼 / logo / 樣式) 一律不碰 —— 逐 byte 保真。

身分對位 (§13.11)：BPMN 資產檔名前綴 imageN 是 load-bearing，對應 word/media/imageN.*。
extract_flow_anchors (docx-convert.py) 從 source.docx 現場算出每張流程圖圖元的 rId + sourceMedia，
故本器以「media 檔名 stem」對位，**完全不依賴 docPr**（§13.8-5 的 docPr strip blocker 因此不咬本路徑），
也不重匯入、不改 import。對不齊 / _pending / 找不到圖元 → 跳過該圖、誠實回報，不硬猜。

置換手法（比照 image-writeback.py 的 media binary 置換，但流程圖多為 EMF/OLE，直接覆寫 EMF part
會與 [Content_Types] 的 image/x-emf 衝突而破圖）：新增一個 png media part + 一條 image 關聯 →
把該圖元的 v:imagedata@r:id（VML/OLE）或 a:blip@r:embed（DrawingML）改指向新 png →
同步等比修正尺寸（吃原圖框寬、BPMN 比例定高，比照擬真層 _placeFlowFrame）避免變形。
原 media 與 OLE 內嵌 Visio 皆保留不動（交付檔以 imagedata 預覽呈現 BPMN；真身另由 Phase C 處理）。

Usage:
  python docx-bpmn-bake.py --docx <source.docx> --out <exports/x.fidelity.docx> --manifest <m.json>
  python docx-bpmn-bake.py --docx <source.docx> --in-place --manifest <m.json>   # Phase C 覆寫真身

manifest.json = {"images":[{"stem":"image1","png":"<abs.png>","w":<px>,"h":<px>}, ...]}
Outputs JSON report to stdout: {ok, out, replaced:[...], skipped:[{stem,reason}], anchorsTotal}.
"""
import sys, os, json, argparse, importlib.util, re, shutil, zipfile

# ── 沿用既有 render-service 模組（檔名帶連字號 → 用 importlib 載入，不複製程式碼）──────────────
_HERE = os.path.dirname(os.path.abspath(__file__))


def _load(mod_name, filename):
    spec = importlib.util.spec_from_file_location(mod_name, os.path.join(_HERE, filename))
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


_conv = _load('docx_convert', 'docx-convert.py')          # extract_flow_anchors
_imgwb = _load('image_writeback', 'image-writeback.py')    # _read_zip / _write_zip
_shell = _load('docx_template_shell', 'docx-template-shell.py')  # _content_frame_emu（家族圖框 EMU 慣例）

from lxml import etree

_R  = '{http://schemas.openxmlformats.org/officeDocument/2006/relationships}'
_A  = '{http://schemas.openxmlformats.org/drawingml/2006/main}'
_WP = '{http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing}'
_W   = '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'
_PIC = '{http://schemas.openxmlformats.org/drawingml/2006/picture}'
_PKG_REL = 'http://schemas.openxmlformats.org/package/2006/relationships'
_CT = 'http://schemas.openxmlformats.org/package/2006/content-types'
_IMG_REL_TYPE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image'


def _stem(media_path):
    """word/media/image1.emf → 'image1' (lower-cased for robust matching)."""
    return os.path.splitext(os.path.basename(media_path or ''))[0].lower()


def _next_rid(rids):
    """Smallest 'rIdN' not already used."""
    used = set()
    for r in rids:
        m = re.match(r'rId(\d+)$', r or '')
        if m:
            used.add(int(m.group(1)))
    n = 1
    while n in used:
        n += 1
    return 'rId%d' % n


def _find_media_ref(doc_root, rid):
    """Return (element, kind) for the drawing element that references rId as its picture:
       VML/OLE v:imagedata (attr r:id) → kind 'vml'; DrawingML a:blip (attr r:embed) → 'dml'.
       OLEObject also carries an r:id (to the embedded .bin) — filtered out by tag localname."""
    for el in doc_root.iter():
        local = el.tag.rsplit('}', 1)[-1] if '}' in el.tag else el.tag
        if local == 'imagedata' and el.get(_R + 'id') == rid:
            return el, 'vml'
        if local == 'blip' and el.get(_R + 'embed') == rid:
            return el, 'dml'
    return None, None


def _fix_vml_size(imagedata_el, w_px, h_px):
    """Keep the v:shape frame width, set height = width * (h/w). Returns True if adjusted."""
    if not w_px or not h_px:
        return False
    shape = imagedata_el.getparent()          # v:imagedata's parent is v:shape
    if shape is None:
        return False
    style = shape.get('style') or ''
    mw = re.search(r'width:\s*([0-9.]+)\s*(pt|px|in|cm|mm|pc|em)?', style, re.I)
    if not mw:
        return False
    width_val = float(mw.group(1))
    unit = mw.group(2) or 'pt'
    new_h = round(width_val * (float(h_px) / float(w_px)), 2)
    new_style, n = re.subn(r'height:\s*[0-9.]+\s*(pt|px|in|cm|mm|pc|em)?',
                           'height:%g%s' % (new_h, unit), style, count=1, flags=re.I)
    if not n:
        sep = '' if new_style.rstrip().endswith(';') or not new_style.strip() else ';'
        new_style = new_style + sep + 'height:%g%s' % (new_h, unit)
    shape.set('style', new_style)
    return True


def _fix_dml_size(blip_el, w_px, h_px):
    """Keep wp:extent/a:ext cx, set cy = cx * (h/w). Returns True if adjusted."""
    if not w_px or not h_px:
        return False
    # walk up to the enclosing w:drawing, then adjust its wp:extent + a:ext
    node = blip_el
    drawing = None
    while node is not None:
        local = node.tag.rsplit('}', 1)[-1] if '}' in node.tag else node.tag
        if local == 'drawing':
            drawing = node
            break
        node = node.getparent()
    if drawing is None:
        return False
    ratio = float(h_px) / float(w_px)
    changed = False
    ext = drawing.find('.//' + _WP + 'extent')
    if ext is not None and ext.get('cx'):
        try:
            ext.set('cy', str(int(round(int(ext.get('cx')) * ratio))))
            changed = True
        except (ValueError, TypeError):
            pass
    aext = drawing.find('.//' + _A + 'ext')
    if aext is not None and aext.get('cx'):
        try:
            aext.set('cy', str(int(round(int(aext.get('cx')) * ratio))))
            changed = True
        except (ValueError, TypeError):
            pass
    return changed


def _ensure_png_default(all_data):
    """Guarantee [Content_Types].xml declares a png Default (a real client docx already does; defensive)."""
    ct_name = '[Content_Types].xml'
    ct = all_data.get(ct_name)
    if not ct:
        return
    root = etree.fromstring(ct)
    for d in root.findall('{%s}Default' % _CT):
        if (d.get('Extension') or '').lower() == 'png':
            return
    d = etree.SubElement(root, '{%s}Default' % _CT)
    d.set('Extension', 'png')
    d.set('ContentType', 'image/png')
    all_data[ct_name] = etree.tostring(root, xml_declaration=True, encoding='UTF-8', standalone=True)


# ── 生成型 docx『往具名書籤插入 inline drawing』路徑（匯入型 EMF 置換之外的第二條）─────────────
# doc-new / docx-inject 產的 source.docx 沒有內嵌 EMF——流程圖是 `BPMN_image<n>` 書籤佔位段（空的
# 〔流程圖…〕文字）。extract_flow_anchors 也把這些書籤 surface 成 anchor（rid:None＋bpmnSlot），故本器
# 除了『找圖元換 media』也能『在該書籤所在段落塞一張 <w:drawing>』：建 png media part＋image rel →
# 依 doc 自身 sectPr 算家族圖框寬（cx）、高吃 BPMN 長寬比 → 清掉佔位文字、插入 inline 圖。冪等（重烤
# 前先清掉該段既有 run，含前次插入的圖），故 .fidelity.docx 與就地烤 source.docx 都可重跑不疊圖。

def _content_frame_emu(doc_root):
    """家族圖框 EMU：以 doc 自身 body/sectPr 的內容寬（頁寬−左右邊界）算 cx（復用 docx-template-shell
    的單一真相邏輯）；取不到退回 A4 內容寬。高由呼叫端依 PNG 長寬比定，這裡只給 cx（cy 為預設 0.6 比）。"""
    body = doc_root.find(_W + 'body')
    sectPr = body.find(_W + 'sectPr') if body is not None else None
    try:
        return _shell._content_frame_emu(sectPr)
    except Exception:
        cx = int(6.1 * 914400)
        return {'cx': cx, 'cy': int(cx * 0.6)}


def _max_docpr_id(doc_root):
    """現存 wp:docPr / pic:cNvPr 的最大 @id（Word 要求 docPr id 全文唯一，重複會觸發修復）。"""
    mx = 0
    for el in doc_root.iter():
        local = el.tag.rsplit('}', 1)[-1] if '}' in el.tag else el.tag
        if local in ('docPr', 'cNvPr'):
            try:
                mx = max(mx, int(el.get('id') or 0))
            except (ValueError, TypeError):
                pass
    return mx


def _find_bpmn_para(doc_root, bookmark_name):
    """回傳開啟具名書籤 bookmark_name（如 BPMN_image1）的那個 <w:p>；找不到回 None。"""
    for p in doc_root.iter(_W + 'p'):
        for bs in p.findall(_W + 'bookmarkStart'):
            if (bs.get(_W + 'name') or '') == bookmark_name:
                return p
    return None


def _make_inline_drawing(rid, cx, cy, docpr_id, name):
    """建一個吃 rId、尺寸 cx×cy EMU 的 inline 圖 <w:drawing>（wp:inline → a:graphic → pic:pic）。"""
    drawing = etree.Element(_W + 'drawing')
    inline = etree.SubElement(drawing, _WP + 'inline')
    for a in ('distT', 'distB', 'distL', 'distR'):
        inline.set(a, '0')
    ext = etree.SubElement(inline, _WP + 'extent'); ext.set('cx', str(cx)); ext.set('cy', str(cy))
    ee = etree.SubElement(inline, _WP + 'effectExtent')
    for a in ('l', 't', 'r', 'b'):
        ee.set(a, '0')
    dpr = etree.SubElement(inline, _WP + 'docPr'); dpr.set('id', str(docpr_id)); dpr.set('name', name)
    cnv = etree.SubElement(inline, _WP + 'cNvGraphicFramePr')
    etree.SubElement(cnv, _A + 'graphicFrameLocks').set('noChangeAspect', '1')
    graphic = etree.SubElement(inline, _A + 'graphic')
    gdata = etree.SubElement(graphic, _A + 'graphicData')
    gdata.set('uri', 'http://schemas.openxmlformats.org/drawingml/2006/picture')
    pic = etree.SubElement(gdata, _PIC + 'pic')
    nvPicPr = etree.SubElement(pic, _PIC + 'nvPicPr')
    cNvPr = etree.SubElement(nvPicPr, _PIC + 'cNvPr'); cNvPr.set('id', str(docpr_id)); cNvPr.set('name', name)
    etree.SubElement(nvPicPr, _PIC + 'cNvPicPr')
    blipFill = etree.SubElement(pic, _PIC + 'blipFill')
    etree.SubElement(blipFill, _A + 'blip').set(_R + 'embed', rid)
    etree.SubElement(etree.SubElement(blipFill, _A + 'stretch'), _A + 'fillRect')
    spPr = etree.SubElement(pic, _PIC + 'spPr')
    xfrm = etree.SubElement(spPr, _A + 'xfrm')
    off = etree.SubElement(xfrm, _A + 'off'); off.set('x', '0'); off.set('y', '0')
    aext = etree.SubElement(xfrm, _A + 'ext'); aext.set('cx', str(cx)); aext.set('cy', str(cy))
    geom = etree.SubElement(spPr, _A + 'prstGeom'); geom.set('prst', 'rect')
    etree.SubElement(geom, _A + 'avLst')
    return drawing


def bake(docx_path, out_path, images, in_place=False):
    report = {'ok': False, 'out': out_path, 'replaced': [], 'inserted': [], 'skipped': [], 'anchorsTotal': 0}

    # 1) 現場算流程圖圖元（rId + sourceMedia），建 stem → anchor
    anchors = _conv.extract_flow_anchors(docx_path)
    report['anchorsTotal'] = len(anchors)
    anchor_by_stem = {}
    for a in anchors:
        st = _stem(a.get('sourceMedia'))
        if st and st not in anchor_by_stem:      # 匯入型：media part stem（唯一）
            anchor_by_stem[st] = a
        slot = (a.get('bpmnSlot') or '').lower()  # 生成型：BPMN_image<n> 書籤 → slot 'image<n>'＝前端 stem
        if slot and slot not in anchor_by_stem:
            anchor_by_stem[slot] = a

    # 2) 讀 zip（沿用 image-writeback 的讀寫，保留壓縮型別）
    all_data, compress = _imgwb._read_zip(docx_path)
    doc_xml = all_data.get('word/document.xml')
    rels_name = 'word/_rels/document.xml.rels'
    rels_xml = all_data.get(rels_name)
    if not doc_xml or not rels_xml:
        report['error'] = 'word/document.xml or its rels missing'
        return report

    doc_root = etree.fromstring(doc_xml)
    rels_root = etree.fromstring(rels_xml)
    existing_rids = [r.get('Id', '') for r in rels_root]
    _ensure_png_default(all_data)

    used_media = set(all_data.keys())
    n_new = [0]
    next_docpr = _max_docpr_id(doc_root) + 1

    def _add_png_part(stem, png_bytes):
        """建唯一命名的 png media part ＋一條 image relationship，回 (new_part, new_rid)。兩支路徑共用。"""
        n_new[0] += 1
        new_part = 'word/media/hana_bpmn_%s.png' % re.sub(r'[^A-Za-z0-9_]', '_', stem)
        while new_part in used_media:
            new_part = 'word/media/hana_bpmn_%s_%d.png' % (re.sub(r'[^A-Za-z0-9_]', '_', stem), n_new[0])
            n_new[0] += 1
        used_media.add(new_part)
        all_data[new_part] = png_bytes
        new_rid = _next_rid(existing_rids)
        existing_rids.append(new_rid)
        rel = etree.SubElement(rels_root, '{%s}Relationship' % _PKG_REL)
        rel.set('Id', new_rid)
        rel.set('Type', _IMG_REL_TYPE)
        rel.set('Target', new_part[len('word/'):])   # 'media/hana_bpmn_x.png'
        return new_part, new_rid

    for item in images:
        stem = str(item.get('stem') or '').lower()
        png_path = item.get('png')
        w_px, h_px = item.get('w'), item.get('h')
        if not stem or stem.endswith('_pending'):
            report['skipped'].append({'stem': stem, 'reason': 'pending or empty stem'})
            continue
        anchor = anchor_by_stem.get(stem)
        if not anchor:
            report['skipped'].append({'stem': stem, 'reason': 'no flowchart anchor for this stem'})
            continue
        if not png_path or not os.path.exists(png_path):
            report['skipped'].append({'stem': stem, 'reason': 'png missing on disk'})
            continue
        with open(png_path, 'rb') as f:
            png_bytes = f.read()

        rid = anchor.get('rid')
        if rid:
            # ── 匯入型：換既有圖元的 media，尺寸沿用原圖框寬、等比定高 ──────────────
            el, kind = _find_media_ref(doc_root, rid)
            if el is None:
                report['skipped'].append({'stem': stem, 'reason': 'drawing element for rId %s not found' % rid})
                continue
            new_part, new_rid = _add_png_part(stem, png_bytes)
            if kind == 'vml':
                el.set(_R + 'id', new_rid)
                sized = _fix_vml_size(el, w_px, h_px)
            else:
                el.set(_R + 'embed', new_rid)
                sized = _fix_dml_size(el, w_px, h_px)
            report['replaced'].append({'stem': stem, 'rid': rid, 'newRid': new_rid,
                                        'newPart': new_part, 'kind': kind, 'resized': bool(sized)})
        else:
            # ── 生成型：往 BPMN_<slot> 書籤所在段落插入一張 inline 圖，清掉佔位文字 ──────
            slot = anchor.get('bpmnSlot') or stem
            bmname = 'BPMN_%s' % slot
            para = _find_bpmn_para(doc_root, bmname)
            if para is None:
                report['skipped'].append({'stem': stem, 'reason': 'BPMN bookmark %s not found' % bmname})
                continue
            new_part, new_rid = _add_png_part(stem, png_bytes)
            frame = _content_frame_emu(doc_root)
            cx = int(frame.get('cx') or 0) or int(6.1 * 914400)
            if w_px and h_px:
                cy = int(round(cx * (float(h_px) / float(w_px))))
            else:
                cy = int(frame.get('cy') or int(cx * 0.6))
            # 冪等：先清掉該段既有 run（佔位文字段／前次插入的圖），保留 pPr 與 bookmarkStart/End
            for r in para.findall(_W + 'r'):
                para.remove(r)
            run = etree.Element(_W + 'r')
            run.append(_make_inline_drawing(new_rid, cx, cy, next_docpr, 'BPMN %s' % slot))
            next_docpr += 1
            be = para.find(_W + 'bookmarkEnd')
            if be is not None:
                be.addprevious(run)                 # 圖夾在書籤範圍內
            else:
                para.append(run)
            report['inserted'].append({'stem': stem, 'bookmark': bmname, 'newRid': new_rid,
                                       'newPart': new_part, 'cx': cx, 'cy': cy})

    if not report['replaced'] and not report['inserted']:
        report['error'] = 'no flowchart baked (all skipped)'
        report['ok'] = False
        return report

    # 2b) GC：清掉『前次插入』但這回已被取代、無任何圖元引用的 hana_bpmn_* media（in-place 重烤才會有）。
    #     只碰本器自產的 hana_bpmn_* part（絕不動客戶原生 media），依 document.xml 現存引用判斷孤兒。
    referenced = set()
    for el in doc_root.iter():
        rv = el.get(_R + 'embed') or el.get(_R + 'id')
        if rv:
            referenced.add(rv)
    for rel in list(rels_root):
        tgt = rel.get('Target') or ''
        if 'hana_bpmn_' in tgt and rel.get('Id') not in referenced:
            rels_root.remove(rel)
            part = 'word/' + tgt if not tgt.startswith('word/') else tgt
            all_data.pop(part, None)

    # 3) 回寫 xml → zip
    all_data['word/document.xml'] = etree.tostring(doc_root, xml_declaration=True, encoding='UTF-8', standalone=True)
    all_data[rels_name] = etree.tostring(rels_root, xml_declaration=True, encoding='UTF-8', standalone=True)

    if in_place:
        # Phase C：先寫 temp 再原子換上（避免中途壞檔）——但快照由呼叫端負責
        tmp = out_path + '.baking.tmp'
        _imgwb._write_zip(tmp, all_data, compress)
        shutil.move(tmp, out_path)
    else:
        os.makedirs(os.path.dirname(out_path), exist_ok=True)
        _imgwb._write_zip(out_path, all_data, compress)

    report['ok'] = True
    return report


if __name__ == '__main__':
    ap = argparse.ArgumentParser(description='FX-B: bake BPMN rasters into a docx (OOXML image swap)')
    ap.add_argument('--docx', required=True, help='source.docx (base, read-only unless --in-place)')
    ap.add_argument('--out', help='output .fidelity.docx path (Phase B)')
    ap.add_argument('--in-place', action='store_true', dest='in_place',
                    help='overwrite --docx itself (Phase C; caller must snapshot first)')
    ap.add_argument('--manifest', required=True, help='JSON {images:[{stem,png,w,h}]}')
    args = ap.parse_args()

    if not os.path.exists(args.docx):
        print(json.dumps({'ok': False, 'error': 'docx not found: ' + args.docx}, ensure_ascii=False))
        sys.exit(1)
    try:
        manifest = json.load(open(args.manifest, encoding='utf-8'))
    except Exception as e:
        print(json.dumps({'ok': False, 'error': 'bad manifest: ' + str(e)}, ensure_ascii=False))
        sys.exit(1)

    out = args.docx if args.in_place else args.out
    if not out:
        print(json.dumps({'ok': False, 'error': 'must give --out (Phase B) or --in-place (Phase C)'}, ensure_ascii=False))
        sys.exit(1)

    result = bake(args.docx, out, manifest.get('images', []), in_place=args.in_place)
    print(json.dumps(result, ensure_ascii=False))
    sys.exit(0 if result.get('ok') else 2)
