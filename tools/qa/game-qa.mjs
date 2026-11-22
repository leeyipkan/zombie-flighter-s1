// Headless QA for index.html — loads the real game script against a minimal
// DOM/canvas stub, then drives the exposed __G API.
//   node tools/qa/game-qa.mjs
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';

/* ---------------- DOM / canvas stubs ---------------- */
const elements = new Map();
function makeEl(id){
  const el = {
    id, innerHTML:'', textContent:'', title:'', dataset:{},
    style:{}, width:0, height:0,
    classList:{ _s:new Set(), add(c){ this._s.add(c); }, remove(c){ this._s.delete(c); },
      toggle(c,on){ if(on === undefined) on = !this._s.has(c); on ? this._s.add(c) : this._s.delete(c); },
      contains(c){ return this._s.has(c); } },
    addEventListener(){}, focus(){}, closest(){ return null; },
    getBoundingClientRect(){ return { left:0, top:0, width:1056, height:600 }; },
    getContext(){ return ctxStub; },
  };
  return el;
}
const gradient = { addColorStop(){} };
const ctxStub = new Proxy({
  createRadialGradient(){ return gradient; },
  createLinearGradient(){ return gradient; },
  measureText(){ return { width:10 }; },
}, {
  get(t,p){ if (p in t) return t[p]; return () => {}; },
  set(){ return true; },
});

globalThis.window = globalThis;
globalThis.addEventListener = () => {};
globalThis.document = {
  getElementById(id){
    if (!elements.has(id)) elements.set(id, makeEl(id));
    return elements.get(id);
  },
  createElement(){ return makeEl('created'); },
  querySelector(){ return null; },
  addEventListener(){},
};
globalThis.devicePixelRatio = 1;
globalThis.AudioContext = undefined;
globalThis.webkitAudioContext = undefined;

/* localStorage stub for save/load tests */
const store = new Map();
globalThis.localStorage = {
  getItem(k){ return store.has(k) ? store.get(k) : null; },
  setItem(k, v){ store.set(k, String(v)); },
  removeItem(k){ store.delete(k); },
};

const html = readFileSync(resolve('index.html'), 'utf8');
const m = html.match(/<script>([\s\S]*)<\/script>/);
if (!m) throw new Error('script block not found');

vm.runInThisContext(m[1], { filename: 'index.html#game' });
const G = globalThis.__G;
if (!G) throw new Error('__G not exposed');
const W = G.W, H = G.H;

/* ---------------- test helpers ---------------- */
let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail){
  if (cond){ pass++; console.log(`  ok   ${name}`); }
  else { fail++; failures.push(name + (detail !== undefined ? ` — ${detail}` : '')); console.log(`  FAIL ${name}${detail !== undefined ? ' — ' + detail : ''}`); }
}
function section(t){ console.log(`\n== ${t} ==`); }
function reset(){
  G.newGame(false);
  G.S.zombies.length = 0;
  G.S.hp = 100;
}
function clearBag(){ G.S.bag.length = 0; }
function give(obj){ for (const k in obj) G.addItem(k, obj[k]); }
function walkable(x,y){
  if (x < 0 || y < 0 || x >= W || y >= H) return false;
  const t = G.MAP.terr[y*W+x];
  if (t === G.T.WALL || t === G.T.BARRICADE) return false;
  const p = G.MAP.props.get(y*W+x);
  return !(p && p.block);
}
function bfsReach(sx,sy, openBarricade){
  const seen = new Set([sy*W+sx]);
  const q = [[sx,sy]];
  while (q.length){
    const [x,y] = q.shift();
    for (const [dx,dy] of G.DIRS){
      const nx = x+dx, ny = y+dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const ni = ny*W+nx;
      if (seen.has(ni)) continue;
      const t = G.MAP.terr[ni];
      if (t === G.T.WALL) continue;
      if (t === G.T.BARRICADE && !openBarricade) continue;
      const p = G.MAP.props.get(ni);
      if (p && p.block) continue;
      seen.add(ni);
      q.push([nx,ny]);
    }
  }
  return seen;
}
function freeNeighbor(p){
  for (const [dx,dy] of G.DIRS){
    const x = p.x+dx, y = p.y+dy;
    if (walkable(x,y) && !G.zombieAt(x,y)) return { x, y };
  }
  return null;
}
function standAt(p){
  const n = freeNeighbor(p);
  if (!n) return false;
  const S = G.S;
  S.x = n.x; S.y = n.y;
  S.dir = { x: p.x - n.x, y: p.y - n.y };
  G.refresh();
  return true;
}
function containerIn(zoneId, kind){
  return G.MAP.containers.find(c => {
    const z = G.zoneAt(c.x, c.y);
    return z && z.id === zoneId && (!kind || c.kind === kind);
  });
}
function workbench(){
  for (const [,p] of G.MAP.props) if (p.kind === 'workbench') return p;
  return null;
}

