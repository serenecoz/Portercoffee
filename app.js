// PORTER COFFEE — Firebase 버전
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  collection, doc, onSnapshot, getDoc, setDoc, updateDoc, deleteDoc, writeBatch,
  increment, arrayUnion, arrayRemove,
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';

// 충전 적립 기능 (사용 안 함). 다시 쓰려면 true로 바꾸세요.
const BONUS_ON = false;

/* ---------- utils ---------- */
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const won = n => (Math.round(n) || 0).toLocaleString('ko-KR');
const rid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const pad = n => String(n).padStart(2, '0');
const dayKey = d => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
const hm = ts => { const d = new Date(ts); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const mdhm = ts => { const d = new Date(ts); return `${d.getMonth()+1}/${d.getDate()} ${hm(ts)}`; };
const parseAmt = v => { if (typeof v === 'number') return Math.round(v); const s = String(v ?? '').replace(/[^\d\-]/g, ''); const n = parseInt(s, 10); return isNaN(n) ? 0 : n; };
const clone = o => JSON.parse(JSON.stringify(o));
const signed = n => (n >= 0 ? '+' : '−') + won(Math.abs(n));
const kindLabel = k => k === 'charge' ? '충전' : k === 'edit' ? '수정' : '사용';
const lsGet = k => { try { return localStorage.getItem(k); } catch (e) { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch (e) {} };

const CHO = ['ㄱ','ㄲ','ㄴ','ㄷ','ㄸ','ㄹ','ㅁ','ㅂ','ㅃ','ㅅ','ㅆ','ㅇ','ㅈ','ㅉ','ㅊ','ㅋ','ㅌ','ㅍ','ㅎ'];
const CHO_BASE = {'ㄲ':'ㄱ','ㄸ':'ㄷ','ㅃ':'ㅂ','ㅆ':'ㅅ','ㅉ':'ㅈ'};
const choOf = ch => { const c = ch.charCodeAt(0) - 0xAC00; return (c >= 0 && c < 11172) ? CHO[Math.floor(c / 588)] : ch; };
const isCho = ch => CHO.includes(ch);
function fuzzy(text, q) {
  const n = String(text || '').toLowerCase().replace(/\s+/g, '');
  if (!q) return true;
  if (n.includes(q)) return true;
  outer: for (let i = 0; i + q.length <= n.length; i++) {
    for (let j = 0; j < q.length; j++) {
      const a = n[i + j], b = q[j];
      if (a === b || (isCho(b) && choOf(a) === b)) continue;
      continue outer;
    }
    return true;
  }
  return false;
}
function firstGroup(name) {
  const ch = String(name || '').trim()[0] || '';
  if (/[a-z]/i.test(ch)) return 'A-Z';
  const c = choOf(ch);
  if (isCho(c)) return CHO_BASE[c] || c;
  return '#';
}

/* ---------- state ---------- */
const S = {
  db: null, auth: null, user: null,
  customers: new Map(), custLoaded: false, pendingWrites: false,
  menu: [], options: [], bonusRate: 10, menuLoaded: false, opts: new Set(),
  today: [], todayKey: dayKey(new Date()),
  sel: null, q: '', chip: '전체', tab: 'cust',
  viewDay: dayKey(new Date()), viewDayData: null,
  unsubs: [], unsubDay: null,
};
let inflight = 0;

/* ---------- status ---------- */
function setSync(kind, txt) { const el = $('#sync'); el.className = 'sync ' + kind; $('#syncTxt').textContent = txt; }
function refreshSync() {
  if (!S.db) return;
  if (!navigator.onLine) setSync('err', '오프라인 · 연결되면 저장');
  else if (inflight > 0 || S.pendingWrites) setSync('busy', '저장 중…');
  else setSync('ok', '저장됨');
}
window.addEventListener('online', refreshSync);
window.addEventListener('offline', refreshSync);
function banner(msg) { const b = $('#banner'); b.textContent = msg || ''; b.classList.toggle('show', !!msg); }
function writeErr(e) {
  console.error(e);
  const code = e && e.code || '';
  if (code.includes('permission-denied')) banner('이 계정에는 장부 저장 권한이 없어요. 관리자에게 문의해 주세요.');
  else if (code.includes('resource-exhausted')) banner('오늘 무료 사용량을 넘었어요. 내일 다시 저장됩니다.');
  else banner('저장하지 못했어요: ' + (e.message || code));
}
function commit(p) {
  inflight++; refreshSync();
  // 오프라인이면 서버 확인까지 기다리므로, 화면은 바로 진행하고 결과만 추적
  return p.then(() => { inflight--; refreshSync(); }, e => { inflight--; refreshSync(); writeErr(e); });
}

/* ---------- refs ---------- */
const custRef = id => doc(S.db, 'customers', id);
const dayRef = key => doc(S.db, 'days', key);
const menuRef = () => doc(S.db, 'config', 'menu');

/* ---------- transactions ---------- */
function applyTx(cid, delta, desc, kind, extra) {
  const c = S.customers.get(cid); if (!c) return null;
  const at = Date.now();
  const entry = { id: rid(), cid, name: c.name, kind, amount: delta, desc, after: (c.balance || 0) + delta, at, ...(extra || {}) };
  const b = writeBatch(S.db);
  b.update(custRef(cid), { balance: increment(delta), recent: arrayUnion(entry), updatedAt: at });
  b.set(dayRef(dayKey(new Date(at))), { entries: arrayUnion(entry) }, { merge: true });
  commit(b.commit());
  // 최근 기록이 너무 길어지면 정리 (최근 40건 유지)
  const rec = c.recent || [];
  if (rec.length >= 60) {
    const keep = [entry, ...rec].sort((a, b) => b.at - a.at).slice(0, 40);
    commit(updateDoc(custRef(cid), { recent: keep }));
  }
  return entry;
}
function deleteEntry(en) {
  const b = writeBatch(S.db);
  const c = S.customers.get(en.cid);
  if (c) b.update(custRef(en.cid), { balance: increment(-en.amount), recent: arrayRemove(en), updatedAt: Date.now() });
  b.set(dayRef(dayKey(new Date(en.at))), { entries: arrayRemove(en) }, { merge: true });
  commit(b.commit());
}
function createCustomer({ name, org, memo, balance }) {
  const id = doc(collection(S.db, 'customers')).id;
  const at = Date.now();
  const entry = balance ? { id: rid(), cid: id, name, kind: 'edit', amount: balance, desc: '첫 등록 잔액', after: balance, at } : null;
  const b = writeBatch(S.db);
  b.set(custRef(id), { name, org, memo, balance, recent: entry ? [entry] : [], createdAt: at, updatedAt: at });
  if (entry) b.set(dayRef(dayKey(new Date(at))), { entries: arrayUnion(entry) }, { merge: true });
  commit(b.commit());
  S.customers.set(id, { id, name, org, memo, balance, recent: entry ? [entry] : [] });
  return id;
}
const saveMenu = () => commit(setDoc(menuRef(), { items: clone(S.menu), options: clone(S.options), bonusRate: S.bonusRate }));

/* ---------- toast ---------- */
let toastTimer = null;
function toast(html) {
  $('#toastMsg').innerHTML = html;
  $('#toast').classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $('#toast').classList.remove('show'), 3500);
}
const txToast = e => toast(`<b>${esc(e.name)}</b> ${esc(e.desc)} ${signed(e.amount)} → 잔액 <b>${won(e.after)}원</b>`);
const delBtn = e => `<button class="del-entry" data-act="del-entry" data-eid="${esc(e.id)}" data-cid="${esc(e.cid)}" data-at="${e.at}" title="이 기록 삭제">삭제</button>`;
const activeOpts = () => S.options.filter(o => S.opts.has(o.id));
const optPrice = price => Math.max(0, price + activeOpts().reduce((s, o) => s + o.amount, 0));

/* ---------- render: list ---------- */
const CHIPS = ['전체','ㄱ','ㄴ','ㄷ','ㄹ','ㅁ','ㅂ','ㅅ','ㅇ','ㅈ','ㅊ','ㅋ','ㅌ','ㅍ','ㅎ','A-Z'];
function renderChips() { $('#chips').innerHTML = CHIPS.map(c => `<button data-chip="${c}" class="${S.chip === c ? 'on' : ''}">${c}</button>`).join(''); }
const sortedCustomers = () => [...S.customers.values()].sort((a, b) => a.name.localeCompare(b.name, 'ko'));
function filtered() {
  const q = S.q.toLowerCase().replace(/\s+/g, '');
  return sortedCustomers().filter(c => (S.chip === '전체' || firstGroup(c.name) === S.chip) && (fuzzy(c.name, q) || fuzzy(c.org, q)));
}
const balClass = b => b < 0 ? 'neg' : (b < 10000 ? 'low' : '');
function renderList() {
  const list = $('#list');
  if (!S.custLoaded) { list.innerHTML = `<div class="empty">불러오는 중…</div>`; $('#cnt').textContent = ''; return; }
  const rows = filtered();
  $('#cnt').textContent = S.q || S.chip !== '전체' ? `${rows.length}명 찾음 / 전체 ${S.customers.size}명` : `전체 ${S.customers.size}명`;
  if (!S.customers.size) {
    list.innerHTML = `<div class="empty"><b>아직 등록된 고객이 없어요</b><br>지금 쓰는 엑셀 장부를 불러오거나<br>고객을 한 명씩 추가해 보세요.<br><br>
      <button class="btn primary" data-act="goto-import">엑셀 불러오기</button> <button class="btn" data-act="add-cust">고객 추가</button></div>`;
    return;
  }
  if (!rows.length) { list.innerHTML = `<div class="empty">'${esc(S.q || S.chip)}'에 맞는 고객이 없어요.${S.q ? `<br><br><button class="btn" data-act="add-cust-q">+ '${esc(S.q)}' 새 고객으로 추가</button>` : ''}</div>`; return; }
  list.innerHTML = rows.map(c => `
    <button class="row ${S.sel === c.id ? 'sel' : ''}" data-cid="${esc(c.id)}">
      <div class="who"><div class="nm">${esc(c.name)}</div>${c.org ? `<div class="org">${esc(c.org)}</div>` : ''}</div>
      <div class="bal num ${balClass(c.balance)}">${won(c.balance)}원</div>
    </button>`).join('');
}

/* ---------- render: detail ---------- */
function menuByCat() {
  const groups = [], idx = {};
  for (const m of S.menu) {
    const k = (m.cat || '').trim() || '메뉴';
    if (!(k in idx)) { idx[k] = groups.length; groups.push({ cat: k, items: [] }); }
    groups[idx[k]].items.push(m);
  }
  return groups;
}
function renderDetail() {
  const pane = $('#detailPane');
  const c = S.sel && S.customers.get(S.sel);
  pane.classList.toggle('open', !!c);
  if (!c) {
    pane.innerHTML = `<div class="placeholder"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg><br>왼쪽에서 고객 이름을 검색하거나 눌러 주세요.<br><span style="font-size:13px">초성으로도 찾을 수 있어요 — 예: <b>ㄱㅁㅅ</b> → 김민수</span></div>`;
    return;
  }
  const menuHtml = !S.menuLoaded ? `<div class="empty">메뉴 불러오는 중…</div>` :
    !S.menu.length ? `<div class="card empty">등록된 메뉴가 없어요. <button class="linkname" data-act="tab" data-tab="menu">메뉴 관리</button>에서 추가해 주세요.</div>` :
    menuByCat().map(g => `<div class="cat">${esc(g.cat)}</div><div class="menu-grid">${g.items.map(m => {
      const p = optPrice(m.price);
      return `<button class="mbtn ${p !== m.price ? 'adj' : ''}" data-act="use" data-mid="${esc(m.id)}"><span class="mn">${esc(m.name)}</span><span class="mp num">${p !== m.price ? `<s>${won(m.price)}</s> ` : ''}${won(p)}원</span></button>`;
    }).join('')}</div>`).join('');
  const optHtml = S.options.length ? `<div class="opts">${S.options.map(o =>
      `<button class="opt ${S.opts.has(o.id) ? 'on' : ''} ${o.amount < 0 ? 'disc' : ''}" data-act="opt" data-oid="${esc(o.id)}">${S.opts.has(o.id) ? '✓ ' : ''}${esc(o.name)} <span class="num">${signed(o.amount)}</span></button>`).join('')}
      ${S.opts.size ? `<button class="opt clear" data-act="opt-clear">옵션 해제</button>` : ''}</div>` : '';
  const recent = [...(c.recent || [])].sort((a, b) => b.at - a.at).slice(0, 40);
  const histHtml = recent.length ? recent.map(e => `
    <div class="hrow"><span class="t num">${mdhm(e.at)}</span>
      <span class="d"><span class="tag ${e.kind}">${kindLabel(e.kind)}</span>${esc(e.desc)}</span>
      <span class="a num ${e.amount >= 0 ? 'plus' : 'minus'}">${signed(e.amount)}</span>
      <span class="af num">${won(e.after)}</span>${delBtn(e)}</div>`).join('')
    : `<div class="empty" style="padding:20px">아직 기록이 없어요.</div>`;
  const keepScroll = pane.scrollTop;
  pane.innerHTML = `
  <div class="detail">
    <button class="back" data-act="close-detail">‹ 고객 목록</button>
    <div class="card">
      <div class="head">
        <div class="who"><h2>${esc(c.name)}</h2>${c.org ? `<div class="org">${esc(c.org)}</div>` : ''}${c.memo ? `<div class="memo">${esc(c.memo)}</div>` : ''}</div>
        <div class="balbox"><div class="lbl">남은 금액</div><div class="amt num ${balClass(c.balance)}">${won(c.balance)}<small>원</small></div></div>
      </div>
      <div class="actions">
        <button class="btn ok" data-act="charge">＋ 충전</button>
        <button class="btn" data-act="custom-use">직접 금액 차감</button>
        <span style="flex:1"></span>
        <button class="btn ghost" data-act="edit-cust">정보 수정</button>
      </div>
    </div>
    <div class="sec-title"><h3>메뉴 누르면 바로 차감</h3><span>잘못 눌렀으면 최근 기록에서 '삭제'</span></div>
    ${optHtml}
    ${menuHtml}
    <div class="sec-title"><h3>최근 기록</h3><span>최근 40건</span></div>
    <div class="card hist">${histHtml}</div>
  </div>`;
  pane.scrollTop = keepScroll;
}

/* ---------- render: day ---------- */
function curDayEntries() { return S.viewDay === S.todayKey ? S.today : S.viewDayData; }
async function loadViewDay() {
  if (S.viewDay === S.todayKey || !S.db) { renderDay(); return; }
  S.viewDayData = null; renderDay();
  const want = S.viewDay;
  try {
    const snap = await getDoc(dayRef(want));
    if (want !== S.viewDay) return;
    S.viewDayData = snap.exists() ? clone(snap.data().entries || []) : [];
  } catch (e) { S.viewDayData = []; }
  renderDay();
}
function renderDay() {
  $('#dayPick').value = S.viewDay;
  const raw = curDayEntries();
  if (!raw) { $('#dayStats').innerHTML = ''; $('#dayList').innerHTML = `<div class="empty">불러오는 중…</div>`; return; }
  const es = [...raw].sort((a, b) => a.at - b.at);
  const uses = es.filter(e => e.kind === 'use');
  const used = uses.reduce((s, e) => s - e.amount, 0);
  const chg = es.filter(e => e.kind === 'charge');
  const paid = chg.reduce((s, e) => s + (e.pay ?? e.amount), 0);
  const bonus = chg.reduce((s, e) => s + (e.bonus || 0), 0);
  const people = new Set(uses.map(e => e.cid)).size;
  $('#dayStats').innerHTML = `
    <div class="card stat"><div class="l">사용 합계</div><div class="v num">${won(used)}원</div></div>
    <div class="card stat"><div class="l">충전 받은 돈</div><div class="v num plus">${won(paid)}원</div>${bonus ? `<div class="l num" style="margin-top:2px">+ 적립 ${won(bonus)}원</div>` : ''}</div>
    <div class="card stat"><div class="l">사용 고객 / 건수</div><div class="v num">${people}명 · ${uses.length}건</div></div>`;
  if (!es.length) { $('#dayList').innerHTML = `<div class="empty">이 날은 기록이 없어요.</div>`; return; }
  $('#dayList').innerHTML = `<div class="hist">` + es.reverse().map(e => `
    <div class="hrow"><span class="t num">${hm(e.at)}</span>
      <span class="d"><button class="linkname" data-act="open-cust" data-cid="${esc(e.cid)}">${esc(e.name)}</button>&nbsp;&nbsp;<span class="tag ${e.kind}">${kindLabel(e.kind)}</span>${esc(e.desc)}</span>
      <span class="a num ${e.amount >= 0 ? 'plus' : 'minus'}">${signed(e.amount)}</span>
      <span class="af num">${won(e.after)}</span>${delBtn(e)}</div>`).join('') + `</div>`;
}

/* ---------- render: menu admin ---------- */
function renderMenuAdmin() {
  const el = $('#menuRows');
  if (!S.menuLoaded) { el.innerHTML = `<div class="empty">불러오는 중…</div>`; return; }
  if (!S.menu.length) { el.innerHTML = `<div class="empty">메뉴가 없어요. '+ 메뉴 추가'를 눌러 주세요.</div>`; return; }
  const cats = [...new Set(S.menu.map(m => m.cat).filter(Boolean))];
  el.innerHTML = `<datalist id="catList">${cats.map(c => `<option value="${esc(c)}">`).join('')}</datalist>` + S.menu.map((m, i) => `
    <div class="mrow" data-mid="${esc(m.id)}">
      <input class="field" data-f="name" value="${esc(m.name)}" placeholder="메뉴 이름">
      <input class="field num" data-f="price" inputmode="numeric" value="${won(m.price)}" style="text-align:right">
      <input class="field" data-f="cat" value="${esc(m.cat || '')}" list="catList" placeholder="분류">
      <div class="ord">
        <button class="icon-btn" data-act="menu-up" title="위로" ${i === 0 ? 'disabled' : ''}>↑</button>
        <button class="icon-btn" data-act="menu-down" title="아래로" ${i === S.menu.length - 1 ? 'disabled' : ''}>↓</button>
        <button class="icon-btn del" data-act="menu-del" title="삭제">✕</button>
      </div>
    </div>`).join('');
}
function bonusExample() { $('#bonusEx').textContent = S.bonusRate > 0 ? `예: 50,000원 받으면 ${won(50000 + Math.round(50000 * S.bonusRate / 100))}원 충전` : '적립 안 함'; }
function renderOptAdmin() {
  const el = $('#optRows');
  if (document.activeElement?.id !== 'bonusRate') $('#bonusRate').value = S.bonusRate;
  bonusExample();
  if (!S.menuLoaded) { el.innerHTML = ''; return; }
  if (!S.options.length) { el.innerHTML = `<div class="empty" style="padding:18px">옵션이 없어요. '+ 옵션 추가'를 눌러 주세요.</div>`; return; }
  el.innerHTML = S.options.map(o => `
    <div class="mrow orow" data-oid="${esc(o.id)}">
      <input class="field" data-of="name" value="${esc(o.name)}" placeholder="옵션 이름">
      <select class="field" data-of="sign"><option value="1" ${o.amount >= 0 ? 'selected' : ''}>추가 (+)</option><option value="-1" ${o.amount < 0 ? 'selected' : ''}>할인 (−)</option></select>
      <input class="field num" data-of="amt" inputmode="numeric" value="${won(Math.abs(o.amount))}" style="text-align:right">
      <div class="ord"><button class="icon-btn del" data-act="opt-del" title="삭제">✕</button></div>
    </div>`).join('');
}
function renderAll() { renderList(); renderDetail(); if (S.tab === 'day') renderDay(); }

/* ---------- modal ---------- */
function openModal(html, onMount) {
  $('#modal').innerHTML = html; $('#scrim').classList.add('show');
  onMount && onMount($('#modal'));
  const f = $('#modal').querySelector('[autofocus]');
  f && setTimeout(() => { if (f.isConnected && !$('#modal').contains(document.activeElement)) { f.focus(); f.select && f.select(); } }, 30);
}
function closeModal() { $('#scrim').classList.remove('show'); $('#modal').innerHTML = ''; }
$('#scrim').addEventListener('mousedown', e => { if (e.target.id === 'scrim') closeModal(); });

function amountModal({ title, label, sign, quick, descDefault, cid, kind }) {
  const c = S.customers.get(cid);
  openModal(`
    <div class="mh">${esc(title)} · ${esc(c.name)}</div>
    <form class="mb" id="mform">
      <div class="fld"><label>${esc(label)}</label>
        <input class="field big-amt num" name="amt" inputmode="numeric" autofocus autocomplete="off" placeholder="0">
        <div class="quick">${quick.map(q => `<button type="button" data-q="${q}">+${q >= 10000 ? (q / 10000) + '만' : won(q)}</button>`).join('')}<button type="button" data-q="0">지우기</button></div>
      </div>
      ${kind === 'charge' && BONUS_ON && S.bonusRate > 0 ? `<label class="chk"><input type="checkbox" name="bonus" checked> 장부 적립 ${S.bonusRate}% 적용</label>` : ''}
      <div class="fld"><label>메모 (선택)</label><input class="field" name="desc" value="${esc(descDefault)}"></div>
      <div id="bonusLine"></div>
      <div class="preview-line"><span>처리 후 잔액</span><b class="num" id="after">${won(c.balance)}원</b></div>
      <div class="err" id="merr"></div>
    </form>
    <div class="mf"><button class="btn ghost" data-act="close-modal">취소</button><button class="btn primary" id="mok">${esc(title)}</button></div>`,
  m => {
    const amt = m.querySelector('[name=amt]');
    const bonusChk = m.querySelector('[name=bonus]');
    const bonusOf = v => (bonusChk && bonusChk.checked) ? Math.round(v * S.bonusRate / 100) : 0;
    const upd = () => {
      const v = parseAmt(amt.value); amt.value = v ? won(v) : '';
      const b = bonusOf(v);
      m.querySelector('#bonusLine').innerHTML = b ? `<div class="preview-line"><span>받은 금액 ${won(v)} + 적립 ${won(b)}</span><b class="num plus">${won(v + b)}원 충전</b></div>` : '';
      m.querySelector('#after').textContent = won(c.balance + sign * (v + b)) + '원';
    };
    amt.addEventListener('input', upd);
    bonusChk && bonusChk.addEventListener('change', upd);
    m.querySelectorAll('[data-q]').forEach(b => b.addEventListener('click', () => { const q = +b.dataset.q; amt.value = q ? won(parseAmt(amt.value) + q) : ''; upd(); amt.focus(); }));
    const submit = e => {
      e && e.preventDefault();
      const v = parseAmt(amt.value);
      if (v <= 0) { m.querySelector('#merr').textContent = '금액을 입력해 주세요.'; return; }
      let desc = m.querySelector('[name=desc]').value.trim() || descDefault;
      const b = bonusOf(v);
      closeModal();
      let en;
      if (kind === 'charge') {
        if (b) desc += ` ${won(v)} + 적립 ${won(b)}`;
        en = applyTx(cid, v + b, desc, kind, { pay: v, bonus: b });
      } else en = applyTx(cid, sign * v, desc, kind);
      en && txToast(en);
    };
    m.querySelector('#mform').addEventListener('submit', submit);
    m.querySelector('#mok').addEventListener('click', submit);
  });
}

function custModal(cid, presetName) {
  const c = cid ? S.customers.get(cid) : null;
  openModal(`
    <div class="mh">${c ? '고객 정보 수정' : '새 고객 추가'}</div>
    <form class="mb" id="mform">
      <div class="fld"><label>이름 *</label><input class="field" name="name" value="${esc(c ? c.name : (presetName || ''))}" autofocus autocomplete="off"></div>
      <div class="fld"><label>소속 (기관·부서, 선택)</label><input class="field" name="org" value="${esc(c?.org || '')}" autocomplete="off"></div>
      <div class="fld"><label>${c ? '잔액 직접 수정' : '현재 남은 금액 (기존 장부 잔액)'}</label><input class="field num" name="bal" inputmode="numeric" value="${c ? won(c.balance) : ''}" placeholder="0" style="text-align:right">
        <div class="hint">${c ? '바꾸면 차액이 "수정"으로 기록에 남아요. 음수(외상)는 앞에 -를 붙이세요.' : '적립 없이 그대로 들어가요. 지금 돈을 받고 새로 충전하는 거라면 추가한 뒤 \'충전\'을 눌러 주세요(적립 적용).'}</div></div>
      <div class="fld"><label>메모 (선택)</label><input class="field" name="memo" value="${esc(c?.memo || '')}" placeholder="예: 매달 1일 충전, 샷 추가 선호"></div>
      <div class="err" id="merr"></div>
    </form>
    <div class="mf">${c ? '<button class="btn danger ghost" id="mdel">삭제</button><span class="spacer"></span>' : ''}<button class="btn ghost" data-act="close-modal">취소</button><button class="btn primary" id="mok">${c ? '저장' : '추가'}</button></div>`,
  m => {
    const balIn = m.querySelector('[name=bal]');
    balIn.addEventListener('input', () => { const neg = balIn.value.trim().startsWith('-'); const v = Math.abs(parseAmt(balIn.value)); balIn.value = v ? (neg ? '-' : '') + won(v) : (neg ? '-' : ''); });
    const submit = e => {
      e && e.preventDefault();
      const name = m.querySelector('[name=name]').value.trim();
      const org = m.querySelector('[name=org]').value.trim();
      const memo = m.querySelector('[name=memo]').value.trim();
      const bal = parseAmt(balIn.value);
      if (!name) { m.querySelector('#merr').textContent = '이름을 입력해 주세요.'; return; }
      const dup = [...S.customers.values()].find(x => x.name === name && (x.org || '') === org && x.id !== cid);
      if (dup && !m.dataset.dupOk) { m.querySelector('#merr').textContent = `같은 이름${org ? '·소속' : ''}의 고객이 이미 있어요. 그래도 저장하려면 한 번 더 누르세요.`; m.dataset.dupOk = '1'; return; }
      closeModal();
      if (c) {
        if (c.name !== name || (c.org || '') !== org || (c.memo || '') !== memo) commit(updateDoc(custRef(cid), { name, org, memo, updatedAt: Date.now() }));
        if (bal !== c.balance) { const en = applyTx(cid, bal - c.balance, '잔액 직접 수정', 'edit'); en && txToast(en); }
        else toast('저장했어요');
      } else {
        const id = createCustomer({ name, org, memo, balance: bal });
        selectCust(id);
        toast(`<b>${esc(name)}</b> 고객을 추가했어요`);
      }
    };
    m.querySelector('#mform').addEventListener('submit', submit);
    m.querySelector('#mok').addEventListener('click', submit);
    const del = m.querySelector('#mdel');
    del && del.addEventListener('click', () => {
      if (!del.dataset.sure) { del.dataset.sure = '1'; del.textContent = `정말 삭제 (잔액 ${won(c.balance)}원)`; del.classList.remove('ghost'); return; }
      closeModal();
      commit(deleteDoc(custRef(cid)));
      S.customers.delete(cid); S.sel = null; renderAll();
      toast(`<b>${esc(c.name)}</b> 고객을 삭제했어요`);
    });
  });
}

/* ---------- navigation ---------- */
function selectCust(id) {
  if (S.sel !== id) S.opts.clear();
  S.sel = id;
  if (S.tab !== 'cust') setTab('cust');
  renderAll();
  $('#detailPane').scrollTop = 0;
}
function setTab(t) {
  S.tab = t;
  document.querySelectorAll('#nav button').forEach(b => b.classList.toggle('on', b.dataset.tab === t));
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('on', v.id === 'v-' + t));
  if (t === 'day') loadViewDay();
  if (t === 'menu') { renderMenuAdmin(); renderOptAdmin(); }
  if (t === 'cust') setTimeout(() => { if (matchMedia('(min-width:861px)').matches) $('#q').focus(); }, 0);
}

