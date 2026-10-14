/* 第三个数字（封板率）必须真的是「今天实时的」，回归测试。
 *
 * 这里出过一个错：页面上第三个数字原本挂的是「昨日非一字板封板率」——
 * 那是 ①② 两个公式的输入权重，不是今天的行情。两个数常在同一量级，
 * 看着像同一个东西，所以错得很不显眼。
 *
 * 三个场景各自在独立子进程里跑一遍整份 app.js：
 *   A 盘中、池子接口正常            → 今天的非一字板封板率 55.56%（走实时）
 *   B 池子接口 403、今天的归档有 self → 55.56%（走「当日归档定格」，仍是**今天**的数）
 *   C 池子接口 403、没有今天的归档    → 必须显示 --，
 *                                     **绝不能**退成 10-13 那份 77.11%（那就成昨天的数了）
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
let fail = 0;
const ok = (c, m) => { console.log((c ? '  ✔ ' : '  ✘ ') + m); if (!c) fail++; };

// 今天（10-14）的家数：36 涨停 / 6 一字板 / 24 炸板 → 非一字板 30，30/54 = 55.5556%
const T_ZT = 36, T_OW = 6, T_ZB = 24;
const TODAY_FBL = '55.56%';
// 存档里那份「昨日基准」：10-13 的 64/83 = 77.11%（**不该出现在第三个数字里**）
const ARCH_FBL = 77.1084;

const TS_TODAY = Math.floor(Date.parse('2026-10-14T01:40:00Z') / 1000);
const TS_PREV = Math.floor(Date.parse('2026-10-13T01:40:00Z') / 1000);

const CFG = {
  A: { desc: '盘中 · 池子接口正常', poolMode: 'ok', todayArchive: true },
  B: { desc: '池子接口 403 · 今天的归档里有 self', poolMode: 'down', todayArchive: true },
  C: { desc: '池子接口 403 · 没有今天的归档（只能显示 --）', poolMode: 'down', todayArchive: false }
};

/* ============================ 子进程：真跑一遍 app.js ============================ */
if (process.argv[2] === '--run') {
  const name = process.argv[3];
  const C = CFG[name];
  const src = fs.readFileSync(path.join(root, 'app.js'), 'utf8').replace(/\r\n/g, '\n');

  // 冻结时钟：2026-10-14 10:30 北京时间（周三、盘中）
  const RealDate = Date;
  const clock = RealDate.parse('2026-10-14T02:30:00Z');
  global.Date = class extends RealDate {
    constructor(...a) { if (a.length === 0) super(clock); else super(...a); }
    static now() { return clock; }
  };

  const pad2 = n => (n < 10 ? '0' : '') + n;
  function series(cb, date, pre, drift) {
    const rows = [];
    for (let i = 0; i < 61; i++) {
      const m = 9 * 60 + 30 + i;
      rows.push(pad2(Math.floor(m / 60)) + pad2(m % 60) + ',' + (pre * (1 + drift + i * 0.0002)).toFixed(3) + ',1000');
    }
    return 'quotebridge_v6_time_' + cb + '({"' + cb + '":{"date":"' + date +
      '","pre":"' + pre + '","data":"' + rows.join(';') + '"}})';
  }
  const resp = (text, json) => ({ ok: true, status: 200, text: async () => text, json: async () => json });
  const notFound = () => ({ ok: false, status: 404, text: async () => '', json: async () => null });

  const urls = [];
  global.fetch = async function (url) {
    const u = String(url);
    urls.push(u);
    if (u.indexOf('/v6/time/48_883900') >= 0) return resp(series('48_883900', '20261014', 100, 0.016), null);
    if (u.indexOf('/v6/time/hs_1A0001') >= 0) return resp(series('hs_1A0001', '20261014', 3000, -0.002), null);
    if (u.indexOf('/v6/time/48_883918') >= 0) return resp(series('48_883918', '20261014', 100, -0.032), null);

    if (u.indexOf('limit_up') >= 0) {
      if (C.poolMode === 'down') throw new Error('HTTP 403');
      const dm = u.match(/date=(\d{8})/);
      const d = dm ? dm[1] : '';
      const isToday = (d === '20261014');
      if (u.indexOf('open_limit_pool') >= 0) {
        return resp(null, { data: { page: { total: isToday ? T_ZB : 19 }, info: [] } });
      }
      if (isToday) {
        return resp(null, {
          data: {
            page: { total: T_ZT },
            info: Array.from({ length: T_ZT }, (_, i) => ({
              first_limit_up_time: TS_TODAY, limit_up_type: i < T_OW ? '一字板' : '换手板'
            }))
          }
        });
      }
      // 其它交易日（给「退到上一个交易日」这条路用）
      return resp(null, {
        data: {
          page: { total: 67 },
          info: Array.from({ length: 67 }, (_, i) => ({
            first_limit_up_time: TS_PREV, limit_up_type: i < 3 ? '一字板' : '换手板'
          }))
        }
      });
    }

    // 归档（跨域读电脑版仓库）
    if (u.indexOf('index.json') >= 0) {
      const ds = ['2026-10-12', '2026-10-13'];
      if (C.todayArchive) ds.push('2026-10-14');
      return resp(null, { dates: ds });
    }
    if (/2026-10-14\.json/.test(u) && !C.todayArchive) return notFound();
    if (u.indexOf('latest.json') >= 0) return resp(null, {
      date: '2026-10-14',
      rate: { date: '20261013', zt: 67, zb: 19, oneWord: 3, base: 64, rate: 77.907, fbl: ARCH_FBL, zbl: 22.893 },
      self: { date: '20261014', zt: T_ZT, zb: T_ZB, oneWord: T_OW, base: 30, rate: 60, fbl: 55.5556, zbl: 44.4444 }
    });
    if (/2026-10-14\.json/.test(u)) return resp(null, {
      date: '2026-10-14',
      rate: { date: '20261013', zt: 67, zb: 19, oneWord: 3, base: 64, rate: 77.907, fbl: ARCH_FBL, zbl: 22.893 },
      // 今天**自己**的家数（collect.js 落盘时写的）。注意 date 是字符串，跟 rate.date 一样。
      self: { date: '20261014', zt: T_ZT, zb: T_ZB, oneWord: T_OW, base: 30, rate: 60, fbl: 55.5556, zbl: 44.4444 },
      points: [{ t: '09:30', a: 1.8, b: -0.2, c: -1.4 }, { t: '10:30', a: 1.2, b: -0.3, c: -2.1 }]
    });
    if (/2026-10-\d\d\.json/.test(u)) return resp(null, {
      date: '2026-10-13',
      rate: { date: '20261012', zt: 46, zb: 25, oneWord: 5, base: 41, rate: 64.78, fbl: 62.12, zbl: 37.87 },
      points: [{ t: '09:30', a: 2.6, b: -0.1, c: -3.2 }, { t: '15:00', a: 1.7, b: -0.4, c: -4.1 }]
    });
    throw new Error('未预料的请求：' + u);
  };

  const els = {};
  const mkEl = id => ({
    id, textContent: '', className: '', innerHTML: '', title: '',
    _attrs: {}, _handlers: {}, _children: [],
    getAttribute(k) { return this._attrs[k]; },
    addEventListener(t, f) { this._handlers[t] = f; },
    querySelectorAll() { return this._children; },
    closest() { return null; }
  });
  global.document = {
    title: '打板', hidden: false,
    getElementById: id => (els[id] = els[id] || mkEl(id)),
    createElement: () => ({ style: {}, setAttribute() {}, remove() {}, parentNode: null }),
    addEventListener() {}, removeEventListener() {}
  };
  global.window = { addEventListener() {}, removeEventListener() {} };
  let chartN = 0;
  global.echarts = { init() { chartN++; return { clear() {}, resize() {}, setOption() {} }; } };
  global.Blob = class { constructor(p) { this.parts = p; } };
  global.URL = { createObjectURL: () => 'blob:stub' };
  global.Worker = function () { return { onmessage: null, onerror: null, postMessage() {}, terminate() {} }; };
  global.setInterval = () => 1;
  global.clearInterval = () => {};

  try { new Function(src)(); } catch (e) {
    console.log('RESULT ' + JSON.stringify({ bootError: String(e && e.message) }));
    process.exit(0);
  }

  const t0 = RealDate.now();
  (function wait() {
    const rv = els['curRate'] ? els['curRate'].textContent : '';
    const cv = els['curValue'] ? els['curValue'].textContent : '';
    // curRate 被 renderTodayRate 写过就算完成（'--' 也算），再加一个超时兜底
    const done = (els['curRate'] && els['curRate'].title) || RealDate.now() - t0 > 8000;
    if (done) {
      console.log('RESULT ' + JSON.stringify({
        curRate: rv, curRateTitle: (els['curRate'] || {}).title || '',
        curValue: cv, curValue2: els['curValue2'] ? els['curValue2'].textContent : '',
        poolHits: urls.filter(u => u.indexOf('limit_up') >= 0).length,
        bootError: null
      }));
      process.exit(0);
    }
    setTimeout(wait, 50);
  })();
  return;
}