/* ---------------- 1. map integrity ---------------- */
section('地圖完整性');
reset();
{
  const S = G.S;
  check('地圖放大到 64x40', W === 64 && H === 40, `${W}x${H}`);
  check('玩家出生點可站立', walkable(S.x,S.y));
  check('出生點沒有殭屍', !G.zombieAt(S.x,S.y));
  check('攝影機有可捲動範圍', W*24 > G.VIEW_W && H*24 > G.VIEW_H, `${W*24}x${H*24} vs ${G.VIEW_W}x${G.VIEW_H}`);

  let badProps = 0, propOnDoor = [];
  for (const [key,p] of G.MAP.props){
    const t = G.MAP.terr[key];
    if (t === G.T.WALL) badProps++;
    if (t === G.T.DOOR) propOnDoor.push(`${p.kind}@${p.x},${p.y}`);
  }
  check('沒有道具壓在牆上', badProps === 0, badProps);
  check('沒有道具堵住門', propOnDoor.length === 0, propOnDoor.join(' '));

  const reachClosed = bfsReach(S.x, S.y, false);
  const reachOpen = bfsReach(S.x, S.y, true);
  const pol = containerIn('police');
  const polN = pol && freeNeighbor(pol);
  check('警局撬門前不可達', !!polN && !reachClosed.has(polN.y*W + polN.x) && reachOpen.has(polN.y*W + polN.x));

  let unreachable = [];
  for (const c of G.MAP.containers){
    const n = freeNeighbor(c);
    if (!n || !reachOpen.has(n.y*W + n.x)) unreachable.push(`${c.kind}@${c.x},${c.y}`);
  }
  check('所有容器都能走到旁邊', unreachable.length === 0, unreachable.join(' '));

  const wb = workbench();
  const wbN = wb && freeNeighbor(wb);
  check('工作台存在且可接近', !!wbN && reachClosed.has(wbN.y*W + wbN.x));

  let badZ = [];
  for (const z of G.S.zombies) if (!walkable(z.x,z.y)) badZ.push(`${z.type}@${z.x},${z.y}`);
  check('初始殭屍站位合法', badZ.length === 0, badZ.join(' '));
  check('初始殭屍不堵門', !G.S.zombies.some(z => G.MAP.terr[z.y*W+z.x] === G.T.DOOR));
  check('八個地點都在地圖上', ['safehouse','market','hardware','gas','hospital','police','apartment','warehouse']
    .every(id => G.ZONES.some(z => z.id === id)));
}

/* ---------------- 2. required endgame parts ---------------- */
section('通關材料');
reset();
{
  const all = [];
  for (const c of G.MAP.containers) for (const e of c.loot) all.push(e);
  const bps = G.MAP.containers.map(c => c.bp).filter(Boolean);
  const cnt = id => all.filter(x => x.id === id).reduce((n,x) => n + x.n, 0);
  check('天線保證存在', cnt('antenna') >= 1, cnt('antenna'));
  check('電路板保證存在', cnt('circuit') >= 1, cnt('circuit'));
  check('電池至少 2 個', cnt('battery') >= 2, cnt('battery'));
  check('電線至少 3 段', cnt('wire') >= 3, cnt('wire'));
  check('三張圖紙齊全', ['bp_axe','bp_riot','bp_radio'].every(b => bps.includes(b)), bps.join(','));
}