/* ---------- events ---------- */
$('#nav').addEventListener('click', e => { const b = e.target.closest('button[data-tab]'); b && setTab(b.dataset.tab); });
const qIn = $('#q');
const clearQ = () => { qIn.value = ''; S.q = ''; $('#sbox').classList.remove('has'); renderList(); };
qIn.addEventListener('input', () => { S.q = qIn.value; $('#sbox').classList.toggle('has', !!S.q); renderList(); });
qIn.addEventListener('keydown', e => {
  if (e.key === 'Enter') { const r = filtered(); if (r.length) selectCust(r[0].id); }
  if (e.key === 'Escape') clearQ();
});
$('#qclear').addEventListener('click', () => { clearQ(); qIn.focus(); });
$('#chips').addEventListener('click', e => { const b = e.target.closest('[data-chip]'); if (!b) return; S.chip = S.chip === b.dataset.chip ? '전체' : b.dataset.chip; renderChips(); renderList(); });
$('#list').addEventListener('click', e => { const r = e.target.closest('[data-cid]'); r && selectCust(r.dataset.cid); });

function confirmTap(b, label = '삭제?') {
  if (b.dataset.sure) return true;
  b.dataset.sure = '1'; const old = b.textContent; b.textContent = label; b.classList.add('sure');
  b.style.color = 'var(--bad)'; b.style.width = 'auto'; b.style.padding = '0 8px';
  setTimeout(() => { if (b.isConnected) { delete b.dataset.sure; b.textContent = old; b.classList.remove('sure'); b.removeAttribute('style'); } }, 3000);
  return false;
}

