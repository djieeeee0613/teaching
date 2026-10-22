const { useState, useEffect, useCallback, useMemo } = React;

// ---------- API ----------
// 用 sessionStorage（而非 localStorage）：每個分頁獨立登入狀態，
// 這樣同一瀏覽器開多分頁分別測試教師 / 學生身分時不會互相覆蓋 token。
const tokenStore = {
  get: () => sessionStorage.getItem('tp_token'),
  set: (t) => sessionStorage.setItem('tp_token', t),
  clear: () => sessionStorage.removeItem('tp_token'),
};

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch('/api' + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(tokenStore.get() ? { Authorization: 'Bearer ' + tokenStore.get() } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || '發生錯誤');
  return data;
}

const TYPE_LABEL = { single: '單選題', multiple: '多選題', short: '簡答題' };
const KIND_LABEL = { normal: '一般測驗', pretest: '前測', posttest: '後測' };
const KIND_TAG_CLASS = { normal: '', pretest: 'pre', posttest: 'post' };
const KindTag = ({ kind }) => (
  kind && kind !== 'normal'
    ? <span className={'tag ' + KIND_TAG_CLASS[kind]}>{KIND_LABEL[kind]}</span>
    : null
);
const ATTEND_LABEL = { present: '出席', absent: '缺席', late: '遲到' };
const todayStr = () => new Date().toISOString().slice(0, 10);