/* ---------------- 3. crafting ---------------- */
section('製作系統');
reset();
{
  let S = G.S;
  clearBag();
  give({ wood:2, scrap:2, tape:1 });
  check('釘棒可製作', G.canCraft(G.RECIPES.find(r => r.id === 'bat_nail')).ok === true);
  G.craftRecipe('bat_nail');
  check('釘棒產出到背包', G.countOf('bat_nail') === 1);
  check('材料被扣除', G.countOf('wood') === 0 && G.countOf('scrap') === 0 && G.countOf('tape') === 0);
  check('製作計數 +1', S.crafted === 1);

  clearBag(); give({ wood:1, scrap:1 });
  const before = JSON.stringify(S.bag);
  G.craftRecipe('machete');
  check('材料不足不消耗', JSON.stringify(S.bag) === before);

  clearBag();
  for (const id of ['wood','scrap','cloth','tape','wire','bottle','battery','circuit','antenna']) G.addItem(id,1);
  G.addItem('can',1); G.addItem('bread',1); G.addItem('bat_wood',1);
  give({ wood:2, scrap:2, tape:1 });
  const b2 = JSON.stringify(S.bag);
  const chkFull = G.canCraft(G.RECIPES.find(r => r.id === 'bat_nail'));
  G.craftRecipe('bat_nail');
  check('滿包時拒絕製作', chkFull.ok === false, chkFull.why);
  check('滿包時不消耗材料', JSON.stringify(S.bag) === b2);

  reset(); S = G.S; clearBag(); give({ scrap:4, wood:2, tape:2 });
  check('消防斧預設鎖定', G.canCraft(G.RECIPES.find(r => r.id === 'axe_fire')).ok === false);
  G.learn('bp_axe');
  check('學圖紙後可製作', G.canCraft(G.RECIPES.find(r => r.id === 'axe_fire')).ok === true);

  reset(); S = G.S; clearBag();
  give({ antenna:1, circuit:1, battery:2, wire:3 });
  check('無圖紙不能造發射器', G.canCraft(G.RECIPES.find(r => r.id === 'radio')).ok === false);
  G.learn('bp_radio');
  G.craftRecipe('radio');
  check('發射器製作成功', S.radioBuilt === true && G.countOf('radio') === 1);
  check('發射器材料清空', ['antenna','circuit','battery','wire'].every(id => G.countOf(id) === 0));
  check('不能重複製作發射器', G.canCraft(G.RECIPES.find(r => r.id === 'radio')).ok === false);

  reset(); S = G.S; clearBag();
  S.weapon.dur = 3; give({ scrap:1, tape:1 });
  check('修補可用', G.canCraft(G.RECIPES.find(r => r.id === 'repair')).ok === true);
  G.craftRecipe('repair');
  check('修補後耐久滿', S.weapon.dur === G.ITEM[S.weapon.id].dur);
  check('滿耐久不可修補', G.canCraft(G.RECIPES.find(r => r.id === 'repair')).ok === false);
}

/* ---------------- 4. food stacks ---------------- */
section('食物堆疊（一次只吃一個）');
reset();
{
  const S = G.S;
  S.zombies.length = 0;
  clearBag();
  G.addItem('bandage', 2);
  S.hp = 40;
  G.useBag(0);
  check('吃一次只扣一個', G.countOf('bandage') === 1, G.countOf('bandage'));
  check('吃一次只回一次血', S.hp === 75, S.hp);
  G.useBag(0);
  check('再吃一次才清空', G.countOf('bandage') === 0, G.countOf('bandage'));
  check('第二次回血且不超過上限', S.hp === 100, S.hp);

  clearBag(); G.addItem('can', 2); S.hp = 100;
  const t0 = S.turn;
  G.useBag(0);
  check('滿血不吃、不消耗、不耗回合', G.countOf('can') === 2 && S.turn === t0, `${G.countOf('can')} ${S.turn - t0}`);
}

