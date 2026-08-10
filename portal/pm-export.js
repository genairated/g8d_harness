'use strict';
// PM Excel export — SPEC-project-management.md §匯出 (2026-08-07 追加).
// Builds a 3-tab workbook (總覽/清單/甘特圖) with formulas so that editing the 清單 tab
// (dates/progress/deps) automatically re-drives the 甘特圖 conditional-formatting bars and the
// 總覽 stats — no manual re-export needed for a date/progress tweak, only for structural changes
// (add/remove task rows) since column widths/row count are fixed at export time.
const ExcelJS = require('exceljs');

const STATUS_LABEL = { todo: '待辦', in_progress: '進行中', done: '完成' };

function localDateOnly(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

// Ontime Rate — SPEC ask: total scheduled person-days elapsed as of today vs. actually completed
// person-days (duration * progress%), summed across tasks that have started. See chat decision
// 2026-08-07: 100 人天工作項、已過 20 天且都完成 = 100%；只完成 18 人天 = 90%.
function buildPmWorkbook(project, tasks) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Hana / Harness PM';
  wb.created = new Date();

  const sorted = tasks.slice().sort((a, b) => (a.order || 0) - (b.order || 0));
  const byId = new Map(sorted.map(t => [t.id, t]));
  const n = sorted.length;
  const lastRow = n + 1; // header is row 1, data rows 2..lastRow

  // ---------- 清單 (List) ----------
  const list = wb.addWorksheet('清單', { views: [{ state: 'frozen', ySplit: 1 }] });
  list.columns = [
    { header: '任務名稱', key: 'name', width: 24 },
    { header: '開始', key: 'start', width: 12 },
    { header: '結束', key: 'end', width: 12 },
    { header: '工期(天)', key: 'dur', width: 10 },
    { header: '進度(%)', key: 'progress', width: 10 },
    { header: '狀態', key: 'status', width: 10 },
    { header: '相依(前置任務)', key: 'deps', width: 24 },
    { header: '里程碑', key: 'milestone', width: 8 },
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
    row.getCell(2).value = t.start ? new Date(t.start + 'T00:00:00') : null;
    row.getCell(3).value = t.end ? new Date(t.end + 'T00:00:00') : null;
    row.getCell(4).value = { formula: `C${r}-B${r}+1` };
    row.getCell(5).value = typeof t.progress === 'number' ? t.progress : 0;
    row.getCell(6).value = STATUS_LABEL[t.status] || '待辦';
    row.getCell(7).value = depNames;
    row.getCell(8).value = t.isMilestone ? '是' : '否';
    row.getCell(9).value = { formula: `ROUND(D${r}*E${r}/100,0)` };
    row.getCell(10).value = { formula: `IF(TODAY()<B${r},0,MIN(D${r},TODAY()-B${r}+1))` };
    row.getCell(11).value = { formula: `IF(J${r}=0,0,I${r})` };
    row.getCell(2).numFmt = 'yyyy-mm-dd';
    row.getCell(3).numFmt = 'yyyy-mm-dd';
    row.getCell(9).font = { color: { argb: 'FF94A3B8' }, italic: true };
    row.getCell(10).font = { color: { argb: 'FF94A3B8' }, italic: true };
    row.getCell(11).font = { color: { argb: 'FF94A3B8' }, italic: true };
  });

  // ---------- 總覽 (Overview) ----------
  const ov = wb.addWorksheet('總覽');
  ov.columns = [{ width: 20 }, { width: 20 }];
  ov.mergeCells('A1:B1');
  ov.getCell('A1').value = project.name + ' — 專案總覽';
  ov.getCell('A1').font = { bold: true, size: 14 };
  ov.getCell('A2').value = '匯出時間';
  ov.getCell('B2').value = new Date();
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
    stat(5, '已完成', `COUNTIF(清單!F2:F${lastRow},"完成")`);
    stat(6, '完成百分比', `IFERROR(B5/B4,0)`, '0.0%');
    stat(7, 'Ontime Rate', `IFERROR(SUM(清單!K2:K${lastRow})/SUM(清單!J2:J${lastRow}),"—")`, '0.0%');
  } else {
    ov.getCell('A4').value = '（尚無任務）';
  }
  ov.getCell('A9').value = '完成度';
  ov.getCell('A9').font = { bold: true };
  // Simple text progress bar: 20 cells, each = 5%, filled green when 完成百分比 >= that step.
  if (n > 0) {
    for (let i = 0; i < 20; i++) {
      const col = String.fromCharCode(66 + i); // B, C, D...
      if (col.charCodeAt(0) > 90) break; // stop at Z to stay within basic columns
      const cell = ov.getCell(`${col}10`);
      cell.value = '';
      ov.addConditionalFormatting({
        ref: `${col}10`,
        rules: [{
          type: 'expression',
          formulae: [`$B$6>=${(i + 1) * 0.05}`],
          style: { fill: { type: 'pattern', pattern: 'solid', bgColor: { argb: 'FF22C55E' } } },
          priority: i + 1,
        }],
      });
      ov.getColumn(col).width = 3;
    }
  }

  // ---------- 甘特圖 (Gantt) — conditional-formatting bars, formula-linked to 清單 ----------
  const gantt = wb.addWorksheet('甘特圖', { views: [{ state: 'frozen', xSplit: 1, ySplit: 1 }] });
  gantt.getColumn(1).width = 24;
  gantt.getCell('A1').value = '任務';
  gantt.getCell('A1').font = { bold: true };

  let minStart = null, maxEnd = null;
  sorted.forEach(t => {
    if (t.start) { const d = localDateOnly(new Date(t.start + 'T00:00:00')); if (!minStart || d < minStart) minStart = d; }
    if (t.end) { const d = localDateOnly(new Date(t.end + 'T00:00:00')); if (!maxEnd || d > maxEnd) maxEnd = d; }
  });
  if (n > 0 && minStart && maxEnd) {
    const rangeStart = new Date(minStart); rangeStart.setDate(rangeStart.getDate() - 1);
    const rangeEnd = new Date(maxEnd); rangeEnd.setDate(rangeEnd.getDate() + 1);
    const totalDays = Math.round((rangeEnd - rangeStart) / 86400000) + 1;

    for (let i = 0; i < totalDays; i++) {
      const colIdx = i + 2; // column B = first date
      const d = new Date(rangeStart); d.setDate(d.getDate() + i);
      const cell = gantt.getCell(1, colIdx);
      cell.value = d;
      cell.numFmt = 'mm/dd';
      cell.font = { size: 9, bold: true };
      gantt.getColumn(colIdx).width = 3;
    }

    sorted.forEach((t, i) => {
      const r = i + 2;
      gantt.getCell(`A${r}`).value = { formula: `清單!A${r}` };
    });

    const lastCol = totalDays + 1;
    const lastColLetter = gantt.getColumn(lastCol).letter;
    const bodyRef = `B2:${lastColLetter}${lastRow}`;

    // Priority: milestone (top) > completed portion (dark) > planned span (light) > today column (bottom, own rule below).
    gantt.addConditionalFormatting({
      ref: bodyRef,
      rules: [
        {
          type: 'expression',
          formulae: [`AND(清單!$H2="是",B$1=清單!$B2)`],
          style: { fill: { type: 'pattern', pattern: 'solid', bgColor: { argb: 'FFA855F7' } } },
          priority: 1,
          stopIfTrue: true,
        },
        {
          type: 'expression',
          formulae: [`AND(B$1>=清單!$B2,B$1<=清單!$B2+清單!$I2-1)`],
          style: { fill: { type: 'pattern', pattern: 'solid', bgColor: { argb: 'FF0891B2' } } },
          priority: 2,
          stopIfTrue: true,
        },
        {
          type: 'expression',
          formulae: [`AND(B$1>=清單!$B2,B$1<=清單!$C2)`],
          style: { fill: { type: 'pattern', pattern: 'solid', bgColor: { argb: 'FFA5F3FC' } } },
          priority: 3,
        },
      ],
    });
    gantt.addConditionalFormatting({
      ref: `B1:${lastColLetter}1`,
      rules: [{
        type: 'expression',
        formulae: ['B$1=TODAY()'],
        style: { fill: { type: 'pattern', pattern: 'solid', bgColor: { argb: 'FFF97316' } }, font: { color: { argb: 'FFFFFFFF' }, bold: true } },
        priority: 10,
      }],
    });
  }

  return wb;
}

module.exports = { buildPmWorkbook };