document.addEventListener('click', e => {
  const b = e.target.closest('[data-act]'); if (!b) return;
  const act = b.dataset.act;
  const c = S.sel && S.customers.get(S.sel);
  switch (act) {
    case 'use': {
      if (!c) return;
      const m = S.menu.find(x => x.id === b.dataset.mid); if (!m) return;
      const ao = activeOpts();
      const price = optPrice(m.price);
      const desc = m.name + (ao.length ? ` (${ao.map(o => o.name).join(', ')})` : '');
      const en = applyTx(c.id, -price, desc, 'use', ao.length ? { base: m.price, opts: ao.map(o => o.name) } : null);
      en && txToast(en);
      setTimeout(() => { const nb = document.querySelector(`.mbtn[data-mid="${CSS.escape(m.id)}"]`); nb && nb.classList.add('flash'); }, 0);
      break;
    }
    case 'opt': { const id = b.dataset.oid; S.opts.has(id) ? S.opts.delete(id) : S.opts.add(id); renderDetail(); break; }
    case 'opt-clear': S.opts.clear(); renderDetail(); break;
    case 'del-entry': {
      if (!b.dataset.sure) {
        b.dataset.sure = '1'; b.textContent = '정말 삭제'; b.classList.add('sure');
        setTimeout(() => { if (b.isConnected) { delete b.dataset.sure; b.textContent = '삭제'; b.classList.remove('sure'); } }, 3000);
        return;
      }
      const cid = b.dataset.cid, eid = b.dataset.eid;
      const cust = S.customers.get(cid);
      const en = (cust?.recent || []).find(x => x.id === eid) || (curDayEntries() || []).find(x => x.id === eid);
      if (!en) return;
      if (S.viewDayData) S.viewDayData = S.viewDayData.filter(x => x.id !== eid);
      deleteEntry(en);
      toast(`삭제했어요 · <b>${esc(en.name)}</b> ${esc(en.desc)} ${signed(-en.amount)}${cust ? ` → 잔액 <b>${won(cust.balance - en.amount)}원</b>` : ''}`);
      if (S.tab === 'day') renderDay();
      break;
    }
    case 'charge': c && amountModal({ title: '충전', label: '충전할 금액', sign: 1, quick: [10000, 30000, 50000, 100000], descDefault: '충전', cid: c.id, kind: 'charge' }); break;
    case 'custom-use': c && amountModal({ title: '차감', label: '차감할 금액', sign: -1, quick: [1000, 500, 5000], descDefault: '직접 차감', cid: c.id, kind: 'use' }); break;
    case 'edit-cust': c && custModal(c.id); break;
    case 'add-cust': custModal(null); break;
    case 'add-cust-q': custModal(null, S.q); break;
    case 'close-detail': S.sel = null; S.opts.clear(); renderAll(); break;
    case 'close-modal': closeModal(); break;
    case 'open-cust': selectCust(b.dataset.cid); break;
    case 'tab': setTab(b.dataset.tab); break;
    case 'goto-import': setTab('data'); break;
    case 'day-prev': case 'day-next': {
      const d = new Date(S.viewDay + 'T12:00:00'); d.setDate(d.getDate() + (act === 'day-prev' ? -1 : 1));
      S.viewDay = dayKey(d); loadViewDay(); break;
    }
    case 'day-today': S.viewDay = S.todayKey; loadViewDay(); break;
    case 'menu-add':
      S.menu.push({ id: rid(), name: '새 메뉴', price: 0, cat: S.menu[S.menu.length - 1]?.cat || '' });
      saveMenu(); renderMenuAdmin();
      setTimeout(() => { const rows = document.querySelectorAll('#menuRows .mrow'); const inp = rows[rows.length - 1]?.querySelector('[data-f=name]'); inp && (inp.focus(), inp.select()); }, 0);
      break;
    case 'menu-up': case 'menu-down': case 'menu-del': {
      const mid = b.closest('.mrow').dataset.mid; const i = S.menu.findIndex(x => x.id === mid); if (i < 0) return;
      if (act === 'menu-del') { if (!confirmTap(b)) return; S.menu.splice(i, 1); }
      else { const j = act === 'menu-up' ? i - 1 : i + 1; if (j < 0 || j >= S.menu.length) return; [S.menu[i], S.menu[j]] = [S.menu[j], S.menu[i]]; }
      saveMenu(); renderMenuAdmin(); renderDetail(); break;
    }
    case 'opt-add':
      S.options.push({ id: rid(), name: '새 옵션', amount: 500 });
      saveMenu(); renderOptAdmin(); renderDetail();
      setTimeout(() => { const rows = document.querySelectorAll('#optRows .orow'); const inp = rows[rows.length - 1]?.querySelector('[data-of=name]'); inp && (inp.focus(), inp.select()); }, 0);
      break;
    case 'opt-del': {
      if (!confirmTap(b)) return;
      const oid = b.closest('.orow').dataset.oid;
      S.options = S.options.filter(o => o.id !== oid); S.opts.delete(oid);
      saveMenu(); renderOptAdmin(); renderDetail(); break;
    }
    case 'import-pick': $('#importFile').click(); break;
    case 'export': doExport(); break;
    case 'logout': if (confirmTap(b, '정말 로그아웃')) signOut(S.auth); break;
    case 'install-help': installHelp(); break;
  }
});
$('#menuRows').addEventListener('change', e => {
  const inp = e.target.closest('[data-f]'); if (!inp) return;
  const m = S.menu.find(x => x.id === inp.closest('.mrow').dataset.mid); if (!m) return;
  const f = inp.dataset.f;
  if (f === 'price') { m.price = Math.max(0, parseAmt(inp.value)); inp.value = won(m.price); }
  else m[f] = inp.value.trim();
  saveMenu(); renderDetail();
});
$('#menuRows').addEventListener('input', e => { const inp = e.target; if (inp.dataset.f === 'price') { const v = parseAmt(inp.value); inp.value = v ? won(v) : ''; } });
$('#optRows').addEventListener('change', e => {
  const inp = e.target.closest('[data-of]'); if (!inp) return;
  const row = inp.closest('.orow'); const o = S.options.find(x => x.id === row.dataset.oid); if (!o) return;
  const amt = Math.abs(parseAmt(row.querySelector('[data-of=amt]').value));
  o.name = row.querySelector('[data-of=name]').value.trim() || '옵션';
  o.amount = +row.querySelector('[data-of=sign]').value * amt;
  row.querySelector('[data-of=amt]').value = won(amt);
  saveMenu(); renderDetail();
});
$('#optRows').addEventListener('input', e => { const inp = e.target; if (inp.dataset.of === 'amt') { const v = Math.abs(parseAmt(inp.value)); inp.value = v ? won(v) : ''; } });
$('#bonusRate').addEventListener('change', e => {
  const v = Math.min(100, Math.max(0, parseFloat(e.target.value) || 0));
  S.bonusRate = v; e.target.value = v; bonusExample(); saveMenu();
});
$('#dayPick').addEventListener('change', e => { if (e.target.value) { S.viewDay = e.target.value; loadViewDay(); } });
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && $('#scrim').classList.contains('show')) closeModal();
  if (S.tab === 'cust' && S.user && !$('#scrim').classList.contains('show') && !e.ctrlKey && !e.metaKey && !e.altKey &&
      e.key.length === 1 && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName)) qIn.focus();
});