/* ---------------- 5. search ---------------- */
section('搜刮');
reset();
{
  const S = G.S;
  S.zombies.length = 0;
  clearBag();
  const woodCrate = G.MAP.containers.find(c => c.loot && c.loot.some(e => e.id === 'wood'));
  check('找到含木板的箱子', !!woodCrate);
  standAt(woodCrate);
  G.interact();
  check('搜索後拿到木板', G.countOf('wood') >= 2, G.countOf('wood'));
  check('容器標記為空', woodCrate.searched === true);
  check('搜索消耗一回合', S.turn === 1, S.turn);
  const t0 = S.turn;
  standAt(woodCrate);
  G.interact();
  check('空容器不再消耗回合', S.turn === t0, S.turn - t0);

  const cab = G.MAP.containers.find(c => c.locked === 'crowbar');
  check('找到上鎖的櫃子', !!cab);
  standAt(cab);
  clearBag();
  const t1 = S.turn;
  G.interact();
  check('無撬棍打不開', cab.locked === 'crowbar' && S.turn === t1);
  give({ scrap:3, wood:1 });
  G.craftRecipe('crowbar');
  standAt(cab);
  G.interact();
  check('撬棍打開櫃子', cab.locked === null && G.countOf('bandage') > 0);
}

/* ---------------- 6. combat ---------------- */
section('戰鬥');
reset();
{
  let S = G.S;
  clearBag(); give({ scrap:4, wood:2, tape:2 }); G.learn('bp_axe'); G.craftRecipe('axe_fire');
  S.weapon = { id:'axe_fire', dur:40 };
  S.armor = null;
  S.x = 6; S.y = 5;
  const z = G.spawnZombie('walker', 6, 4);
  G.tryMove(0,-1);
  check('消防斧一擊放倒行屍', z.hp <= 0 && S.kills === 1);
  check('殭屍從場上移除', !S.zombies.includes(z));
  check('屍體留下痕跡', S.corpses.length === 1);

  reset(); S = G.S; S.zombies.length = 0; S.x = 6; S.y = 6; S.armor = null;
  const w = G.spawnZombie('walker', 6, 5);
  w.cd = 1;
  G.doWait(); G.doWait();
  check('行屍每兩回合攻擊一次', S.hp === 96, S.hp);

  reset(); S = G.S; S.zombies.length = 0; S.x = 6; S.y = 6;
  S.armor = { id:'riot_armor', dur:60 };
  const w2 = G.spawnZombie('walker', 6, 5);
  w2.cd = 1;
  G.doWait(); G.doWait();
  check('防暴甲把行屍傷害壓到 1', S.hp === 99, S.hp);
  check('護甲掉耐久', S.armor.dur === 59, S.armor.dur);

  reset(); S = G.S; S.zombies.length = 0; S.x = 6; S.y = 5;
  S.weapon = { id:'bat_wood', dur:1 };
  G.spawnZombie('brute', 6, 4);
  G.tryMove(0,-1);
  check('耐久歸零後武器損壞', S.weapon === null);

  reset(); S = G.S; S.zombies.length = 0;
  S.x = 20; S.y = 12; S.hp = 100;
  const sp = G.spawnZombie('spitter', 20, 15);
  sp.alerted = true; sp.memory = 99;
  S.armor = { id:'riot_armor', dur:60 };
  G.doWait(); G.doWait(); G.doWait();
  check('噴吐者隔空攻擊（護甲只擋一半）', S.hp < 100, S.hp);
}

