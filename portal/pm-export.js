'use strict';
// PM Excel export — SPEC-project-management.md §匯出 (2026-08-07 追加, §14.6 擴充 2026-08-25).
// Builds a 3-tab workbook (總覽/清單/甘特圖) with formulas so that editing the 清單 tab
// (dates/progress/deps/工時) automatically re-drives the 甘特圖 conditional-formatting bars, the
// 總覽 stats and the 總覽 人員逐週投入工時 table — no manual re-export needed for a
// date/progress/estimate tweak, only for structural changes (add/remove task rows, add people)
// since column widths/row count are fixed at export time.
// 總覽 is created FIRST so it is the workbook's first tab (指揮官指定 2026-08-25).
const ExcelJS = require('exceljs');

const STATUS_LABEL = { todo: '待辦', in_progress: '進行中', done: '完成' };
const HOURS_PER_WORKDAY_DIVISOR = 5; // weeklyHours / 5 = one full-time workday (同 computeWorkload R3)

function localDateOnly(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

// A, B, ... Z, AA, AB ... — the weekly table can easily run past column Z.
function colLetter(n) {
  let s = '';
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

function parseDate(str) { return str ? new Date(str + 'T00:00:00') : null; }

// Write dates as plain Excel serial NUMBERS, not JS Date objects. ExcelJS converts a Date with a
// UTC epoch, so in UTC+8 every date cell landed 8 hours early and displayed one calendar day early
// (pre-existing bug, fixed here 2026-08-25) — and the weekly-staffing SUMPRODUCT below compares
// those cells against literal serials, which only lines up if both sides are exact.

function mondayOf(d) {
  const dt = localDateOnly(d);
  const dow = dt.getDay(); // 0=Sun..6=Sat
  dt.setDate(dt.getDate() + (dow === 0 ? -6 : 1 - dow));
  return dt;
}

// Excel serial number for a local date-only value (1900 system, incl. the 1900 leap-year quirk).
function excelSerial(d) {
  return Math.round((localDateOnly(d) - new Date(1899, 11, 30)) / 86400000);
}

// Same, keeping the time-of-day fraction (for the 匯出時間 stamp).
function excelSerialTime(d) {
  return excelSerial(d) + (d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds()) / 86400;
}

function serialOrNull(str) { const d = parseDate(str); return d ? excelSerial(d) : null; }

// Ontime Rate — SPEC ask: total scheduled person-days elapsed as of today vs. actually completed
// person-days (duration * progress%), summed across tasks that have started. See chat decision
// 2026-08-07: 100 人天工作項、已過 20 天且都完成 = 100%；只完成 18 人天 = 90%.
function buildPmWorkbook(project, tasks, resources) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Hana / Harness PM';
  wb.created = new Date();

  const sorted = tasks.slice().sort((a, b) => (a.order || 0) - (b.order || 0));
  const byId = new Map(sorted.map(t => [t.id, t]));
  const n = sorted.length;
  const lastRow = n + 1; // header is row 1, data rows 2..lastRow

  // ---- resources: only those actually assigned in this project, with a de-duplicated display
  // name (the weekly table matches people by NAME through SUMPRODUCT, so two "王小明" would
  // otherwise silently merge into one row).
  const resList = Array.isArray(resources) ? resources : [];
  const resById = new Map(resList.map(r => [r.id, r]));
  const usedIds = [];
  sorted.forEach(t => { if (t.assigneeId && resById.has(t.assigneeId) && !usedIds.includes(t.assigneeId)) usedIds.push(t.assigneeId); });
  const dispName = new Map();
  const nameCount = new Map();
  usedIds.forEach(id => {
    const base = (resById.get(id) || {}).name || '(未命名)';
    const c = (nameCount.get(base) || 0) + 1;
    nameCount.set(base, c);
    dispName.set(id, c === 1 ? base : base + ' (' + c + ')');
  });
  const people = usedIds.map(id => {
    const r = resById.get(id);
    return {
      id,
      name: dispName.get(id),
      weeklyHours: (r && r.weeklyHours != null) ? r.weeklyHours : 40,
      daysOff: (r && Array.isArray(r.daysOff)) ? r.daysOff.slice().sort() : [],
    };
  });

  // ---- PMWD 休假日對照表：只收「真的有休假日」的人，Excel 端用 INDEX/MATCH 依「負責人」取到他自己
  // 那一欄，當作 NETWORKDAYS 的 holidays 引數。沒有任何人請假時整張表不產生，公式退化成單純
  // NETWORKDAYS（只扣週末），檔案更乾淨。
  const holPeople = people.filter(p => p.daysOff.length);
  const hasHol = holPeople.length > 0;
  const holLastCol = hasHol ? colLetter(holPeople.length) : 'A';
  const holLastRow = hasHol ? (1 + Math.max(...holPeople.map(p => p.daysOff.length))) : 1;
  const holNames = `休假日!$A$1:$${holLastCol}$1`;
  const holBody = `休假日!$A$2:$${holLastCol}$${holLastRow}`;
  // 工作日天數 = NETWORKDAYS(a, b, 該負責人的休假日)。查不到人（未指派／沒請過假）→ 退回只扣週末。
  const nwd = (a, b, r) => hasHol
    ? `IFERROR(NETWORKDAYS(${a},${b},INDEX(${holBody},0,MATCH(清單!$B${r},${holNames},0))),NETWORKDAYS(${a},${b}))`
    : `NETWORKDAYS(${a},${b})`;

  // ---------- 總覽 (Overview) — created first so it is the first tab ----------
  const ov = wb.addWorksheet('總覽');

  // ---------- 清單 (List) ----------
  const list = wb.addWorksheet('清單', { views: [{ state: 'frozen', ySplit: 1 }] });
  list.columns = [
    { header: '任務名稱', key: 'name', width: 24 },
    { header: '負責人', key: 'assignee', width: 12 },
    { header: '開始', key: 'start', width: 12 },
    { header: '結束', key: 'end', width: 12 },
    { header: '工期(天)', key: 'dur', width: 10 },
    { header: '工作天', key: 'workdays', width: 9 },
    { header: '進度(%)', key: 'progress', width: 10 },
    { header: '狀態', key: 'status', width: 10 },
    { header: '相依(前置任務)', key: 'deps', width: 24 },
    { header: '里程碑', key: 'milestone', width: 8 },
    { header: '預估工時(h)', key: 'estimate', width: 12 },
    { header: '每工作日工時(h)', key: 'daily', width: 14 },
    { header: '完成天數(依進度)', key: 'doneDays', width: 14 },
    { header: '應完成人天(至今)', key: 'dueDays', width: 14 },
    { header: '實際完成人天(至今)', key: 'actualDays', width: 16 },
  ];
  list.getRow(1).font = { bold: true };
  list.getRow(1).eachCell(c => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE2E8F0' } }; });

  sorted.forEach((t, i) => {
    const r = i + 2;
    const depNames = (Array.isArray(t.deps) ? t.deps : []).map(id => (byId.get(id) || {}).name).filter(Boolean).join('、');
    const row = list.getRow(r);
    row.getCell(1).value = t.name || '';
    row.getCell(2).value = t.assigneeId ? (dispName.get(t.assigneeId) || '') : '';
    row.getCell(3).value = serialOrNull(t.start);
    row.getCell(4).value = serialOrNull(t.end);
    row.getCell(5).value = { formula: `D${r}-C${r}+1` };
    // PMWD 工作天：扣掉週末，再扣掉該負責人自己的休假日。整段都落在非工作日時退回曆日工期，
    // 與後端 computeWorkload 的同一條保險（不讓工時憑空消失）。
    row.getCell(6).value = { formula: `IFERROR(IF(OR($C${r}="",$D${r}=""),0,IF(${nwd(`$C${r}`, `$D${r}`, r)}>0,${nwd(`$C${r}`, `$D${r}`, r)},E${r})),0)` };
    row.getCell(7).value = typeof t.progress === 'number' ? t.progress : 0;
    row.getCell(8).value = STATUS_LABEL[t.status] || '待辦';
    row.getCell(9).value = depNames;
    row.getCell(10).value = t.isMilestone ? '是' : '否';
    // 預估工時：填了就是常數；沒填則沿用 computeWorkload 的 R3 規則（整段工期全職投入），
    // 寫成公式 = 工作天 x 每日全職工時，所以改了日期或休假它會自己重算。
    if (typeof t.estimateHours === 'number' && t.estimateHours > 0) {
      row.getCell(11).value = t.estimateHours;
    } else if (t.assigneeId && resById.has(t.assigneeId) && !t.isMilestone) {
      const wh = resById.get(t.assigneeId).weeklyHours != null ? resById.get(t.assigneeId).weeklyHours : 40;
      const perDay = Math.round((wh / HOURS_PER_WORKDAY_DIVISOR) * 1000) / 1000;
      row.getCell(11).value = { formula: `IFERROR(F${r}*${perDay},0)` };
    } else {
      row.getCell(11).value = 0;
    }
    // 每工作日工時：預估工時只攤在工作日上（週末與個人休假為 0）——與畫面上的負荷計算同一規則。
    row.getCell(12).value = { formula: `IFERROR(IF(F${r}>0,K${r}/F${r},0),0)` };
    row.getCell(13).value = { formula: `ROUND(E${r}*G${r}/100,0)` };
    row.getCell(14).value = { formula: `IF(TODAY()<C${r},0,MIN(E${r},TODAY()-C${r}+1))` };
    row.getCell(15).value = { formula: `IF(N${r}=0,0,M${r})` };
    row.getCell(3).numFmt = 'yyyy-mm-dd';
    row.getCell(4).numFmt = 'yyyy-mm-dd';
    row.getCell(11).numFmt = '0.0';
    row.getCell(12).numFmt = '0.00';
    [12, 13, 14, 15].forEach(c => { row.getCell(c).font = { color: { argb: 'FF94A3B8' }, italic: true }; });
  });

  // ---------- 總覽 content (formula-linked to 清單) ----------
  ov.getColumn(1).width = 22;
  ov.mergeCells('A1:D1');
  ov.getCell('A1').value = project.name + ' — 專案總覽';
  ov.getCell('A1').font = { bold: true, size: 14 };
  ov.getCell('A2').value = '匯出時間';
  ov.getCell('B2').value = excelSerialTime(new Date());
  ov.getCell('B2').numFmt = 'yyyy-mm-dd hh:mm';

  const stat = (row, label, formula, numFmt) => {
    ov.getCell(`A${row}`).value = label;
    ov.getCell(`A${row}`).font = { bold: true };
    ov.getCell(`B${row}`).value = { formula };
    if (numFmt) ov.getCell(`B${row}`).numFmt = numFmt;
    ov.getCell(`B${row}`).font = { size: 13 };
  };
  if (n > 0) {
    stat(4, '任務總數', `COUNTA(清單!A2:A${lastRow})`);
    stat(5, '已完成', `COUNTIF(清單!H2:H${lastRow},"完成")`);
    stat(6, '完成百分比', 'IFERROR(B5/B4,0)', '0.0%');
    stat(7, 'Ontime Rate', `IFERROR(SUM(清單!O2:O${lastRow})/SUM(清單!N2:N${lastRow}),"—")`, '0.0%');
    stat(8, '預估總工時(h)', `SUM(清單!K2:K${lastRow})`, '0.0');
  } else {
    ov.getCell('A4').value = '（尚無任務）';
  }
  ov.getCell('A10').value = '完成度';
  ov.getCell('A10').font = { bold: true };
  if (n > 0) {
    // Text progress bar as a plain formula (20 blocks = 100%) — width-independent, so it survives
    // the wide week columns the staffing table below needs.
    ov.getCell('B10').value = { formula: 'REPT("█",ROUND($B$6*20,0))&REPT("░",20-ROUND($B$6*20,0))' };
    ov.getCell('B10').font = { color: { argb: 'FF22C55E' }, size: 12 };
  }

  // ---------- 總覽 §14.6 人員逐週投入工時 ----------
  let minStart = null, maxEnd = null;
  sorted.forEach(t => {
    if (t.start) { const d = localDateOnly(parseDate(t.start)); if (!minStart || d < minStart) minStart = d; }
    if (t.end) { const d = localDateOnly(parseDate(t.end)); if (!maxEnd || d > maxEnd) maxEnd = d; }
  });

  const TBL = 13; // header row of the weekly staffing table
  ov.getCell(`A${TBL - 1}`).value = '人員逐週投入工時（本專案，單位：小時）';
  ov.getCell(`A${TBL - 1}`).font = { bold: true, size: 12 };

  let weeks = [];   // PMWD: 也給後面的「週工時明細」輔助頁用，故提到外層
  if (people.length && minStart && maxEnd) {
    for (const w = mondayOf(minStart); w <= maxEnd; w.setDate(w.getDate() + 7)) weeks.push(new Date(w));

    ov.getCell(`A${TBL}`).value = '人員';
    ov.getCell(`B${TBL}`).value = '名目每週可投入(h)';
    ov.getColumn(2).width = 13;
    weeks.forEach((w, i) => {
      const c = ov.getCell(TBL, i + 3);
      c.value = excelSerial(w);  // real serial → the header itself is something formulas can point at
      c.numFmt = 'mm/dd';
      c.alignment = { horizontal: 'right' };
      ov.getColumn(i + 3).width = 8;
    });
    const totalCol = weeks.length + 3;
    ov.getCell(TBL, totalCol).value = '總工時(h)';
    ov.getColumn(totalCol).width = 11;
    ov.getColumn(2).width = 17;
    ov.getRow(TBL).font = { bold: true };
    ov.getRow(TBL).eachCell(c => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE2E8F0' } }; });

    const A = `清單!$B$2:$B$${lastRow}`;      // assignee

    people.forEach((p, pi) => {
      const r = TBL + 1 + pi;
      ov.getCell(`A${r}`).value = p.name;
      ov.getCell(`B${r}`).value = p.weeklyHours;
      ov.getCell(`B${r}`).numFmt = '0.#';
      weeks.forEach((w, wi) => {
        // PMWD：逐日重疊天數改成「工作日重疊天數」後就不再是能在 SUMPRODUCT 裡逐元素展開的算式
        // （NETWORKDAYS 不是逐元素函數）。故把「每個任務 × 每一週的工時」拆到「週工時明細」輔助頁
        // 一格一式算好，這裡只做「挑出這個人的列並加總」——公式仍然全程可重算。
        const hCol = colLetter(wi + 4); // 週工時明細：A 任務 / B 負責人 / C 工作日模式 / D 起為各週
        const cell = ov.getCell(r, wi + 3);
        cell.value = { formula: `SUMPRODUCT((${A}=$A${r})*週工時明細!${hCol}$2:${hCol}$${lastRow})` };
        cell.numFmt = '0.#;;';   // hide zeros — 空白格＝這週沒事，一眼看得出誰有餘裕
        cell.alignment = { horizontal: 'right' };
      });
      const firstW = colLetter(3), lastW = colLetter(weeks.length + 2);
      const tot = ov.getCell(r, totalCol);
      tot.value = { formula: `SUM(${firstW}${r}:${lastW}${r})` };
      tot.numFmt = '0.#';
      tot.font = { bold: true };
      tot.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1F5F9' } };
    });

    const sumRow = TBL + 1 + people.length;
    ov.getCell(`A${sumRow}`).value = '每週合計';
    ov.getCell(`A${sumRow}`).font = { bold: true };
    for (let c = 3; c <= totalCol; c++) {
      const L = colLetter(c);
      const cell = ov.getCell(sumRow, c);
      cell.value = { formula: `SUM(${L}${TBL + 1}:${L}${sumRow - 1})` };
      cell.numFmt = '0.#;;';
      cell.font = { bold: true };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1F5F9' } };
    }

    // ---- PMWD：第二張對照表「該週可投入工時」。可投入不再是固定的每週工時——那一週請幾天假，
    // 可投入就少幾天份。底色的比較基準必須用它，否則請假那週會被誤判成還很寬裕。
    const capTBL = sumRow + 2;
    ov.getCell(`A${capTBL - 1}`).value = '該週可投入工時（已扣週末與個人休假，單位：小時）';
    ov.getCell(`A${capTBL - 1}`).font = { bold: true, size: 11 };
    ov.getCell(`A${capTBL}`).value = '人員';
    ov.getCell(`B${capTBL}`).value = '名目每週可投入(h)';
    weeks.forEach((w, i) => {
      const c = ov.getCell(capTBL, i + 3);
      c.value = excelSerial(w);
      c.numFmt = 'mm/dd';
      c.alignment = { horizontal: 'right' };
    });
    ov.getRow(capTBL).font = { bold: true };
    ov.getRow(capTBL).eachCell(c => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE2E8F0' } }; });
    people.forEach((p, pi) => {
      const r = capTBL + 1 + pi;
      ov.getCell(`A${r}`).value = p.name;
      ov.getCell(`B${r}`).value = p.weeklyHours;
      ov.getCell(`B${r}`).numFmt = '0.#';
      const perDay = Math.round((p.weeklyHours / HOURS_PER_WORKDAY_DIVISOR) * 1000) / 1000;
      // 這個人這一週能上幾天班：NETWORKDAYS(週一, 週日, 他自己的休假日)。改休假日 → 這裡自動重算。
      const holArg = p.daysOff.length ? `,休假日!$${colLetter(holPeople.findIndex(x => x.id === p.id) + 1)}$2:$${colLetter(holPeople.findIndex(x => x.id === p.id) + 1)}$${holLastRow}` : '';
      weeks.forEach((w, wi) => {
        const ws = excelSerial(w);
        const cell = ov.getCell(r, wi + 3);
        cell.value = { formula: `ROUND(NETWORKDAYS(${ws},${ws + 6}${holArg})*${perDay},1)` };
        cell.numFmt = '0.#';
        cell.alignment = { horizontal: 'right' };
        cell.font = { color: { argb: 'FF94A3B8' } };
      });
    });

    // 超載提醒：某人某週光是本專案就吃掉超過他「那一週」可投入工時 → 紅底；80% 以上 → 黃底。
    const firstBodyCell = colLetter(3) + (TBL + 1);
    const firstCapCell = colLetter(3) + (capTBL + 1);
    ov.addConditionalFormatting({
      ref: `${colLetter(3)}${TBL + 1}:${colLetter(weeks.length + 2)}${TBL + people.length}`,
      rules: [
        { type: 'expression', formulae: [`AND(${firstCapCell}>0,${firstBodyCell}>${firstCapCell})`], style: { fill: { type: 'pattern', pattern: 'solid', bgColor: { argb: 'FFFECACA' } } }, priority: 1, stopIfTrue: true },
        { type: 'expression', formulae: [`AND(${firstCapCell}>0,${firstBodyCell}>=${firstCapCell}*0.8)`], style: { fill: { type: 'pattern', pattern: 'solid', bgColor: { argb: 'FFFEF08A' } } }, priority: 2, stopIfTrue: true },
        { type: 'expression', formulae: [`${firstBodyCell}>0`], style: { fill: { type: 'pattern', pattern: 'solid', bgColor: { argb: 'FFDCFCE7' } } }, priority: 3 },
      ],
    });
    const noteRow = capTBL + people.length + 2;
    ov.getCell(`A${noteRow}`).value = '註：只統計「有指派負責人且有起訖日期」的任務，里程碑不計。工時只攤在工作日上——週六日一律不算，再扣掉該人員自己的休假日（人員設定裡維護）；未填預估工時者視為整段工期的每個工作日全職投入。底色為本專案該週佔用比例（分母＝上方「該週可投入工時」表）：綠＝寬裕、黃＝80% 以上、紅＝超過可投入工時。';
    ov.getCell(`A${noteRow}`).font = { size: 9, color: { argb: 'FF94A3B8' } };
  } else {
    ov.getCell(`A${TBL}`).value = '（尚無「已指派人員且有起訖日期」的任務）';
    ov.getCell(`A${TBL}`).font = { size: 10, color: { argb: 'FF94A3B8' } };
  }

  // ---------- 甘特圖 (Gantt) — conditional-formatting bars, formula-linked to 清單 ----------
  const gantt = wb.addWorksheet('甘特圖', { views: [{ state: 'frozen', xSplit: 2, ySplit: 1 }] });
  gantt.getColumn(1).width = 24;
  gantt.getColumn(2).width = 12;
  gantt.getCell('A1').value = '任務';
  gantt.getCell('B1').value = '負責人';
  gantt.getCell('A1').font = { bold: true };
  gantt.getCell('B1').font = { bold: true };

  if (n > 0 && minStart && maxEnd) {
    const rangeStart = new Date(minStart); rangeStart.setDate(rangeStart.getDate() - 1);
    const rangeEnd = new Date(maxEnd); rangeEnd.setDate(rangeEnd.getDate() + 1);
    const totalDays = Math.round((rangeEnd - rangeStart) / 86400000) + 1;

    for (let i = 0; i < totalDays; i++) {
      const colIdx = i + 3; // column C = first date (A=任務, B=負責人)
      const d = new Date(rangeStart); d.setDate(d.getDate() + i);
      const cell = gantt.getCell(1, colIdx);
      cell.value = excelSerial(d);
      cell.numFmt = 'mm/dd';
      cell.font = { size: 9, bold: true };
      gantt.getColumn(colIdx).width = 3;
    }

    sorted.forEach((t, i) => {
      const r = i + 2;
      gantt.getCell(`A${r}`).value = { formula: `清單!A${r}` };
      gantt.getCell(`B${r}`).value = { formula: `清單!B${r}` };
    });

    const lastColLetter = colLetter(totalDays + 2);
    const bodyRef = `C2:${lastColLetter}${lastRow}`;

    // Priority: milestone (top) > completed portion (dark) > planned span (light) > today column (bottom, own rule below).
    gantt.addConditionalFormatting({
      ref: bodyRef,
      rules: [
        {
          type: 'expression',
          formulae: ['AND(清單!$J2="是",C$1=清單!$C2)'],
          style: { fill: { type: 'pattern', pattern: 'solid', bgColor: { argb: 'FFA855F7' } } },
          priority: 1,
          stopIfTrue: true,
        },
        {
          type: 'expression',
          formulae: ['AND(C$1>=清單!$C2,C$1<=清單!$C2+清單!$M2-1)'],
          style: { fill: { type: 'pattern', pattern: 'solid', bgColor: { argb: 'FF0891B2' } } },
          priority: 2,
          stopIfTrue: true,
        },
        {
          type: 'expression',
          formulae: ['AND(C$1>=清單!$C2,C$1<=清單!$D2)'],
          style: { fill: { type: 'pattern', pattern: 'solid', bgColor: { argb: 'FFA5F3FC' } } },
          priority: 3,
        },
        // PMWD：週末直條（灰）。個人休假日不在這裡上色——CF 公式若跨頁籤引用「休假日」表，
        // 在部分 Excel 版本會被判為不合法而整份格式化失效，寧可少一個顏色也不冒毀檔的風險。
        {
          type: 'expression',
          formulae: ['WEEKDAY(C$1,2)>5'],
          style: { fill: { type: 'pattern', pattern: 'solid', bgColor: { argb: 'FFE2E8F0' } } },
          priority: 4,
        },
      ],
    });
    gantt.addConditionalFormatting({
      ref: `C1:${lastColLetter}1`,
      rules: [{
        type: 'expression',
        formulae: ['C$1=TODAY()'],
        style: { fill: { type: 'pattern', pattern: 'solid', bgColor: { argb: 'FFF97316' } }, font: { color: { argb: 'FFFFFFFF' }, bold: true } },
        priority: 10,
      }],
    });
  }

  // ---------- PMWD 輔助頁：休假日 / 週工時明細 ----------
  // 兩張都刻意「看得見」而不是隱藏起來：指揮官在 Excel 裡看到某人某週工時不對時，可以直接翻到這裡
  // 逐格對，而不是面對一串看不懂的 SUMPRODUCT。公式全部指向「清單」，改日期或改休假都會自動重算。
  if (hasHol) {
    const hol = wb.addWorksheet('休假日');
    hol.getRow(1).font = { bold: true };
    holPeople.forEach((p, i) => {
      hol.getColumn(i + 1).width = 13;
      hol.getCell(1, i + 1).value = p.name;
      hol.getCell(1, i + 1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE2E8F0' } };
      p.daysOff.forEach((d, j) => {
        const c = hol.getCell(j + 2, i + 1);
        c.value = excelSerial(parseDate(d));
        c.numFmt = 'yyyy-mm-dd';
      });
    });
    hol.getCell(holLastRow + 2, 1).value = '註：一欄一人，欄內是他「週末以外」的休假日。此表是「清單」工作天欄與「總覽」逐週工時的依據，改這裡的日期，整份檔案會自動重算。';
    hol.getCell(holLastRow + 2, 1).font = { size: 9, color: { argb: 'FF94A3B8' } };
  }

  if (n > 0 && weeks.length) {
    const det = wb.addWorksheet('週工時明細', { views: [{ state: 'frozen', xSplit: 3, ySplit: 1 }] });
    det.getColumn(1).width = 24;
    det.getColumn(2).width = 12;
    det.getColumn(3).width = 10;
    det.getCell('A1').value = '任務';
    det.getCell('B1').value = '負責人';
    det.getCell('C1').value = '有工作日';
    weeks.forEach((w, i) => {
      const c = det.getCell(1, i + 4);
      c.value = excelSerial(w);
      c.numFmt = 'mm/dd';
      c.alignment = { horizontal: 'right' };
      det.getColumn(i + 4).width = 8;
    });
    det.getRow(1).font = { bold: true };
    det.getRow(1).eachCell(c => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE2E8F0' } }; });

    sorted.forEach((t, i) => {
      const r = i + 2;
      det.getCell(`A${r}`).value = { formula: `清單!A${r}` };
      det.getCell(`B${r}`).value = { formula: `清單!B${r}` };
      // 0 = 整段工期都落在非工作日（例如只排了週六日）→ 後端會退回按曆日攤，這裡照做，兩邊才對得起來。
      det.getCell(`C${r}`).value = { formula: `IF(IFERROR(${nwd(`清單!$C${r}`, `清單!$D${r}`, r)},0)>0,1,0)` };
      det.getCell(`C${r}`).font = { color: { argb: 'FF94A3B8' } };
      weeks.forEach((w, wi) => {
        const ws = excelSerial(w);
        const we = ws + 6;
        const lo = `MAX(清單!$C${r},${ws})`;
        const hi = `MIN(清單!$D${r},${we})`;
        // 這一格＝該任務在該週貢獻的工時＝每工作日工時 × 該週落在工期內的工作日數。
        // 里程碑、沒日期、與該週無交集者一律 0。
        const overlapWork = `IF($C${r}=1,IFERROR(${nwd(lo, hi, r)},0),${hi}-${lo}+1)`;
        const cell = det.getCell(r, wi + 4);
        cell.value = { formula: `IFERROR(IF(OR(清單!$J${r}="是",清單!$C${r}="",清單!$D${r}="",${hi}<${lo}),0,清單!$L${r}*${overlapWork}),0)` };
        cell.numFmt = '0.##;;';
        cell.alignment = { horizontal: 'right' };
      });
    });
    det.getCell(`A${lastRow + 2}`).value = '註：本頁是「總覽」逐週工時表的計算來源（一格＝一個任務在一週內的工時）。工時只算工作日：週六日不算，再扣掉該負責人的休假日（見「休假日」頁）。';
    det.getCell(`A${lastRow + 2}`).font = { size: 9, color: { argb: 'FF94A3B8' } };
  }

  return wb;
}

module.exports = { buildPmWorkbook };