/* ---------- import ---------- */
let importRows = null;
$('#importFile').addEventListener('change', async e => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  const area = $('#importArea');
  if (!window.XLSX) { area.innerHTML = `<p class="err">엑셀 읽기 도구를 불러오지 못했어요. 인터넷 연결을 확인해 주세요.</p>`; return; }
  try {
    const wb = XLSX.read(await f.arrayBuffer(), { type: 'array' });
    const raw = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '' });
    importRows = parseSheet(raw);
    renderImport();
  } catch (err) { area.innerHTML = `<p class="err">파일을 읽지 못했어요: ${esc(err.message || err)}</p>`; }
});
function parseSheet(raw) {
  const rx = { name: /이름|성함|성명|고객|name/i, bal: /잔액|금액|잔고|남은|balance/i, org: /소속|부서|기관|회사|팀/i, memo: /메모|비고|참고/i };
  let hi = -1, cols = {};
  for (let r = 0; r < Math.min(raw.length, 10); r++) {
    const row = raw[r].map(v => String(v).trim());
    const ni = row.findIndex(v => rx.name.test(v));
    if (ni >= 0) {
      hi = r; cols.name = ni;
      cols.bal = row.findIndex((v, i) => i !== ni && rx.bal.test(v));
      cols.org = row.findIndex((v, i) => i !== ni && rx.org.test(v));
      cols.memo = row.findIndex((v, i) => i !== ni && rx.memo.test(v));
      break;
    }
  }
  if (hi < 0) cols = { name: 0, bal: 1, org: -1, memo: -1 };
  const out = [];
  for (let r = hi + 1; r < raw.length; r++) {
    const row = raw[r];
    const name = String(row[cols.name] ?? '').trim();
    if (!name || /^(합계|총계|계)$/.test(name)) continue;
    out.push({
      name,
      balance: cols.bal >= 0 ? parseAmt(row[cols.bal]) : 0,
      org: cols.org >= 0 ? String(row[cols.org] ?? '').trim() : '',
      memo: cols.memo >= 0 ? String(row[cols.memo] ?? '').trim() : '',
    });
  }
  return out;
}
function renderImport() {
  const area = $('#importArea');
  if (!importRows || !importRows.length) { area.innerHTML = `<p class="err">가져올 고객을 찾지 못했어요. 첫 열에 이름, 다음 열에 금액이 있는지 확인해 주세요.</p>`; return; }
  const byName = new Map([...S.customers.values()].map(c => [c.name + '|' + (c.org || ''), c]));
  const dupCount = importRows.filter(r => byName.has(r.name + '|' + r.org)).length;
  const total = importRows.reduce((s, r) => s + r.balance, 0);
  area.innerHTML = `
    <div class="preview"><table><thead><tr><th>이름</th><th>소속</th><th style="text-align:right">잔액</th><th>메모</th><th></th></tr></thead><tbody>
    ${importRows.map(r => `<tr><td>${esc(r.name)}</td><td>${esc(r.org)}</td><td class="r num">${won(r.balance)}</td><td>${esc(r.memo)}</td><td style="color:var(--muted);font-size:12px">${byName.has(r.name + '|' + r.org) ? '이미 있음' : '새 고객'}</td></tr>`).join('')}
    </tbody></table></div>
    <p style="margin:0 0 10px"><b>${importRows.length}명</b> · 잔액 합계 <b class="num">${won(total)}원</b>${dupCount ? ` · 이미 있는 고객 ${dupCount}명` : ''}</p>
    ${dupCount ? `<div class="fld"><label>이미 있는 고객은</label><select class="field" id="dupMode" style="max-width:320px"><option value="overwrite">엑셀의 잔액으로 덮어쓰기</option><option value="skip">건너뛰기 (지금 앱의 잔액 유지)</option></select></div>` : ''}
    <div class="toolbar"><button class="btn primary" id="doImport">${importRows.length}명 가져오기</button><button class="btn ghost" id="cancelImport">취소</button><span class="hint" id="impMsg"></span></div>`;
  $('#cancelImport').onclick = () => { importRows = null; area.innerHTML = ''; };
  $('#doImport').onclick = async () => {
    const mode = $('#dupMode')?.value || 'overwrite';
    $('#doImport').disabled = true;
    let made = 0, upd = 0, skip = 0;
    const at = Date.now();
    let batch = writeBatch(S.db), ops = 0;
    const commits = [];
    const flush = () => { if (ops) { commits.push(commit(batch.commit())); batch = writeBatch(S.db); ops = 0; } };
    for (const r of importRows) {
      const ex = byName.get(r.name + '|' + r.org);
      if (ex) {
        if (mode === 'skip') { skip++; continue; }
        const diff = r.balance - ex.balance;
        const patch = { updatedAt: at };
        if (r.memo && !ex.memo) patch.memo = r.memo;
        if (diff) { patch.balance = increment(diff); patch.recent = arrayUnion({ id: rid(), cid: ex.id, name: ex.name, kind: 'edit', amount: diff, desc: '엑셀 불러오기', after: r.balance, at }); }
        batch.update(custRef(ex.id), patch); ops++; upd++;
      } else {
        const id = doc(collection(S.db, 'customers')).id;
        const entry = { id: rid(), cid: id, name: r.name, kind: 'edit', amount: r.balance, desc: '엑셀 불러오기', after: r.balance, at };
        batch.set(custRef(id), { name: r.name, org: r.org, memo: r.memo, balance: r.balance, recent: r.balance ? [entry] : [], createdAt: at, updatedAt: at });
        byName.set(r.name + '|' + r.org, { id, name: r.name, balance: r.balance });
        ops++; made++;
      }
      if (ops >= 400) flush();
    }
    flush();
    $('#impMsg').textContent = '저장 중…';
    await Promise.all(commits);
    importRows = null;
    area.innerHTML = `<p style="color:var(--ok);margin:12px 0 0">완료! 새 고객 ${made}명, 잔액 갱신 ${upd}명${skip ? `, 건너뜀 ${skip}명` : ''}.</p>`;
  };
}