/* ---------------- 7. zombie pathing ---------------- */
section('殭屍尋路');
reset();
{
  let S = G.S;
  const sh = G.ZONES.find(z => z.id === 'safehouse');
  const [dx,dy] = sh.door;
  S.zombies.length = 0;
  S.x = 6; S.y = 5; S.hp = 100;
  const z = G.spawnZombie('walker', dx, dy+2);
  z.alerted = true; z.memory = 99; z.cd = 1;
  for (let i=0;i<14;i++){ G.doWait(); if (z.hp <= 0) break; }
  check('探索階段殭屍進不了安全屋', G.zoneAt(z.x, z.y)?.id !== 'safehouse', `${z.x},${z.y}`);
  check('殭屍被擋在門外、玩家不掉血', S.hp === 100 && z.y >= dy, `hp ${S.hp}, z ${z.x},${z.y}`);

  /* 堅守階段：破口打開，殭屍要能從缺口灌進來 */
  reset(); S = G.S; S.zombies.length = 0; S.x = 6; S.y = 5; S.hp = 100;
  S.radioBuilt = true;
  G.startHoldout();
  const breaches = [[3,10],[9,10],[4,1],[6,1],[8,1],[12,5]];
  check('堅守時六個破口都打開', breaches.every(([bx,by]) => G.MAP.terr[by*W+bx] === G.T.DOOR),
    breaches.map(([bx,by]) => G.MAP.terr[by*W+bx]).join(','));
  S.zombies.length = 0;
  S.holdoutStart = 999; // 不觸發勝利
  const z2 = G.spawnZombie('walker', 3, 11);
  z2.alerted = true; z2.memory = 99; z2.speed = 1; z2.cd = 1;
  for (let i=0;i<10;i++){
    G.doWait();
    S.zombies = S.zombies.filter(q => q === z2);
    if (G.zoneAt(z2.x, z2.y)?.id === 'safehouse') break;
  }
  check('堅守階段殭屍能從破口進屋', G.zoneAt(z2.x, z2.y)?.id === 'safehouse', `${z2.x},${z2.y}`);

  reset(); S = G.S; S.zombies.length = 0;
  const pol = G.ZONES.find(z3 => z3.id === 'police');
  const [px,py] = pol.door;
  G.MAP.terr[py*W+px] = G.T.DOOR;
  S.x = px; S.y = py + 4;
  const z3 = G.spawnZombie('walker', px, py - 3);
  z3.alerted = true; z3.memory = 99;
  for (let i=0;i<18;i++){ G.doWait(); if (S.hp < 100) break; }
  check('殭屍能穿過警局大門', S.hp < 100 || Math.abs(z3.x-S.x)+Math.abs(z3.y-S.y) <= 2, `hp ${S.hp}, z ${z3.x},${z3.y}`);
}

/* ---------------- 8. holdout balance ---------------- */
section('堅守階段（自動試玩）');
{
  const scenarios = [
    { name:'滿配：消防斧 + 防暴甲 + 7 急救包', weapon:'axe_fire', armor:'riot_armor', food:['medkit',7], minWins:7 },
    { name:'中配：砍刀 + 鐵甲 + 3 急救包', weapon:'machete', armor:'scrap_armor', food:['medkit',3], minWins:4 },
    { name:'低配：釘棒 + 無甲 + 1 繃帶', weapon:'bat_nail', armor:null, food:['bandage',1], minWins:0 },
  ];
  for (const sc of scenarios){
    let wins = 0, hpLeft = [], diedOn = [];
    const runs = 10;
    for (let run = 0; run < runs; run++){
      G.newGame(false);
      const S = G.S;
      S.zombies.length = 0;
      S.hp = 100;
      S.x = 2; S.y = 2; // 安全屋角落
      S.weapon = { id: sc.weapon, dur: G.ITEM[sc.weapon].dur };
      S.armor = sc.armor ? { id: sc.armor, dur: G.ITEM[sc.armor].dur } : null;
      S.bag.length = 0;
      G.addItem(sc.food[0], sc.food[1]);
      G.learn('bp_radio');
      G.addItem('antenna',1); G.addItem('circuit',1); G.addItem('battery',2); G.addItem('wire',3);
      G.craftRecipe('radio');
      G.startHoldout();

      for (let step = 0; step < 60 && S.phase === 'holdout'; step++){
        if (S.hp < 55){ const f = S.bag.find(b => G.ITEM[b.id].type === 'food'); if (f){ G.eatBest(); continue; } }
        let target = null;
        for (const z of S.zombies){
          if (Math.abs(z.x-S.x)+Math.abs(z.y-S.y) === 1 && (!target || z.hp < target.hp)) target = z;
        }
        if (target) G.tryMove(target.x - S.x, target.y - S.y);
        else if (S.hp < 78 && S.bag.some(b => G.ITEM[b.id].type === 'food')) G.eatBest();
        else G.doWait();
      }
      if (S.phase === 'won'){ wins++; hpLeft.push(S.hp); }
      else if (S.phase === 'dead') diedOn.push(S.turn - S.holdoutStart);
    }
    const avg = a => a.length ? (a.reduce((x,y)=>x+y,0)/a.length).toFixed(1) : '—';
    check(`${sc.name} · ${wins}/${runs} 勝`, wins >= sc.minWins, `${wins}/10`);
    console.log(`      勝 ${wins}/10 · 平均剩餘 HP ${avg(hpLeft)} · 陣亡回合 ${diedOn.join(',') || '—'}`);
  }
}