/* ============================ 主进程：逐场景断言 ============================ */
function run(name) {
  const out = execFileSync(process.execPath, [__filename, '--run', name], { encoding: 'utf8' });
  const line = out.split('\n').find(l => l.indexOf('RESULT ') === 0);
  if (!line) throw new Error('子进程没有输出结果：\n' + out);
  return JSON.parse(line.slice('RESULT '.length));
}

for (const name of Object.keys(CFG)) {
  const C = CFG[name];
  console.log('\n[场景 ' + name + '] ' + C.desc);
  const r = run(name);
  ok(!r.bootError, 'app.js 启动无异常' + (r.bootError ? '（' + r.bootError + '）' : ''));
  if (r.bootError) continue;

  ok(r.poolHits > 0, '取过涨停池 / 炸板池（' + r.poolHits + ' 次）');
  ok(/^-?\d+\.\d{4}$/.test(String(r.curValue)), '① 照常算出值 = ' + r.curValue);

  if (name === 'A' || name === 'B') {
    ok(r.curRate === TODAY_FBL, '第三个数字 = 今天的非一字板封板率 ' + TODAY_FBL + '（实际 ' + r.curRate + '）');
    ok(/30\/54/.test(r.curRateTitle), 'title 写明今日算式：' + r.curRateTitle.split('\n').join(' | '));
    if (name === 'A') ok(/今日实时/.test(r.curRateTitle), '来源标为「今日实时」');
    if (name === 'B') ok(/收盘定格/.test(r.curRateTitle), '来源标为「收盘定格」（接口取不到，用的是今天自己的归档）');
  } else {
    ok(r.curRate === '--', '第三个数字 = --（实际 ' + r.curRate + '）');
    ok(String(r.curRate) !== ARCH_FBL.toFixed(2) + '%',
      '没有退成 10-13 那份 ' + ARCH_FBL.toFixed(2) + '%（那会变成昨天的数）');
    ok(/暂未取到/.test(r.curRateTitle), 'title 说明了取不到：' + r.curRateTitle);
  }
}

console.log('\n' + (fail ? '❌ 有 ' + fail + ' 项未通过' : '✅ 全部通过'));
process.exit(fail ? 1 : 0);