/* ---------- export ---------- */
function doExport() {
  if (!window.XLSX) { toast('엑셀 도구를 불러오는 중이에요. 잠시 후 다시 눌러 주세요.'); return; }
  const wb = XLSX.utils.book_new();
  const custRows = [['이름', '소속', '잔액', '메모', '마지막 변경']].concat(sortedCustomers().map(c => [c.name, c.org || '', c.balance, c.memo || '', c.updatedAt ? new Date(c.updatedAt).toLocaleString('ko-KR') : '']));
  const ws1 = XLSX.utils.aoa_to_sheet(custRows); ws1['!cols'] = [{ wch: 12 }, { wch: 16 }, { wch: 12 }, { wch: 24 }, { wch: 22 }];
  XLSX.utils.book_append_sheet(wb, ws1, '고객 잔액');
  const es = [...(curDayEntries() || [])].sort((a, b) => a.at - b.at);
  const dayRows = [['시간', '이름', '구분', '내용', '금액', '받은 돈', '적립', '처리 후 잔액']].concat(es.map(e => [hm(e.at), e.name, kindLabel(e.kind), e.desc, e.amount, e.kind === 'charge' ? (e.pay ?? e.amount) : '', e.bonus || '', e.after]));
  const ws2 = XLSX.utils.aoa_to_sheet(dayRows); ws2['!cols'] = [{ wch: 8 }, { wch: 12 }, { wch: 6 }, { wch: 28 }, { wch: 10 }, { wch: 10 }, { wch: 8 }, { wch: 12 }];
  XLSX.utils.book_append_sheet(wb, ws2, ('내역 ' + S.viewDay).slice(0, 31));
  XLSX.writeFile(wb, `카페장부_${S.todayKey}.xlsx`);
}