// Fisher-Yates 洗牌，回傳新陣列不動原本的
function shuffled(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ---------- Auth screen ----------
// 第一步先選身份（老師/學生），選完才進登入／註冊表單，表單裡就不用再選一次。
function DemoHint({ acc, pw }) {
  return (
    <div className="demo-mini" onClick={(e) => e.stopPropagation()}>
      <div>🎮 試玩帳號</div>
      <code>{acc.email}</code>
      <code>{pw}</code>
    </div>
  );
}

function RolePicker({ onPick, demo }) {
  return (
    <div className="wrap" style={{ maxWidth: 480 }}>
      <h1>教學練習平台</h1>
      <p className="muted">請先選擇你的身份</p>
      <div className="row" style={{ marginTop: 16, alignItems: 'stretch' }}>
        <div className="card role-card" style={{ flex: 1, marginTop: 0 }} onClick={() => onPick('teacher')}>
          <div style={{ fontSize: 34 }}>🧑‍🏫</div>
          <h2 style={{ marginTop: 10 }}>我是老師</h2>
          <p className="muted">建立課程、出題、批改、點名</p>
          {demo && demo.enabled && <DemoHint acc={demo.teacher} pw={demo.password} />}
        </div>
        <div className="card role-card" style={{ flex: 1, marginTop: 0 }} onClick={() => onPick('student')}>
          <div style={{ fontSize: 34 }}>🎓</div>
          <h2 style={{ marginTop: 10 }}>我是學生</h2>
          <p className="muted">加入課程、作答、看老師回饋</p>
          {demo && demo.enabled && <DemoHint acc={demo.student} pw={demo.password} />}
        </div>
      </div>
    </div>
  );
}

function AuthScreen({ onLogin }) {
  const [role, setRole] = useState(null); // null 代表還沒選，先顯示 RolePicker
  const [mode, setMode] = useState('login');
  const [form, setForm] = useState({ email: '', password: '', name: '' });
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [demo, setDemo] = useState(null); // 後端提供的公開試玩帳密（DEMO_ACCOUNTS=off 時是 enabled:false）
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  useEffect(() => { api('/demo').then(setDemo).catch(() => {}); }, []);
  const demoAcc = demo && demo.enabled && role ? demo[role] : null;
  const fillDemo = () => {
    setMode('login'); setErr('');
    setForm({ ...form, email: demoAcc.email, password: demo.password });
  };

  const submit = async (e) => {
    e.preventDefault();
    setErr(''); setBusy(true);
    try {
      const path = mode === 'login' ? '/auth/login' : '/auth/register';
      const body = mode === 'login' ? { email: form.email, password: form.password, role } : { ...form, role };
      const { token, user } = await api(path, { method: 'POST', body });
      tokenStore.set(token);
      onLogin(user);
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };

  if (!role) return <RolePicker onPick={setRole} demo={demo} />;

  return (
    <div className="wrap" style={{ maxWidth: 420 }}>
      <h1>教學練習平台</h1>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <span className={'tag ' + (role === 'teacher' ? 'pre' : 'post')}>
          {role === 'teacher' ? '🧑‍🏫 教師身份' : '🎓 學生身份'}
        </span>
        <button type="button" className="ghost" onClick={() => setRole(null)}>切換身份</button>
      </div>
      <div className="tabs">
        <button className={mode === 'login' ? 'active' : 'ghost'} onClick={() => setMode('login')}>登入</button>
        <button className={mode === 'register' ? 'active' : 'ghost'} onClick={() => setMode('register')}>註冊</button>
      </div>
      <form className="card" onSubmit={submit}>
        {mode === 'register' && (
          <label>姓名<input value={form.name} onChange={set('name')} required /></label>
        )}
        <label>Email<input type="email" value={form.email} onChange={set('email')} required /></label>
        <label>密碼<input type="password" value={form.password} onChange={set('password')} required /></label>
        {err && <div className="err">{err}</div>}
        <div style={{ marginTop: 16 }}>
          <button disabled={busy}>{mode === 'login' ? '登入' : '建立帳號'}</button>
        </div>
      </form>

      {demoAcc && (
        <div className="card demo-box">
          <div className="demo-title">🎮 不想註冊？用試玩帳號直接體驗</div>
          <div className="demo-row"><span>Email</span><code>{demoAcc.email}</code></div>
          <div className="demo-row"><span>密碼</span><code>{demo.password}</code></div>
          <button type="button" className="ghost" onClick={fillDemo}>一鍵填入並切換到登入</button>
          <p className="muted" style={{ margin: '8px 0 0' }}>
            這是所有人共用的示範帳號，裡面只有範例資料，請不要輸入個人資料。
          </p>
        </div>
      )}
    </div>
  );
}

// ========================================================================
// 首頁總覽：打招呼、日期、天氣、幾個重點數字 —— 兩端首頁共用
// ========================================================================

const WEEKDAY = ['週日', '週一', '週二', '週三', '週四', '週五', '週六'];
const friendlyDate = () => {
  const d = new Date();
  return `${d.getMonth() + 1}月${d.getDate()}日 ${WEEKDAY[d.getDay()]}`;
};

function weatherIcon(code) {
  if (code === 0) return '☀️';
  if ([1, 2, 3].includes(code)) return '⛅';
  if ([45, 48].includes(code)) return '🌫️';
  if ([51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82].includes(code)) return '🌧️';
  if ([71, 73, 75, 77, 85, 86].includes(code)) return '❄️';
  if ([95, 96, 99].includes(code)) return '⛈️';
  return '🌤️';
}

// 免金鑰的公開天氣 API；先試瀏覽器定位，拿不到就預設台北。
// 有些瀏覽器/環境對 geolocation 的權限請求會整個卡住、不呼叫 success 也不呼叫 error
// （навigator 自己的 timeout 選項在那種情況下不會生效），所以另外加一個獨立的保險計時器，
// 確保天氣小工具最慢 3 秒內一定會顯示東西，不會一直空著。
function useWeather() {
  const [weather, setWeather] = useState(null);
  useEffect(() => {
    let cancelled = false;
    let settled = false;
    const fetchWeather = (lat, lon) => {
      fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,weather_code`)
        .then((r) => r.json())
        .then((d) => { if (!cancelled) setWeather({ temp: Math.round(d.current.temperature_2m), code: d.current.weather_code }); })
        .catch(() => {});
    };
    // 定位成功、定位失敗、保險計時器三條路徑都走同一個 settle()，
    // 用單一的 settled 旗標避免像之前那樣「兩層各自判斷 done」互相卡住、fetchWeather 永遠叫不到的問題。
    const settle = (lat, lon) => {
      if (settled) return;
      settled = true;
      clearTimeout(safetyTimer);
      fetchWeather(lat, lon);
    };
    const safetyTimer = setTimeout(() => settle(25.033, 121.5654), 3000);
    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        (pos) => settle(pos.coords.latitude, pos.coords.longitude),
        () => settle(25.033, 121.5654),
        { timeout: 4000 }
      );
    } else {
      settle(25.033, 121.5654);
    }
    return () => { cancelled = true; clearTimeout(safetyTimer); };
  }, []);
  return weather;
}

// ========================================================================
// 共用的動畫小元件：數字跳動、進度環、進度條、星星、彩帶
// ========================================================================

// 數字從 0 跳到目標值（ease-out），整數就顯示整數，有小數就顯示一位小數
function CountUp({ value, duration = 900 }) {
  const target = Number(value) || 0;
  const [n, setN] = useState(0);
  useEffect(() => {
    if (target === 0) { setN(0); return; }
    let raf, start;
    const step = (t) => {
      if (start === undefined) start = t;
      const p = Math.min(1, (t - start) / duration);
      setN(target * (1 - Math.pow(1 - p, 3)));
      if (p < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, duration]);
  return <>{Number.isInteger(target) ? Math.round(n) : n.toFixed(1)}</>;
}

// 進度環：掛載後才把 pct 填進去，這樣環會「畫」出來
function Ring({ pct, size = 64, stroke = 7, color = '#fff', track = 'rgba(255,255,255,.3)', children }) {
  const [p, setP] = useState(0);
  useEffect(() => { const t = setTimeout(() => setP(pct), 120); return () => clearTimeout(t); }, [pct]);
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  return (
    <div className="ring" style={{ width: size, height: size }}>
      <svg width={size} height={size} style={{ transform: 'rotate(-90deg)' }}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={track} strokeWidth={stroke} />
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeWidth={stroke} strokeLinecap="round"
          strokeDasharray={c} strokeDashoffset={c * (1 - Math.min(100, p) / 100)}
          style={{ transition: 'stroke-dashoffset 1.1s cubic-bezier(.22,1,.36,1)' }} />
      </svg>
      <div className="ring-label">{children}</div>
    </div>
  );
}

function PBar({ pct }) {
  const [w, setW] = useState(0);
  useEffect(() => { const t = setTimeout(() => setW(pct), 120); return () => clearTimeout(t); }, [pct]);
  return <div className="pbar"><i style={{ width: w + '%' }} /></div>;
}

// 分數換星星：90 以上 3 顆、60 以上 2 顆、有分數 1 顆
const starsForScore = (s) => (s >= 90 ? 3 : s >= 60 ? 2 : s > 0 ? 1 : 0);

function Stars({ n, total = 3, size = 20 }) {
  return (
    <span className="stars" style={{ fontSize: size }}>
      {Array.from({ length: total }, (_, i) => (
        <span key={i} className={i < n ? '' : 'off'} style={{ '--i': i }}>⭐</span>
      ))}
    </span>
  );
}

const CONFETTI_COLORS = ['#ff5d8f', '#ffb648', '#3ed598', '#4facfe', '#a18cd1', '#ffd166'];
function Confetti() {
  const pieces = useMemo(() => Array.from({ length: 56 }, (_, i) => {
    const w = 6 + Math.random() * 8;
    return {
      left: Math.random() * 100, dx: (Math.random() - 0.5) * 260, rot: Math.round(Math.random() * 720 - 360) + 'deg',
      dur: 2.2 + Math.random() * 1.6, delay: Math.random() * 0.5, color: CONFETTI_COLORS[i % CONFETTI_COLORS.length], w,
    };
  }), []);
  return (
    <div className="confetti-wrap" aria-hidden="true">
      {pieces.map((p, i) => (
        <i key={i} style={{
          left: p.left + '%', width: p.w, height: p.w * 1.6, background: p.color,
          '--dx': p.dx + 'px', '--rot': p.rot, animationDuration: p.dur + 's', animationDelay: p.delay + 's',
        }} />
      ))}
    </div>
  );
}

// 每門課固定配一座「小島」的顏色跟圖示（用課程 id 取餘數，同一門課每次看到的都一樣）
const ISLANDS = [
  { emoji: '🏝️', bg: 'linear-gradient(135deg,#4facfe,#00c6fb)' },
  { emoji: '🌋', bg: 'linear-gradient(135deg,#ff9a56,#ff5d8f)' },
  { emoji: '🌳', bg: 'linear-gradient(135deg,#43e97b,#38c9a8)' },
  { emoji: '🏰', bg: 'linear-gradient(135deg,#a18cd1,#e589c9)' },
  { emoji: '🚀', bg: 'linear-gradient(135deg,#f6b73c,#ff8a5c)' },
];
const islandOf = (c) => ISLANDS[c.id % ISLANDS.length];

function Dashboard({ user, stats, mission, mascot }) {
  const weather = useWeather();
  return (
    <div className="card hero">
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'nowrap' }}>
        <div>
          <h1 style={{ color: '#fff', marginTop: 0 }}>
            嗨，{user.name}！<span className="wave">👋</span>
          </h1>
          <p style={{ opacity: .95, margin: 0 }}>{friendlyDate()}</p>
        </div>
        <div className="row" style={{ flexWrap: 'nowrap', gap: 14 }}>
          {weather && (
            <div style={{ fontSize: 24, fontWeight: 700, whiteSpace: 'nowrap' }}>
              {weatherIcon(weather.code)} {weather.temp}°C
            </div>
          )}
          {mascot && <span className="mascot big">🦊</span>}
        </div>
      </div>
      {mission && <div className="mission">{mission}</div>}
      {stats && (
        <div className="row" style={{ marginTop: 14 }}>
          {stats.map((s, i) => (
            <div key={i} className="stat-pill" style={{ animationDelay: (i * 90 + 200) + 'ms' }}>
              <div style={{ fontSize: 22, fontWeight: 800, lineHeight: 1.2 }}><CountUp value={s.value} /></div>
              <div style={{ fontSize: 12, opacity: .95 }}>{s.label}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ========================================================================
// 教師端
// ========================================================================

function TeacherHome({ user, onEnterCourse, onEnterManage }) {
  const [classes, setClasses] = useState([]);
  const [stats, setStats] = useState(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const load = useCallback(() => api('/classes').then(setClasses), []);
  useEffect(() => { load(); api('/dashboard').then(setStats); }, [load]);

  const createClass = async (e) => {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true); setErr('');
    try {
      await api('/classes', { method: 'POST', body: { name } });
      setName('');
      load();
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };

  const deleteClass = async (c) => {
    const ok = window.confirm(
      `確定要刪除課程「${c.name}」嗎？\n\n這會一併刪除底下所有測驗、題目、學生作答與點名紀錄，且無法復原。`
    );
    if (!ok) return;
    try {
      await api('/classes/' + c.id, { method: 'DELETE' });
      load();
    } catch (e) { setErr(e.message); }
  };

  return (
    <div className="wrap">
      <Dashboard user={user} stats={stats && [
        { label: '課程數', value: stats.classCount },
        { label: '學生數', value: stats.studentCount },
        { label: '測驗數', value: stats.quizCount },
        { label: '待批改', value: stats.pendingGradingCount },
      ]} />
      <form className="card" onSubmit={createClass}>
        <h2>開新課程 / 班級</h2>
        <div className="row">
          <input style={{ flex: 1 }} placeholder="例如：資料結構 101" value={name} onChange={(e) => setName(e.target.value)} />
          <button disabled={busy}>建立</button>
        </div>
        {err && <div className="err">{err}</div>}
      </form>

      <h2 style={{ marginTop: 24 }}>我的課程</h2>
      {classes.length === 0 && <p className="muted">還沒有建立課程，先在上面建立一個吧。</p>}
      {classes.map((c) => (
        <div className="card" key={c.id}>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <div>
              <h2>{c.name}</h2>
              <div className="muted">
                加入代碼 <strong style={{ letterSpacing: 2 }}>{c.joinCode}</strong>
                {' · '}{c.studentCount} 位學生 · {c.quizCount} 份測驗
              </div>
            </div>
          </div>
          <div className="row" style={{ marginTop: 10 }}>
            <button onClick={() => onEnterCourse(c)}>進入課程 / 出題</button>
            <button className="ghost" onClick={() => onEnterManage(c)}>班級管理</button>
            <button className="danger" onClick={() => deleteClass(c)}>刪除課程</button>
          </div>
        </div>
      ))}
    </div>
  );
}

// ---- 測驗編輯器：標題在最上面，底下第 1 題、第 2 題……全部編輯完一次儲存 ----
const blankQuestion = () => ({
  description: '', type: 'single', options: ['', ''],
  answerSingle: 0, answerMulti: [], answerText: '', explanation: '',
});

function QuestionEditor({ q, index, onChange, onRemove, removable }) {
  const isChoice = q.type !== 'short';
  const update = (patch) => onChange({ ...q, ...patch });

  return (
    <div className="card" style={{ background: 'var(--surface-2)' }}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h2>第 {index + 1} 題</h2>
        {removable && <button type="button" className="danger" onClick={onRemove}>刪除此題</button>}
      </div>
      <label>題目說明<textarea rows="2" value={q.description} onChange={(e) => update({ description: e.target.value })} /></label>
      <label>題型</label>
      <select value={q.type} onChange={(e) => update({
        type: e.target.value, options: ['', ''], answerSingle: 0, answerMulti: [], answerText: '',
      })}>
        <option value="single">單選題</option>
        <option value="multiple">多選題</option>
        <option value="short">簡答題</option>
      </select>

      {isChoice && (
        <>
          <label>選項（點左側圓圈/方框設定正解）</label>
          {q.options.map((opt, i) => (
            <div className="choice" key={i}>
              {q.type === 'single' ? (
                <input type="radio" checked={q.answerSingle === i} onChange={() => update({ answerSingle: i })} />
              ) : (
                <input type="checkbox" checked={q.answerMulti.includes(i)}
                  onChange={(e) => update({
                    answerMulti: e.target.checked ? [...q.answerMulti, i] : q.answerMulti.filter((x) => x !== i),
                  })} />
              )}
              <input value={opt} placeholder={'選項 ' + (i + 1)}
                onChange={(e) => update({ options: q.options.map((o, j) => (j === i ? e.target.value : o)) })} />
              {q.options.length > 2 && (
                <button type="button" className="ghost" onClick={() => update({
                  options: q.options.filter((_, j) => j !== i),
                  answerMulti: q.answerMulti.filter((x) => x !== i).map((x) => (x > i ? x - 1 : x)),
                  answerSingle: q.answerSingle >= q.options.length - 1 ? 0 : q.answerSingle,
                })}>刪</button>
              )}
            </div>
          ))}
          <div style={{ marginTop: 8 }}>
            <button type="button" className="ghost" onClick={() => update({ options: [...q.options, ''] })}>+ 新增選項</button>
          </div>
        </>
      )}

      {q.type === 'short' && (
        <>
          <label>標準答案關鍵字（選填）</label>
          <textarea rows="2" value={q.answerText} placeholder="用逗號分開，例如：光合作用,葉綠素,二氧化碳"
            onChange={(e) => update({ answerText: e.target.value })} />
          <p className="muted" style={{ marginTop: 4 }}>
            學生作答只要包含其中一個關鍵字，系統就會自動給 100 分；沒對到的話留給你人工批改，不會自動判 0 分。
          </p>
        </>
      )}
      <label>詳細解釋（選填，批改完會顯示給學生參考）</label>
      <textarea rows="2" value={q.explanation} placeholder="說明為什麼這樣答、補充概念等"
        onChange={(e) => update({ explanation: e.target.value })} />
    </div>
  );
}

// 把後端回傳的題目（含正解）轉成編輯器要用的本機狀態
function questionToEditorState(apiQ) {
  return {
    id: apiQ.id,
    description: apiQ.description,
    type: apiQ.type,
    options: apiQ.type === 'short' ? ['', ''] : (apiQ.options.length ? apiQ.options : ['', '']),
    answerSingle: apiQ.type === 'single' ? apiQ.answerKey : 0,
    answerMulti: apiQ.type === 'multiple' ? apiQ.answerKey : [],
    answerText: apiQ.type === 'short' ? (apiQ.answerKey || '') : '',
    explanation: apiQ.explanation || '',
  };
}

// existingQuiz 有帶值就是編輯既有測驗（PUT），沒帶就是新增（POST）。
// 編輯模式下就算學生已經作答完畢，題目說明／選項／正解都還能改，也能增刪題目；
// 刪掉的題目連同該題的學生作答會一併移除，其他題目不受影響。
function QuizBuilder({ classId, existingQuiz, onSaved, onCancelEdit }) {
  const isEdit = !!existingQuiz;
  const [title, setTitle] = useState(existingQuiz?.title || '');
  const [kind, setKind] = useState(existingQuiz?.kind || 'normal');
  const [dueDate, setDueDate] = useState(existingQuiz?.dueDate || '');
  const [questions, setQuestions] = useState(
    existingQuiz ? existingQuiz.questions.map(questionToEditorState) : [blankQuestion()]
  );
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState('');

  const updateQuestion = (i, next) => setQuestions((qs) => qs.map((q, j) => (j === i ? next : q)));
  const removeQuestion = (i) => setQuestions((qs) => qs.filter((_, j) => j !== i));
  const addQuestion = () => setQuestions((qs) => [...qs, blankQuestion()]);

  const reset = () => {
    setTitle(''); setKind('normal'); setDueDate(''); setQuestions([blankQuestion()]);
  };

  const save = async (e) => {
    e.preventDefault();
    setErr('');
    if (!title.trim()) { setErr('請輸入測驗標題'); return; }
    for (let i = 0; i < questions.length; i++) {
      const q = questions[i];
      if (!q.description.trim()) { setErr(`第 ${i + 1} 題請輸入題目說明`); return; }
      if (q.type !== 'short') {
        const opts = q.options.map((s) => s.trim()).filter(Boolean);
        if (opts.length < 2) { setErr(`第 ${i + 1} 題選擇題至少需要兩個選項`); return; }
        if (q.type === 'multiple' && q.answerMulti.length === 0) { setErr(`第 ${i + 1} 題請至少勾選一個正解`); return; }
      }
    }
    setBusy(true);
    try {
      const payload = {
        title, kind, dueDate: dueDate || null,
        questions: questions.map((q) => ({
          id: q.id,
          description: q.description,
          type: q.type,
          options: q.type === 'short' ? [] : q.options.map((s) => s.trim()).filter(Boolean),
          answerKey: q.type === 'short' ? q.answerText.trim() : (q.type === 'single' ? q.answerSingle : q.answerMulti),
          explanation: q.explanation.trim(),
        })),
      };
      if (isEdit) {
        await api('/quizzes/' + existingQuiz.id, { method: 'PUT', body: payload });
      } else {
        await api('/classes/' + classId + '/quizzes', { method: 'POST', body: payload });
        reset();
      }
      onSaved();
      setToast(isEdit ? '✅ 已更新測驗！' : '✅ 已儲存測驗！');
      setTimeout(() => setToast(''), 3000);
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };

  return (
    <form className="card" onSubmit={save}>
      {toast && (
        <div className="card" style={{ background: 'var(--ok-bg)', border: '1px solid var(--ok-border)', color: 'var(--ok-text)', marginTop: 0, fontWeight: 600 }}>
          {toast}
        </div>
      )}
      <h1 style={{ marginTop: 0 }}>{isEdit ? '編輯測驗' : '新增測驗'}</h1>
      {isEdit && <p className="muted">學生已經作答的部分不會被清空，只有你刪掉的題目才會連同該題作答一起移除。</p>}
      <label>測驗標題<input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="例如：第三週小考" required /></label>
      <div className="row">
        <div style={{ flex: 1 }}>
          <label>測驗類型</label>
          <select value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="normal">一般測驗</option>
            <option value="pretest">前測</option>
            <option value="posttest">後測</option>
          </select>
        </div>
        <div style={{ flex: 1 }}>
          <label>截止日（選填）</label>
          <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
        </div>
      </div>

      <div style={{ marginTop: 16 }}>
        {questions.map((q, i) => (
          <QuestionEditor
            key={q.id ?? 'new' + i}
            q={q}
            index={i}
            removable={questions.length > 1}
            onChange={(next) => updateQuestion(i, next)}
            onRemove={() => removeQuestion(i)}
          />
        ))}
      </div>

      <div className="row" style={{ marginTop: 12 }}>
        <button type="button" className="ghost" onClick={addQuestion}>+ 新增下一題</button>
      </div>

      {err && <div className="err">{err}</div>}
      <div className="row" style={{ marginTop: 16 }}>
        <button disabled={busy}>{isEdit ? '儲存修改' : '儲存測驗'}</button>
        {isEdit && <button type="button" className="ghost" onClick={onCancelEdit}>取消編輯</button>}
      </div>
    </form>
  );
}

function AnswerCell({ a }) {
  if (a.type === 'short') return <span>{a.content || '（空白）'}</span>;
  if (a.type === 'single') return <span>{a.options[a.content] ?? a.content}</span>;
  return <span>{(a.content || []).map((i) => a.options[i]).join('、') || '（未作答）'}</span>;
}

// 顯示正確答案／標準答案關鍵字，以及老師寫的詳細解釋（老師批改頁、學生查看回饋頁共用）
function CorrectAnswerHint({ a }) {
  if (a.type === 'short') {
    if (!a.answerKey && !a.explanation) return null;
    return (
      <>
        {a.answerKey && <div className="muted">標準答案關鍵字：{a.answerKey}</div>}
        {a.explanation && <div className="muted">詳細解釋：{a.explanation}</div>}
      </>
    );
  }
  const text = a.type === 'single'
    ? a.options[a.answerKey]
    : (a.answerKey || []).map((i) => a.options[i]).join('、');
  return (
    <>
      <div className="muted">正確答案：{text}</div>
      {a.explanation && <div className="muted">詳細解釋：{a.explanation}</div>}
    </>
  );
}

// 測驗個別總覽：交卷/批改進度、平均分，以及每題的詳細統計
// （多選題現在是按比例給分，不是非 0 即 100，所以改成看「平均得分」跟全對/部分對/全錯的比例）
function QuizOverview({ subs }) {
  const total = subs.length;
  const gradedSubs = subs.filter((s) => s.status === 'graded');
  const subAverages = subs.map((s) => {
    const scores = s.answers.map((a) => a.score).filter((x) => x != null);
    return scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null;
  }).filter((x) => x != null);
  const overallAvg = subAverages.length
    ? Math.round((subAverages.reduce((a, b) => a + b, 0) / subAverages.length) * 10) / 10
    : null;

  const questionStats = {};
  subs.forEach((s) => {
    s.answers.forEach((a) => {
      if (!questionStats[a.seq]) {
        questionStats[a.seq] = { type: a.type, description: a.description, graded: 0, full: 0, partial: 0, zero: 0, scoreSum: 0 };
      }
      const st = questionStats[a.seq];
      if (a.status === 'graded' && a.score != null) {
        st.graded += 1;
        st.scoreSum += a.score;
        if (a.score >= 100) st.full += 1;
        else if (a.score <= 0) st.zero += 1;
        else st.partial += 1;
      }
    });
  });
  const questionEntries = Object.entries(questionStats).sort((a, b) => Number(a[0]) - Number(b[0]));

  return (
    <div className="card">
      <h2>測驗總覽</h2>
      <div className="row" style={{ marginTop: 8 }}>
        <span className="tag">{total} 人交卷</span>
        <span className="tag ok">{gradedSubs.length} 已批改</span>
        <span className="tag wait">{total - gradedSubs.length} 待批改</span>
        {overallAvg != null && <span className="tag pre">平均 {overallAvg} 分</span>}
      </div>
      {questionEntries.length > 0 && (
        <div style={{ marginTop: 14 }}>
          {questionEntries.map(([seq, s]) => {
            const avg = s.graded > 0 ? Math.round((s.scoreSum / s.graded) * 10) / 10 : null;
            return (
              <div key={seq} style={{ borderTop: '1px solid var(--border)', marginTop: 10, paddingTop: 10 }}>
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <strong>第 {seq} 題 · {TYPE_LABEL[s.type]}</strong>
                  {avg != null && <span className="tag pre">平均 {avg} 分</span>}
                </div>
                {s.graded === 0 && <p className="muted" style={{ margin: '4px 0 0' }}>尚無已批改的作答</p>}
                {s.graded > 0 && (
                  <div className="row" style={{ marginTop: 6 }}>
                    <span className="tag ok">{Math.round((s.full / s.graded) * 100)}% 全對</span>
                    {s.partial > 0 && <span className="tag wait">{Math.round((s.partial / s.graded) * 100)}% 部分對</span>}
                    <span className="tag">{Math.round((s.zero / s.graded) * 100)}% 全錯</span>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function TeacherQuizDetail({ quiz, onBack }) {
  const [subs, setSubs] = useState(null);
  const load = useCallback(() => api('/quizzes/' + quiz.id + '/submissions').then(setSubs), [quiz.id]);
  useEffect(() => { load(); }, [load]);

  return (
    <div>
      <button className="ghost" onClick={onBack}>← 返回課程</button>
      <h1>{quiz.title} <KindTag kind={quiz.kind} /></h1>
      {subs && subs.length > 0 && <QuizOverview subs={subs} />}
      <h2 style={{ marginTop: 20 }}>學生作答 ({subs ? subs.length : '…'})</h2>
      {subs && subs.length === 0 && <p className="muted">還沒有人作答。</p>}
      {subs && subs.map((s) => <StudentSubmissionCard key={s.id} sub={s} onGraded={load} />)}
    </div>
  );
}

function StudentSubmissionCard({ sub, onGraded }) {
  const [grades, setGrades] = useState(() => Object.fromEntries(
    sub.answers.map((a) => [a.answerId, { score: a.score ?? '', feedback: a.feedback ?? '' }])
  ));
  const [busy, setBusy] = useState(false);
  const [collapsed, setCollapsed] = useState(false); // 收起這位學生，方便一次檢視很多人時捲動

  const setGrade = (answerId, patch) => setGrades((g) => ({ ...g, [answerId]: { ...g[answerId], ...patch } }));

  const scoredAnswers = sub.answers.map((a) => a.score).filter((x) => x != null);
  const avgScore = scoredAnswers.length
    ? Math.round((scoredAnswers.reduce((a, b) => a + b, 0) / scoredAnswers.length) * 10) / 10
    : null;

  const saveAll = async () => {
    setBusy(true);
    try {
      const answers = sub.answers
        .filter((a) => grades[a.answerId].score !== '')
        .map((a) => ({ answerId: a.answerId, score: Number(grades[a.answerId].score), feedback: grades[a.answerId].feedback }));
      await api('/quiz-submissions/' + sub.id + '/grade', { method: 'POST', body: { answers } });
      onGraded();
    } finally { setBusy(false); }
  };

  const resetSub = async () => {
    const ok = window.confirm(`要重置「${sub.studentName}」的這份作答嗎？\n\n他的作答內容、分數、老師回饋和 AI 回饋都會被刪除，無法復原。重置後他可以重新作答。`);
    if (!ok) return;
    setBusy(true);
    try {
      await api('/quiz-submissions/' + sub.id, { method: 'DELETE' });
      onGraded();
    } finally { setBusy(false); }
  };

  return (
    <div className="card">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <span className="row" style={{ cursor: 'pointer' }} onClick={() => setCollapsed((c) => !c)}>
          <span className="muted">{collapsed ? '▶' : '▼'}</span>
          <strong>{sub.studentName}</strong>
        </span>
        <span className="row">
          {avgScore != null && <span className="tag pre">平均 {avgScore} 分</span>}
          <span className={'tag ' + (sub.status === 'graded' ? 'ok' : 'wait')}>
            {sub.status === 'graded' ? '已批改完成' : '待批改'}
          </span>
          <button type="button" className="ghost" onClick={() => setCollapsed((c) => !c)}>
            {collapsed ? '展開' : '收合'}
          </button>
          <button type="button" className="ghost" disabled={busy} onClick={resetSub}>重置作答</button>
        </span>
      </div>
      <div className="muted">{sub.studentEmail} · 交卷 {sub.submittedAt}</div>

      {collapsed ? null : sub.answers.map((a) => (
        <div key={a.answerId} style={{ borderTop: '1px solid var(--border)', marginTop: 12, paddingTop: 12 }}>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <strong>第 {a.seq} 題 · {TYPE_LABEL[a.type]}</strong>
            {a.status === 'graded' && a.type !== 'short' && (
              <span className={'tag ' + (a.score >= 100 ? 'ok' : a.score > 0 ? 'wait' : '')}>{a.score} 分（自動批改）</span>
            )}
          </div>
          <p style={{ whiteSpace: 'pre-wrap', margin: '6px 0' }}>{a.description}</p>
          <CorrectAnswerHint a={a} />
          <p>學生作答：<AnswerCell a={a} /></p>
          <AiNote a={a} />
          <div className="row">
            <div style={{ width: 90 }}>
              <label style={{ marginTop: 0 }}>分數</label>
              <input type="number" min="0" max="100" value={grades[a.answerId].score}
                onChange={(e) => setGrade(a.answerId, { score: e.target.value })} />
            </div>
            <div style={{ flex: 1, minWidth: 200 }}>
              <label style={{ marginTop: 0 }}>回饋</label>
              <input value={grades[a.answerId].feedback} placeholder="給學生的評語"
                onChange={(e) => setGrade(a.answerId, { feedback: e.target.value })} />
            </div>
          </div>
        </div>
      ))}
      {!collapsed && (
        <div style={{ marginTop: 12 }}>
          <button disabled={busy} onClick={saveAll}>儲存批改</button>
        </div>
      )}
    </div>
  );
}

function TeacherCourse({ cls, onBack }) {
  const [list, setList] = useState([]);
  const [selectedQuiz, setSelectedQuiz] = useState(null);
  const [editingQuiz, setEditingQuiz] = useState(null); // 完整測驗資料（含正解），編輯用
  const load = useCallback(() => api('/classes/' + cls.id + '/quizzes').then(setList), [cls.id]);
  useEffect(() => { load(); }, [load]);

  if (selectedQuiz) {
    return <div className="wrap"><TeacherQuizDetail quiz={selectedQuiz} onBack={() => { setSelectedQuiz(null); load(); }} /></div>;
  }

  const startEdit = async (z) => setEditingQuiz(await api('/quizzes/' + z.id));

  return (
    <div className="wrap">
      <button className="ghost" onClick={onBack}>← 返回首頁</button>
      <h1>{cls.name}</h1>
      <QuizBuilder
        key={editingQuiz ? 'edit-' + editingQuiz.id : 'new'}
        classId={cls.id}
        existingQuiz={editingQuiz}
        onSaved={() => { setEditingQuiz(null); load(); }}
        onCancelEdit={() => setEditingQuiz(null)}
      />
      <h2 style={{ marginTop: 24 }}>此課程的測驗</h2>
      {list.length === 0 && <p className="muted">還沒有發布任何測驗。</p>}
      {list.map((z) => (
        <div className="card" key={z.id}>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <div>
              <h2>{z.title} <KindTag kind={z.kind} /></h2>
              <div className="muted">
                {z.questionCount} 題 · 建立於 {z.createdAt}
                {z.dueDate ? ' · 截止 ' + z.dueDate : ''}
              </div>
            </div>
            <span className="tag">{z.gradedCount}/{z.submissionCount} 已批改</span>
          </div>
          <div className="row" style={{ marginTop: 10 }}>
            <button className="ghost" onClick={() => setSelectedQuiz(z)}>查看作答 / 批改</button>
            <button className="ghost" onClick={() => startEdit(z)}>編輯題目</button>
          </div>
        </div>
      ))}
    </div>
  );
}

function TeacherManage({ cls, onBack }) {
  const [roster, setRoster] = useState([]);
  const [email, setEmail] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const [date, setDate] = useState(todayStr());
  const [attendance, setAttendance] = useState([]);
  const [savingAttendance, setSavingAttendance] = useState(false);
  const [saved, setSaved] = useState(false);

  const loadRoster = useCallback(() => api('/classes/' + cls.id + '/roster').then(setRoster), [cls.id]);
  const loadAttendance = useCallback(() => {
    api('/classes/' + cls.id + '/attendance?date=' + date).then((d) => setAttendance(d.roster));
  }, [cls.id, date]);

  useEffect(() => { loadRoster(); }, [loadRoster]);
  useEffect(() => { loadAttendance(); setSaved(false); }, [loadAttendance]);

  const addStudent = async (e) => {
    e.preventDefault();
    setErr(''); setBusy(true);
    try {
      await api('/classes/' + cls.id + '/roster', { method: 'POST', body: { email } });
      setEmail('');
      loadRoster();
      loadAttendance();
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };

  const removeStudent = async (studentId) => {
    await api('/classes/' + cls.id + '/roster/' + studentId, { method: 'DELETE' });
    loadRoster();
    loadAttendance();
  };

  const setStatus = (studentId, status) => {
    setAttendance((list) => list.map((r) => (r.studentId === studentId ? { ...r, status } : r)));
    setSaved(false);
  };

  const saveAttendance = async () => {
    setSavingAttendance(true);
    try {
      await api('/classes/' + cls.id + '/attendance', {
        method: 'POST',
        body: { date, records: attendance.filter((r) => r.status).map((r) => ({ studentId: r.studentId, status: r.status })) },
      });
      setSaved(true);
    } finally { setSavingAttendance(false); }
  };

  return (
    <div className="wrap">
      <button className="ghost" onClick={onBack}>← 返回首頁</button>
      <h1>{cls.name} · 班級管理</h1>
      <p className="muted">加入代碼：<strong style={{ letterSpacing: 2 }}>{cls.joinCode}</strong>（給學生自行加入，或用下方 email 手動加入）</p>

      <div className="card">
        <h2>點名 — {date}</h2>
        <label style={{ maxWidth: 200 }}>日期<input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
        {attendance.length === 0 && <p className="muted">班上還沒有學生。</p>}
        {attendance.map((r) => (
          <div className="row" key={r.studentId} style={{ justifyContent: 'space-between', marginTop: 10, borderTop: '1px solid var(--border)', paddingTop: 10 }}>
            <div>
              <strong>{r.name}</strong> <span className="muted">{r.email}</span>
            </div>
            <div className="row">
              {['present', 'late', 'absent'].map((st) => (
                <button key={st} className={r.status === st ? '' : 'ghost'} onClick={() => setStatus(r.studentId, st)}>
                  {ATTEND_LABEL[st]}
                </button>
              ))}
            </div>
          </div>
        ))}
        {attendance.length > 0 && (
          <div style={{ marginTop: 14 }}>
            <button disabled={savingAttendance} onClick={saveAttendance}>儲存點名</button>
            {saved && <span className="tag ok" style={{ marginLeft: 10 }}>已儲存</span>}
          </div>
        )}
      </div>

      <form className="card" onSubmit={addStudent}>
        <h2>編輯班級名單</h2>
        <div className="row">
          <input style={{ flex: 1 }} type="email" placeholder="學生 email（需已註冊為學生帳號）" value={email} onChange={(e) => setEmail(e.target.value)} required />
          <button disabled={busy}>加入名單</button>
        </div>
        {err && <div className="err">{err}</div>}
        <div style={{ marginTop: 14 }}>
          {roster.length === 0 && <p className="muted">還沒有學生加入這個課程。</p>}
          {roster.map((s) => (
            <div className="row" key={s.id} style={{ justifyContent: 'space-between', borderTop: '1px solid var(--border)', paddingTop: 8, marginTop: 8 }}>
              <div><strong>{s.name}</strong> <span className="muted">{s.email}</span></div>
              <button type="button" className="danger" onClick={() => removeStudent(s.id)}>移除</button>
            </div>
          ))}
        </div>
      </form>
    </div>
  );
}

function TeacherApp({ user }) {
  const [view, setView] = useState('home');
  const [cls, setCls] = useState(null);

  if (view === 'course' && cls) {
    return <TeacherCourse cls={cls} onBack={() => setView('home')} />;
  }
  if (view === 'manage' && cls) {
    return <TeacherManage cls={cls} onBack={() => setView('home')} />;
  }
  return (
    <TeacherHome
      user={user}
      onEnterCourse={(c) => { setCls(c); setView('course'); }}
      onEnterManage={(c) => { setCls(c); setView('manage'); }}
    />
  );
}

// ========================================================================
// 學生端：「學習冒險地圖」
// 課程 = 一座小島（有進度環）；測驗 = 地圖上的一個關卡（待挑戰會發光、通關會拿星星）。
// ========================================================================

function StudentHome({ user, onEnterCourse }) {
  const [classes, setClasses] = useState(null);
  const [stats, setStats] = useState(null);
  const [code, setCode] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => api('/classes').then(setClasses), []);
  useEffect(() => { load(); api('/dashboard').then(setStats); }, [load]);

  const join = async (e) => {
    e.preventDefault();
    if (!code.trim()) return;
    setErr(''); setBusy(true);
    try {
      await api('/classes/join', { method: 'POST', body: { code } });
      setCode('');
      load(); api('/dashboard').then(setStats);
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };

  const leaveClass = async (c) => {
    const ok = window.confirm(
      `確定要退出課程「${c.name}」嗎？\n\n你在這門課裡的作答與點名紀錄會一併移除，之後要再參加需要重新輸入加入代碼。`
    );
    if (!ok) return;
    try {
      await api('/classes/' + c.id + '/leave', { method: 'DELETE' });
      load(); api('/dashboard').then(setStats);
    } catch (e) { setErr(e.message); }
  };

  const mission = !stats ? null
    : stats.classCount === 0 ? '🧭 先輸入老師給的代碼，加入你的第一座小島吧！'
    : stats.pendingQuizCount > 0 ? `🚩 還有 ${stats.pendingQuizCount} 個關卡等你挑戰！`
    : '🎉 目前的關卡都通關了，太厲害了！';

  return (
    <div className="wrap">
      <Dashboard user={user} mascot mission={mission} stats={stats && [
        { label: '我的小島', value: stats.classCount },
        { label: '待挑戰關卡', value: stats.pendingQuizCount },
        { label: '已通關', value: stats.completedQuizCount },
      ]} />

      <h2 className="section-title">🗺️ 我的小島</h2>
      {classes && classes.length === 0 && (
        <div className="card empty">
          <span className="mascot big">🦊</span>
          <p>還沒有小島耶～跟老師拿 6 碼代碼，在下面輸入就能上島囉！</p>
        </div>
      )}
      <div className="islands">
        {(classes || []).map((c, i) => {
          const isl = islandOf(c);
          const pct = c.quizCount ? Math.round((c.completedCount / c.quizCount) * 100) : 0;
          return (
            <div key={c.id} className="island" style={{ '--island-bg': isl.bg, animationDelay: i * 90 + 'ms' }}
              onClick={() => onEnterCourse(c)}>
              <div className="island-top">
                <span className="emoji">{isl.emoji}</span>
                <Ring pct={pct} size={58} stroke={6}>{pct}%</Ring>
              </div>
              <h2>{c.name}</h2>
              <div className="meta">{c.teacherName} 老師</div>
              <div className="meta">已通關 {c.completedCount} / {c.quizCount} 關</div>
              <div className="island-actions">
                <span className="go">出發 →</span>
                <button type="button" className="island-leave" onClick={(e) => { e.stopPropagation(); leaveClass(c); }}>退出</button>
              </div>
            </div>
          );
        })}
      </div>

      <form className="card join" onSubmit={join}>
        <h2>🧭 探索新小島</h2>
        <div className="row">
          <input style={{ flex: 1 }} placeholder="輸入老師給的 6 碼課程代碼" value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())} />
          <button disabled={busy}>上島</button>
        </div>
        {err && <div className="err">{err}</div>}
      </form>
    </div>
  );
}

// 學生作答頁：進來時題目順序、每題選項順序都重新洗牌一次
function QuizTaker({ quizSummary, onDone }) {
  const [quiz, setQuiz] = useState(null);
  const [order, setOrder] = useState(null); // 洗牌後的題目陣列（含每題自己的選項顯示順序）
  const [answers, setAnswers] = useState({}); // questionId -> content（single: 原始索引；multiple: 原始索引陣列；short: 文字）
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api('/quizzes/' + quizSummary.id).then((z) => {
      setQuiz(z);
      const qOrder = shuffled(z.questions).map((q) => ({
        ...q,
        displayOptions: q.type === 'short' ? [] : shuffled(q.options.map((text, idx) => ({ text, idx }))),
      }));
      setOrder(qOrder);
    });
  }, [quizSummary.id]);

  if (!order) return <div className="loading"><span className="spinner" /> 載入題目中…</div>;

  const setAnswer = (qid, content) => setAnswers((a) => ({ ...a, [qid]: content }));
  const isAnswered = (q) => {
    const a = answers[q.id];
    return q.type === 'short' ? !!(a && String(a).trim()) : (a !== undefined && !(Array.isArray(a) && a.length === 0));
  };
  const answeredCount = order.filter(isAnswered).length;
  const pct = Math.round((answeredCount / order.length) * 100);

  const submit = async () => {
    setErr('');
    if (answeredCount < order.length) { setErr('還有題目沒作答喔，全部寫完再交卷！'); return; }
    setBusy(true);
    try {
      const payload = { answers: order.map((q) => ({ questionId: q.id, content: answers[q.id] })) };
      await api('/quizzes/' + quiz.id + '/submit', { method: 'POST', body: payload });
      onDone();
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };

  return (
    <>
      <div className="quiz-progress">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <strong>{quiz.title} <KindTag kind={quiz.kind} /></strong>
          <span className="muted">已作答 {answeredCount} / {order.length} 題</span>
        </div>
        <div className="pbar live"><i style={{ width: pct + '%' }} /></div>
      </div>

      {order.map((q, i) => (
        <div key={q.id} className={'card q-card' + (isAnswered(q) ? ' answered' : '')} style={{ animationDelay: i * 70 + 'ms' }}>
          <div className="row">
            <span className="q-badge">{i + 1}</span>
            <span className="tag">{TYPE_LABEL[q.type]}</span>
            {isAnswered(q) && <span className="q-check">✔</span>}
          </div>
          <p className="q-text">{q.description}</p>
          {q.type === 'single' && q.displayOptions.map(({ text, idx }, k) => (
            <label key={idx} className={'opt' + (answers[q.id] === idx ? ' selected' : '')}>
              <b className="opt-key">{String.fromCharCode(65 + k)}</b>
              <input type="radio" name={'q' + q.id} checked={answers[q.id] === idx} onChange={() => setAnswer(q.id, idx)} />
              <span>{text}</span>
            </label>
          ))}
          {q.type === 'multiple' && (
            <>
              <p className="muted" style={{ margin: '0 0 4px' }}>可以選很多個喔（選錯會扣分，小心！）</p>
              {q.displayOptions.map(({ text, idx }, k) => {
                const cur = answers[q.id] || [];
                return (
                  <label key={idx} className={'opt' + (cur.includes(idx) ? ' selected' : '')}>
                    <b className="opt-key">{String.fromCharCode(65 + k)}</b>
                    <input type="checkbox" checked={cur.includes(idx)}
                      onChange={(e) => setAnswer(q.id, e.target.checked ? [...cur, idx] : cur.filter((x) => x !== idx))} />
                    <span>{text}</span>
                  </label>
                );
              })}
            </>
          )}
          {q.type === 'short' && (
            <textarea rows="3" value={answers[q.id] || ''} onChange={(e) => setAnswer(q.id, e.target.value)} placeholder="把你的想法寫下來…" />
          )}
        </div>
      ))}
      {err && <div className="err" key={err}>{err}</div>}
      <div style={{ marginTop: 18 }}>
        <button className="big-btn" disabled={busy} onClick={submit}>{busy ? '交卷中…' : '🚀 交卷！'}</button>
      </div>
    </>
  );
}

// AI 小老師的回饋區塊（學生端、老師端共用）。老師端不傳 onRetry。
function AiNote({ a, onRetry }) {
  if (a.aiStatus === 'pending') {
    return <p className="ai-note"><span className="spinner" /> AI 小老師正在看你的答案…</p>;
  }
  if (a.aiStatus === 'done' && a.aiFeedback) {
    return (
      <p className="ai-note">
        <strong>AI 小老師：</strong>{a.aiFeedback}
        <span className="muted" style={{ display: 'block', fontSize: 12, marginTop: 4 }}>AI 的建議僅供參考，可能出錯，請以老師的說明為準。</span>
      </p>
    );
  }
  if (a.aiStatus === 'failed' || a.aiStatus === 'limit') {
    return (
      <p className="muted">
        {a.aiStatus === 'limit' ? '今天的 AI 回饋次數用完了，明天再來看看。' : 'AI 小老師這次沒有成功回覆。'}
        {onRetry && <> <button className="ghost" onClick={onRetry}>重新產生</button></>}
      </p>
    );
  }
  return null;
}

function QuizResult({ quizSummary, onRetake }) {
  const [detail, setDetail] = useState(null);
  useEffect(() => { api('/quizzes/' + quizSummary.id + '/my-submission').then(setDetail); }, [quizSummary.id]);

  // AI 回饋在背景產生：還有 pending 的題目就每 3 秒更新一次（最多約 90 秒）
  const hasPending = detail && detail.answers.some((a) => a.aiStatus === 'pending');
  useEffect(() => {
    if (!hasPending) return undefined;
    let tries = 0;
    const t = setInterval(() => {
      tries += 1;
      api('/quizzes/' + quizSummary.id + '/my-submission').then(setDetail);
      if (tries >= 30) clearInterval(t);
    }, 3000);
    return () => clearInterval(t);
  }, [hasPending, quizSummary.id]);
  const aiRetry = async () => {
    await api('/quizzes/' + quizSummary.id + '/ai-retry', { method: 'POST' });
    setDetail(await api('/quizzes/' + quizSummary.id + '/my-submission'));
  };

  const graded = quizSummary.myStatus === 'graded';
  const score = quizSummary.myScore;
  const gradedAnswers = detail ? detail.answers.filter((a) => a.status === 'graded') : [];
  const correctCount = gradedAnswers.filter((a) => a.type !== 'short' && a.score === 100).length;
  const objectiveGraded = gradedAnswers.filter((a) => a.type !== 'short').length;
  const msg = !graded ? '老師還在批改中，先來看看你的答案吧！'
    : score >= 90 ? '太棒了！你真是小天才 🌟'
    : score >= 60 ? '不錯喔，再接再厲 💪'
    : '沒關係，看看解釋，下次一定更好 🌱';
  const icon = (a) => (a.status !== 'graded' ? '⏳' : a.score >= 100 ? '✅' : a.score > 0 ? '🟡' : '❌');

  return (
    <>
      {graded && score >= 90 && <Confetti />}
      <div className="card hero score-hero">
        <div>
          <h1 style={{ color: '#fff', marginTop: 0 }}>{quizSummary.title} <KindTag kind={quizSummary.kind} /></h1>
          <p style={{ margin: '4px 0 10px', opacity: .95 }}>{msg}</p>
          {graded && <Stars n={starsForScore(score)} size={30} />}
          {detail && (
            <p style={{ margin: '10px 0 0', opacity: .95, fontSize: 13 }}>
              共 {detail.answers.length} 題，已批改 {gradedAnswers.length} 題
              {objectiveGraded > 0 && `，選擇題答對 ${correctCount}/${objectiveGraded} 題`}
            </p>
          )}
        </div>
        {graded
          ? <Ring pct={score} size={104} stroke={10}><span className="big-score"><CountUp value={score} /></span></Ring>
          : <span className="mascot big">⏳</span>}
      </div>

      {onRetake && (
        <div style={{ marginTop: 14 }}><button className="ghost" onClick={onRetake}>重新作答這份測驗</button></div>
      )}
      {!detail && <div className="loading"><span className="spinner" /> 載入中…</div>}
      {detail && detail.answers.map((a, i) => (
        <div key={a.questionId} className="card q-card" style={{ animationDelay: i * 70 + 'ms' }}>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <span className="row"><span className="q-icon">{icon(a)}</span><strong>第 {a.seq} 題</strong></span>
            <span className={'tag ' + (a.status === 'graded' ? (a.score >= 100 ? 'ok' : a.score > 0 ? 'wait' : '') : 'wait')}>
              {a.status === 'graded' ? (a.score + ' 分') : '待批改'}
            </span>
          </div>
          <p className="q-text">{a.description}</p>
          <CorrectAnswerHint a={a} />
          <p>你的作答：<AnswerCell a={a} /></p>
          {a.status === 'graded' && a.feedback && <p className="teacher-note"><strong>老師回饋：</strong>{a.feedback}</p>}
          {a.status === 'graded' && !a.feedback && <p className="muted">老師沒有留下文字回饋。</p>}
          <AiNote a={a} onRetry={aiRetry} />
        </div>
      ))}
    </>
  );
}

const KIND_FILTERS = [
  { value: 'all', label: '全部' },
  { value: 'normal', label: '一般' },
  { value: 'pretest', label: '前測' },
  { value: 'posttest', label: '後測' },
];
const STATUS_FILTERS = [
  { value: 'all', label: '🗺️ 全部' },
  { value: 'todo', label: '🚩 待挑戰' },
  { value: 'done', label: '⭐ 已通關' },
];

function StudentCourse({ cls, onBack }) {
  const [statusFilter, setStatusFilter] = useState('all');
  const [kindFilter, setKindFilter] = useState('all');
  const [list, setList] = useState(null);
  const [taking, setTaking] = useState(null);
  const [viewing, setViewing] = useState(null);
  const [flash, setFlash] = useState('');
  const [confetti, setConfetti] = useState(false);

  const load = useCallback(() => api('/classes/' + cls.id + '/quizzes').then(setList), [cls.id]);
  useEffect(() => { load(); }, [load]);

  const isl = islandOf(cls);

  // 關卡編號 = 老師出題的先後順序（固定，不會因為篩選而改變）
  const levels = useMemo(
    () => [...(list || [])].sort((a, b) => a.id - b.id).map((z, i) => ({ ...z, level: i + 1 })),
    [list]
  );
  const doneCount = levels.filter((z) => z.myStatus).length;
  const totalStars = levels.reduce((n, z) => n + (z.myStatus === 'graded' ? starsForScore(z.myScore) : 0), 0);
  const pct = levels.length ? Math.round((doneCount / levels.length) * 100) : 0;
  const nextId = (levels.find((z) => !z.myStatus) || {}).id;
  const shown = levels.filter((z) =>
    (statusFilter === 'all' || (statusFilter === 'todo' ? !z.myStatus : !!z.myStatus)) &&
    (kindFilter === 'all' || z.kind === kindFilter));

  // 重新作答：新的作答會整份覆蓋上一次（包含老師已給的分數與回饋），所以先讓學生確認
  const retake = (z) => {
    const ok = window.confirm(
      `要重新作答「${z.title}」嗎？

送出後會覆蓋你目前的成績，老師已經給的回饋也會被清掉。`
    );
    if (ok) { setViewing(null); setTaking(z); }
  };

  if (taking) {
    return (
      <div className="wrap">
        <button className="ghost" onClick={() => setTaking(null)}>← 回到地圖</button>
        <QuizTaker quizSummary={taking} onDone={() => {
          setTaking(null);
          setFlash('🎉 闖關完成！選擇題已自動批改，簡答題等老師批改。');
          setConfetti(true);
          load();
          setTimeout(() => setFlash(''), 5000);
          setTimeout(() => setConfetti(false), 4200);
        }} />
      </div>
    );
  }

  if (viewing) {
    return (
      <div className="wrap">
        <button className="ghost" onClick={() => setViewing(null)}>← 回到地圖</button>
        <QuizResult quizSummary={viewing} onRetake={() => retake(viewing)} />
      </div>
    );
  }

  return (
    <div className="wrap">
      {confetti && <Confetti />}
      <button className="ghost" onClick={onBack}>← 回到我的小島</button>

      <div className="card hero course-hero" style={{ '--island-bg': isl.bg }}>
        <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'nowrap' }}>
          <div>
            <h1 style={{ color: '#fff', marginTop: 0 }}>{cls.name}</h1>
            <p style={{ margin: 0, opacity: .95 }}>{cls.teacherName} 老師的小島</p>
          </div>
          <span className="emoji-xl">{isl.emoji}</span>
        </div>
        <div className="row" style={{ justifyContent: 'space-between', marginTop: 14 }}>
          <span>已通關 <b><CountUp value={doneCount} /></b> / {levels.length} 關</span>
          <span>⭐ <b><CountUp value={totalStars} /></b> 顆星</span>
        </div>
        <PBar pct={pct} />
      </div>

      {flash && <div className="card flash">{flash}</div>}

      <div className="filters">
        <div className="row">
          {STATUS_FILTERS.map((f) => (
            <span key={f.value} className={'chip ' + (statusFilter === f.value ? 'active' : '')}
              onClick={() => setStatusFilter(f.value)}>{f.label}</span>
          ))}
        </div>
        <div className="row">
          <span className="muted">類別：</span>
          {KIND_FILTERS.map((f) => (
            <span key={f.value} className={'chip ' + (kindFilter === f.value ? 'active' : '')}
              onClick={() => setKindFilter(f.value)}>{f.label}</span>
          ))}
        </div>
      </div>

      {list === null && <div className="loading"><span className="spinner" /> 地圖載入中…</div>}
      {list !== null && shown.length === 0 && (
        <div className="card empty">
          <span className="mascot big">🦊</span>
          <p>{levels.length === 0 ? '老師還沒有出關卡，先去別的小島逛逛吧！' : '這個條件下沒有關卡，換個篩選看看～'}</p>
        </div>
      )}

      <div className="quest" key={statusFilter + kindFilter}>
        {shown.map((z, i) => {
          const state = !z.myStatus ? 'todo' : z.myStatus === 'graded' ? 'done' : 'wait';
          return (
            <div className="quest-row" key={z.id} style={{ animationDelay: i * 80 + 'ms' }}>
              <div className={'node ' + state}>
                {state === 'todo' ? z.level : state === 'done' ? '✓' : '⏳'}
                {z.id === nextId && <span className="bubble">下一關</span>}
              </div>
              <div className="card quest-card lift">
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <h2>第 {z.level} 關 · {z.title} <KindTag kind={z.kind} /></h2>
                  {state === 'done' && <span className="tag ok">{z.myScore} 分</span>}
                  {state === 'wait' && <span className="tag wait">批改中</span>}
                </div>
                <div className="muted">{z.questionCount} 題{z.dueDate ? ' · 截止 ' + z.dueDate : ''}</div>
                <div className="row" style={{ marginTop: 10, justifyContent: 'space-between' }}>
                  {state === 'done' ? <Stars n={starsForScore(z.myScore)} /> : <span />}
                  {state === 'todo'
                    ? <button onClick={() => setTaking(z)}>🚩 開始闖關</button>
                    : (
                      <span className="row">
                        <button className="ghost" onClick={() => setViewing(z)}>{state === 'done' ? '看成績與解答' : '看我的答案'}</button>
                        <button className="ghost" onClick={() => retake(z)}>重新作答</button>
                      </span>
                    )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function StudentApp({ user }) {
  const [cls, setCls] = useState(null);
  if (cls) return <StudentCourse cls={cls} onBack={() => setCls(null)} />;
  return <StudentHome user={user} onEnterCourse={setCls} />;
}

// ---------- Root ----------
function App() {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!tokenStore.get()) { setLoading(false); return; }
    api('/me').then((d) => setUser(d.user)).catch(() => tokenStore.clear()).finally(() => setLoading(false));
  }, []);

  const logout = () => { tokenStore.clear(); setUser(null); };

  if (loading) return <div className="wrap"><div className="loading"><span className="spinner" /> 載入中…</div></div>;
  if (!user) return <AuthScreen onLogin={setUser} />;

  return (
    <>
      <header className="bar">
        <span className="brand"><span className="mascot-sm">🦊</span> 教學練習平台</span>
        <span className="who">
          {user.name}（{user.role === 'teacher' ? '教師' : '學生'}）
          <a href="#" onClick={(e) => { e.preventDefault(); logout(); }}>登出</a>
        </span>
      </header>
      {user.role === 'teacher' ? <TeacherApp user={user} /> : <StudentApp user={user} />}
    </>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
