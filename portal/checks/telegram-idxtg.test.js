// IDX-TG：/today /schedules /status 改前（_tmp/telegram.js.before-idxtg）vs 改後輸出比對＋耗時。不接真 bot、不起 server。
// 用法：node portal/checks/telegram-idxtg.test.js <樣本家目錄> <before 的 telegram.js 路徑>
const path = require('path');
const { SchedulerManager } = require('../scheduler');
const home = path.resolve(process.argv[2]);
const beforePath = path.resolve(process.argv[3]);
function mk(file) {
  const { TelegramBot } = require(file);
  return TelegramBot;
}
async function run(Cls, sm, ctxRoot, label) {
  const bot = new Cls(home, sm, {});
  const out = {};
  bot.sendMessage = async (c, t) => { out.t = t; };
  bot._logConsole = () => {};
  bot.getContext = () => ctxRoot ? { root: ctxRoot, label } : null;
  const res = {};
  for (const cmd of ['_cmdToday', '_cmdSchedules', '_cmdStatus']) {
    const t0 = process.hrtime.bigint();
    await bot[cmd](1);
    res[cmd] = { ms: Number(process.hrtime.bigint() - t0) / 1e6, text: out.t };
  }
  return res;
}
(async () => {
  const sm = new SchedulerManager(home);
  await sm.warmSchedIndex(); await sm.warmRunIndex();
  const Before = mk(beforePath), After = mk(path.join(__dirname, '..', 'telegram.js'));
  const wsList = [home, 'D:/SideProject/g8d_harness', 'D:/Projects/客戶專案', null];
  let bad = 0;
  for (const ws of wsList) {
    const b = await run(Before, sm, ws, 'T'), a = await run(After, sm, ws, 'T');
    for (const k of Object.keys(b)) {
      const same = b[k].text === a[k].text;
      if (!same) bad++;
      console.log(String(ws).slice(-14).padEnd(14), k.padEnd(13), same ? '相同' : '不同', '改前', b[k].ms.toFixed(1) + 'ms', '改後', a[k].ms.toFixed(1) + 'ms');
      if (!same) console.log('  前:', JSON.stringify(b[k].text).slice(0, 300), '\n  後:', JSON.stringify(a[k].text).slice(0, 300));
    }
  }
  process.exit(bad ? 1 : 0);
})();