/* ---------------- 9. death / win plumbing ---------------- */
section('結算');
reset();
{
  const S = G.S;
  S.zombies.length = 0;
  S.hp = 1;
  S.armor = null;
  const z = G.spawnZombie('brute', S.x+1, S.y);
  z.cd = 1;
  G.doWait();
  check('生命歸零進入陣亡', S.phase === 'dead' && S.hp <= 0, `${S.phase} ${S.hp}`);
}

/* ---------------- 10. save / name ---------------- */
section('存檔與命名');
G.clearSave();
reset();
{
  G.beginRun('小明');
  check('開始遊戲套用名字', G.S.name === '小明');
  check('開始遊戲自動存檔', !!G.loadSave());

  const S = G.S;
  S.zombies.length = 0;
  S.turn = 9; S.hp = 57; S.x = 7; S.y = 6; S.dir = { x:1, y:0 };
  G.addItem('scrap', 4);
  G.addItem('bandage', 2);
  G.learn('bp_axe');
  S.weapon = { id:'machete', dur:33 };
  S.armor = { id:'scrap_armor', dur:21 };
  G.spawnZombie('walker', 20, 12);
  G.spawnZombie('brute', 40, 12);

  const crate = G.MAP.containers.find(c => c.loot && c.loot.some(e => e.id === 'wood'));
  standAt(crate);
  G.interact();
  check('搜刮後容器有狀態', crate.searched === true);

  /* 撬開警局大門 */
  S.x = 21; S.y = 22; S.dir = { x:0, y:1 };
  G.addItem('crowbar', 1);
  G.interact();
  check('撬開警局大門', G.MAP.terr[23*W + 21] === G.T.DOOR);

  S.turn = 9; S.hp = 57; S.x = 7; S.y = 6; S.dir = { x:1, y:0 };
  G.saveGame(true);
  const saved = G.loadSave();
  check('存檔有版本與名字', !!saved && saved.v === 1 && saved.name === '小明');
  check('存檔記錄容器', saved.containers.some(c => c.searched === true));
  check('存檔記錄地形變化', saved.changes.some(c => c.x === 21 && c.y === 23));

  G.newGame(false, '別人');
  G.continueGame(saved);
  const T = G.S;
  check('讀檔還原名字', T.name === '小明');
  check('讀檔還原回合與生命', T.turn === 9 && T.hp === 57, `${T.turn} ${T.hp}`);
  check('讀檔還原位置', T.x === 7 && T.y === 6, `${T.x},${T.y}`);
  check('讀檔還原裝備', !!T.weapon && T.weapon.id === 'machete' && T.weapon.dur === 33);
  check('讀檔還原護甲', !!T.armor && T.armor.id === 'scrap_armor' && T.armor.dur === 21);
  check('讀檔還原背包', G.countOf('scrap') >= 4 && G.countOf('bandage') >= 2);
  check('讀檔還原圖紙', !!T.bp.bp_axe);
  check('讀檔還原容器', G.propAt(crate.x, crate.y).searched === true);
  check('讀檔還原地形', G.MAP.terr[23*W + 21] === G.T.DOOR);
  check('讀檔還原殭屍', T.zombies.length === 2, T.zombies.length);
  check('讀檔後可繼續行動', (() => { const t0 = T.turn; G.doWait(); return T.turn === t0 + 1; })());

  /* 死亡會清掉存檔 */
  G.clearSave();
  reset();
  G.beginRun('阿明');
  G.S.hp = 1;
  G.S.armor = null;
  const z = G.spawnZombie('brute', G.S.x + 1, G.S.y);
  z.cd = 1;
  G.doWait();
  check('死亡後清除存檔', G.loadSave() === null && G.S.phase === 'dead');

  /* 名字清洗 */
  check('名字去掉標籤', G.sanitizeName('<b>阿鐵</b>') === '阿鐵', G.sanitizeName('<b>阿鐵</b>'));
  check('空名字有預設', G.sanitizeName('   ') === '阿鐵');
  check('名字最多 8 字', G.sanitizeName('一二三四五六七八九十').length === 8, G.sanitizeName('一二三四五六七八九十'));
}