/* ---------- install (PWA) ---------- */
let installEvt = null;
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); installEvt = e; $('#installBtn').hidden = false; });
window.addEventListener('appinstalled', () => { $('#installBtn').hidden = true; toast('앱으로 설치했어요. 홈 화면 아이콘으로 여세요.'); });
$('#installBtn').addEventListener('click', async () => { if (!installEvt) return installHelp(); installEvt.prompt(); await installEvt.userChoice; installEvt = null; $('#installBtn').hidden = true; });
function installHelp() {
  if (installEvt) { $('#installBtn').click(); return; }
  openModal(`<div class="mh">앱으로 설치하기</div><div class="mb" style="line-height:1.8;font-size:14.5px">
    <b>아이폰 · 아이패드 (Safari)</b><br>아래쪽 공유 버튼(□↑) → <b>홈 화면에 추가</b> → 추가<br><br>
    <b>안드로이드 (Chrome)</b><br>오른쪽 위 ⋮ → <b>앱 설치</b> 또는 <b>홈 화면에 추가</b><br><br>
    <b>PC (Chrome · Edge)</b><br>주소창 오른쪽의 설치 아이콘(⊕) 클릭</div>
    <div class="mf"><button class="btn primary" data-act="close-modal">확인</button></div>`);
}

/* ---------- auth gate ---------- */
function showLogin(errMsg) {
  $('#gate').hidden = false;
  $('#gateBody').innerHTML = `
    <p>카페 공용 계정으로 로그인해 주세요.<br>한 번 로그인하면 이 기기에서는 계속 유지돼요.</p>
    <form id="loginForm">
      <div class="fld"><label>이메일</label><input class="field" name="email" type="email" autocomplete="username" value="${esc(lsGet('jangbu-email') || '')}" required></div>
      <div class="fld"><label>비밀번호</label><input class="field" name="pw" type="password" autocomplete="current-password" required></div>
      <div class="err" id="loginErr">${esc(errMsg || '')}</div>
      <button class="btn primary" type="submit" style="margin-top:8px">로그인</button>
    </form>`;
  const f = $('#loginForm');
  setTimeout(() => (f.email.value ? f.pw : f.email).focus(), 30);
  f.addEventListener('submit', async e => {
    e.preventDefault();
    const btn = f.querySelector('button'); btn.disabled = true; btn.textContent = '로그인 중…';
    try {
      lsSet('jangbu-email', f.email.value.trim());
      await signInWithEmailAndPassword(S.auth, f.email.value.trim(), f.pw.value);
    } catch (err) {
      const c = err.code || '';
      $('#loginErr').textContent = c.includes('invalid') || c.includes('wrong') || c.includes('not-found') ? '이메일 또는 비밀번호가 맞지 않아요.'
        : c.includes('too-many') ? '시도가 너무 많아요. 잠시 후 다시 해 주세요.'
        : c.includes('network') ? '인터넷 연결을 확인해 주세요.' : '로그인하지 못했어요 (' + c + ')';
      btn.disabled = false; btn.textContent = '로그인';
    }
  });
}