/* ---------------- 11. safehouse stash ---------------- */
section('安全屋儲物櫃');
G.clearSave();
reset();
{
  const S = G.S;
  const stash = [...G.MAP.props.values()].find(p => p.kind === 'stash');
  check('安全屋有儲物櫃', !!stash);
  const spot = stash && G.DIRS.map(([dx,dy]) => [stash.x+dx, stash.y+dy])
    .find(([x,y]) => walkable(x,y));
  check('儲物櫃可接近', !!spot, spot ? spot.join(',') : '');
  check('初始容量 24', G.stashCap() === 24, G.stashCap());

  S.bag.length = 0; S.stash.length = 0;
  G.addItem('scrap', 3);
  G.bagToStash(0, false);
  check('點擊存入一個', G.countOf('scrap') === 2 && G.stashCount('scrap') === 1,
    `${G.countOf('scrap')}/${G.stashCount('scrap')}`);
  G.bagToStash(0, true);
  check('Shift 整組存入', G.countOf('scrap') === 0 && G.stashCount('scrap') === 3,
    `${G.countOf('scrap')}/${G.stashCount('scrap')}`);

  const si = S.stash.findIndex(x => x.id === 'scrap');
  G.stashToBag(si, false);
  check('取回一個', G.countOf('scrap') === 1 && G.stashCount('scrap') === 2,
    `${G.countOf('scrap')}/${G.stashCount('scrap')}`);

  S.bag.length = 0; S.stash.length = 0;
  S.bag.push({ id:'machete', n:1, dur:17 });
  G.bagToStash(0, false);
  check('裝備存入保留耐久', !!S.stash[0] && S.stash[0].id === 'machete' && S.stash[0].dur === 17,
    JSON.stringify(S.stash[0]));
  G.stashToBag(0, false);
  check('裝備取回保留耐久', !!S.bag[0] && S.bag[0].id === 'machete' && S.bag[0].dur === 17,
    JSON.stringify(S.bag[0]));

  /* 背包滿時不能取回（需要新格子的裝備） */
  S.bag.length = 0; S.stash.length = 0;
  for (const id of ['wood','scrap','cloth','tape','wire','bottle','battery','circuit','antenna']) G.addItem(id,1);
  G.addItem('can',1); G.addItem('bread',1); G.addItem('bar',1);
  check('背包已滿', S.bag.length === 12, S.bag.length);
  G.addToStash('machete', 1, 40);
  const beforeBag = JSON.stringify(S.bag);
  G.stashToBag(0, false);
  check('背包滿時取回被拒絕', JSON.stringify(S.bag) === beforeBag && S.stash.length === 1,
    S.stash.length);

  /* 櫃子滿時不能存入 */
  S.bag.length = 0; S.stash.length = 0;
  for (let i=0;i<24;i++) G.addToStash('machete', 1, 40);
  check('櫃子裝滿 24 格', S.stash.length === 24, S.stash.length);
  G.addItem('can', 1);
  G.bagToStash(0, false);
  check('櫃子滿時存入被拒絕', G.countOf('can') === 1 && S.stash.length === 24, S.stash.length);

  /* 發射器不能存 */
  S.bag.length = 0; S.stash.length = 0;
  G.addItem('radio', 1);
  G.bagToStash(0, false);
  check('發射器不能存入', G.countOf('radio') === 1 && S.stash.length === 0);

  /* 擴建 */
  S.bag.length = 0; S.stash.length = 0; S.stashLv = 1;
  G.addItem('wood', 4); G.addItem('scrap', 3); G.addItem('tape', 2);
  G.upgradeStash();
  check('擴建到 Lv2 = 36 格', S.stashLv === 2 && G.stashCap() === 36, `${S.stashLv}/${G.stashCap()}`);
  check('擴建扣掉材料', G.countOf('wood') === 0 && G.countOf('scrap') === 0 && G.countOf('tape') === 0);
  S.bag.length = 0;
  G.addItem('scrap', 6); G.addItem('wood', 4); G.addItem('tape', 3);
  G.upgradeStash();
  check('擴建到 Lv3 = 48 格', S.stashLv === 3 && G.stashCap() === 48, `${S.stashLv}/${G.stashCap()}`);
  G.upgradeStash();
  check('滿級後不能再擴建', S.stashLv === 3);

  /* 材料放在櫃子裡也能用來擴建 */
  S.bag.length = 0; S.stash.length = 0; S.stashLv = 1;
  G.addToStash('wood', 4); G.addToStash('scrap', 3); G.addToStash('tape', 2);
  G.upgradeStash();
  check('櫃子裡的材料也能擴建', S.stashLv === 2 && G.stashCount('wood') === 0 && G.stashCount('scrap') === 0);

  /* 存入全部材料 / 取出全部 */
  S.bag.length = 0; S.stash.length = 0;
  G.addItem('scrap', 2); G.addItem('wood', 1); G.addItem('can', 1);
  G.depositAllMaterials();
  check('存入全部材料只搬材料', G.countOf('scrap') === 0 && G.countOf('wood') === 0 &&
    G.countOf('can') === 1 && S.stash.length === 2, `${G.countOf('scrap')}/${G.countOf('wood')}/${G.countOf('can')}`);
  G.withdrawAll();
  check('取出全部', S.stash.length === 0 && G.countOf('scrap') === 2 && G.countOf('wood') === 1);

  /* 存檔往返 */
  S.bag.length = 0; S.stash.length = 0; S.stashLv = 2;
  G.addToStash('scrap', 5);
  G.addToStash('machete', 1, 22);
  G.saveGame(true);
  const d = G.loadSave();
  G.newGame(false, '别人');
  G.continueGame(d);
  check('讀檔還原儲物櫃', G.stashCount('scrap') === 5 && G.stashCap() === 36, `${G.stashCount('scrap')}/${G.stashCap()}`);
  const sm = G.S.stash.find(x => x.id === 'machete');
  check('讀檔還原櫃內裝備耐久', !!sm && sm.dur === 22, JSON.stringify(sm));

  /* 互動與提示 */
  if (stash) G.teleport(stash.x - 1, stash.y);
  check('站在旁邊偵測到儲物櫃', G.nearStash() === true);
  G.openStash();
  check('可以打開儲物櫃面板', !document.getElementById('modal').classList.contains('hidden'));
  G.closeModal();
}

/* ---------------- summary ---------------- */
console.log(`\n${pass} passed, ${fail} failed`);
if (fail){
  console.log('\nFAILURES:');
  for (const f of failures) console.log(' - ' + f);
  process.exit(1);
}