function stopData() {
  S.unsubs.forEach(u => u()); S.unsubs = [];
  if (S.unsubDay) { S.unsubDay(); S.unsubDay = null; }
  S.customers.clear(); S.custLoaded = false; S.menuLoaded = false; S.today = []; S.sel = null;
}
function denied(err) {
  if ((err.code || '').includes('permission-denied')) {
    banner('');
    showLogin('이 계정은 장부에 접근할 권한이 없어요. 카페 공용 계정으로 로그인해 주세요.');
    signOut(S.auth);
    return true;
  }
  return false;
}
function subscribeToday() {
  if (S.unsubDay) S.unsubDay();
  const key = S.todayKey;
  S.unsubDay = onSnapshot(dayRef(key), snap => {
    S.today = snap.exists() ? clone(snap.data().entries || []) : [];
    if (S.tab === 'day') renderDay();
  }, err => { denied(err) || console.error(err); });
}
function startData() {
  setSync('busy', '불러오는 중…');
  const slow = setTimeout(() => { if (!S.custLoaded) banner('데이터를 아직 불러오지 못했어요. 인터넷 연결을 확인해 주세요.'); }, 10000);
  S.unsubs.push(onSnapshot(collection(S.db, 'customers'), { includeMetadataChanges: true }, snap => {
    const m = new Map();
    snap.forEach(d => {
      const v = clone(d.data()); v.id = d.id;
      v.balance = Number(v.balance) || 0; v.name = String(v.name || '(이름 없음)');
      m.set(d.id, v);
    });
    S.customers = m;
    S.pendingWrites = snap.metadata.hasPendingWrites;
    if (S.sel && !S.customers.has(S.sel)) S.sel = null;
    S.custLoaded = true;
    if (!snap.metadata.fromCache) { clearTimeout(slow); banner(''); }
    refreshSync();
    renderList(); renderDetail();
  }, err => { clearTimeout(slow); if (!denied(err)) { S.custLoaded = true; banner('고객 목록을 불러오지 못했어요: ' + err.message); renderAll(); } }));

  S.unsubs.push(onSnapshot(menuRef(), snap => {
    if (!snap.exists() && !snap.metadata.fromCache) {
      // 처음 한 번: 카페 기본 옵션과 적립률을 넣어 둠 (메뉴는 직접 추가)
      commit(setDoc(menuRef(), { items: [], bonusRate: 0, options: [
        { id: 'takeout', name: '테이크아웃', amount: -500 },
        { id: 'decaf', name: '디카페인', amount: 500 },
        { id: 'oat', name: '오트 밀크', amount: 500 },
      ] }));
      return;
    }
    const d = snap.exists() ? snap.data() : {};
    S.menu = clone(d.items || []).map(m => ({ ...m, price: parseAmt(m.price) }));
    S.options = clone(d.options || []).map(o => ({ ...o, amount: parseAmt(o.amount) }));
    S.bonusRate = typeof d.bonusRate === 'number' ? d.bonusRate : 10;
    for (const id of [...S.opts]) if (!S.options.some(o => o.id === id)) S.opts.delete(id);
    S.menuLoaded = true;
    renderDetail();
    if (S.tab === 'menu') {
      if (!document.activeElement?.closest?.('#menuRows')) renderMenuAdmin();
      if (!document.activeElement?.closest?.('#optRows')) renderOptAdmin();
    }
  }, err => { denied(err) || console.error(err); }));

  subscribeToday();
}
setInterval(() => {
  const k = dayKey(new Date());
  if (k !== S.todayKey) {
    const wasToday = S.viewDay === S.todayKey;
    S.todayKey = k; if (wasToday) S.viewDay = k;
    if (S.user) subscribeToday();
    if (S.tab === 'day') loadViewDay();
  }
}, 30000);

/* ---------- boot ---------- */
renderChips(); renderAll(); $('#dayPick').value = S.viewDay;
const cfg = window.FIREBASE_CONFIG;
if (!cfg || !cfg.apiKey) {
  $('#gateBody').innerHTML = `<p>아직 Firebase 설정이 들어가지 않았어요.<br><b>config.js</b> 파일에 Firebase 설정값을 넣은 뒤 다시 올려 주세요.</p>`;
} else {
  const app = initializeApp(cfg);
  S.auth = getAuth(app);
  try {
    S.db = initializeFirestore(app, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }), ignoreUndefinedProperties: true });
  } catch (e) {
    S.db = initializeFirestore(app, { ignoreUndefinedProperties: true });
  }
  onAuthStateChanged(S.auth, user => {
    S.user = user;
    if (user) {
      $('#gate').hidden = true;
      $('#whoami').textContent = `로그인: ${user.email}`;
      startData();
      setTimeout(() => qIn.focus(), 50);
    } else {
      stopData(); renderAll();
      showLogin();
    }
  });
}
