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
function RolePicker({ onPick }) {
  return (
    <div className="wrap" style={{ maxWidth: 480 }}>
      <h1>教學練習平台</h1>
      <p className="muted">請先選擇你的身份</p>
      <div className="row" style={{ marginTop: 16, alignItems: 'stretch' }}>
        <div className="card role-card" style={{ flex: 1, marginTop: 0 }} onClick={() => onPick('teacher')}>
          <div style={{ fontSize: 34 }}>🧑‍🏫</div>
          <h2 style={{ marginTop: 10 }}>我是老師</h2>
          <p className="muted">建立課程、出題、批改、點名</p>
        </div>
        <div className="card role-card" style={{ flex: 1, marginTop: 0 }} onClick={() => onPick('student')}>
          <div style={{ fontSize: 34 }}>🎓</div>
          <h2 style={{ marginTop: 10 }}>我是學生</h2>
          <p className="muted">加入課程、作答、看老師回饋</p>
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
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  const submit = async (e) => {
    e.preventDefault();
    setErr(''); setBusy(true);
    try {
      const path = mode === 'login' ? '/auth/login' : '/auth/register';
      const body = mode === 'login' ? { email: form.email, password: form.password } : { ...form, role };
      const { token, user } = await api(path, { method: 'POST', body });
      tokenStore.set(token);
      onLogin(user);
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };

  if (!role) return <RolePicker onPick={setRole} />;

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
    </div>
  );
}

// ========================================================================
// 教師端
// ========================================================================

function TeacherHome({ onEnterCourse, onEnterManage }) {
  const [classes, setClasses] = useState([]);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const load = useCallback(() => api('/classes').then(setClasses), []);
  useEffect(() => { load(); }, [load]);

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
const blankQuestion = () => ({ description: '', type: 'single', options: ['', ''], answerSingle: 0, answerMulti: [] });

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
      <select value={q.type} onChange={(e) => update({ type: e.target.value, options: ['', ''], answerSingle: 0, answerMulti: [] })}>
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
    </div>
  );
}

function QuizBuilder({ classId, onSaved }) {
  const [title, setTitle] = useState('');
  const [kind, setKind] = useState('normal');
  const [dueDate, setDueDate] = useState('');
  const [questions, setQuestions] = useState([blankQuestion()]);
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
          description: q.description,
          type: q.type,
          options: q.type === 'short' ? [] : q.options.map((s) => s.trim()).filter(Boolean),
          answerKey: q.type === 'short' ? '' : (q.type === 'single' ? q.answerSingle : q.answerMulti),
        })),
      };
      await api('/classes/' + classId + '/quizzes', { method: 'POST', body: payload });
      reset();
      onSaved();
      setToast('✅ 已儲存測驗！');
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
      <h1 style={{ marginTop: 0 }}>新增測驗</h1>
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
            key={i}
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
      <div style={{ marginTop: 16 }}>
        <button disabled={busy}>儲存測驗</button>
      </div>
    </form>
  );
}

function AnswerCell({ a }) {
  if (a.type === 'short') return <span>{a.content || '（空白）'}</span>;
  if (a.type === 'single') return <span>{a.options[a.content] ?? a.content}</span>;
  return <span>{(a.content || []).map((i) => a.options[i]).join('、') || '（未作答）'}</span>;
}

function CorrectAnswerHint({ a }) {
  if (a.type === 'short') return null;
  const text = a.type === 'single'
    ? a.options[a.answerKey]
    : (a.answerKey || []).map((i) => a.options[i]).join('、');
  return <div className="muted">正確答案：{text}</div>;
}

function TeacherQuizDetail({ quiz, onBack }) {
  const [subs, setSubs] = useState(null);
  const load = useCallback(() => api('/quizzes/' + quiz.id + '/submissions').then(setSubs), [quiz.id]);
  useEffect(() => { load(); }, [load]);

  return (
    <div>
      <button className="ghost" onClick={onBack}>← 返回課程</button>
      <h1>{quiz.title} <KindTag kind={quiz.kind} /></h1>
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

  const setGrade = (answerId, patch) => setGrades((g) => ({ ...g, [answerId]: { ...g[answerId], ...patch } }));

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

  return (
    <div className="card">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <strong>{sub.studentName}</strong>
        <span className={'tag ' + (sub.status === 'graded' ? 'ok' : 'wait')}>
          {sub.status === 'graded' ? '已批改完成' : '待批改'}
        </span>
      </div>
      <div className="muted">{sub.studentEmail} · 交卷 {sub.submittedAt}</div>

      {sub.answers.map((a) => (
        <div key={a.answerId} style={{ borderTop: '1px solid var(--border)', marginTop: 12, paddingTop: 12 }}>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <strong>第 {a.seq} 題 · {TYPE_LABEL[a.type]}</strong>
            {a.status === 'graded' && a.type !== 'short' && (
              <span className={'tag ' + (a.score === 100 ? 'ok' : '')}>{a.score} 分（自動批改）</span>
            )}
          </div>
          <p style={{ whiteSpace: 'pre-wrap', margin: '6px 0' }}>{a.description}</p>
          <CorrectAnswerHint a={a} />
          <p>學生作答：<AnswerCell a={a} /></p>
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
      <div style={{ marginTop: 12 }}>
        <button disabled={busy} onClick={saveAll}>儲存批改</button>
      </div>
    </div>
  );
}

function TeacherCourse({ cls, onBack }) {
  const [list, setList] = useState([]);
  const [selectedQuiz, setSelectedQuiz] = useState(null);
  const load = useCallback(() => api('/classes/' + cls.id + '/quizzes').then(setList), [cls.id]);
  useEffect(() => { load(); }, [load]);

  if (selectedQuiz) {
    return <div className="wrap"><TeacherQuizDetail quiz={selectedQuiz} onBack={() => { setSelectedQuiz(null); load(); }} /></div>;
  }

  return (
    <div className="wrap">
      <button className="ghost" onClick={onBack}>← 返回首頁</button>
      <h1>{cls.name}</h1>
      <QuizBuilder classId={cls.id} onSaved={load} />
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
          <div style={{ marginTop: 10 }}>
            <button className="ghost" onClick={() => setSelectedQuiz(z)}>查看作答 / 批改</button>
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

function TeacherApp() {
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
      onEnterCourse={(c) => { setCls(c); setView('course'); }}
      onEnterManage={(c) => { setCls(c); setView('manage'); }}
    />
  );
}

// ========================================================================
// 學生端
// ========================================================================

function StudentHome({ onEnterCourse }) {
  const [classes, setClasses] = useState([]);
  const [code, setCode] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => api('/classes').then(setClasses), []);
  useEffect(() => { load(); }, [load]);

  const join = async (e) => {
    e.preventDefault();
    if (!code.trim()) return;
    setErr(''); setBusy(true);
    try {
      await api('/classes/join', { method: 'POST', body: { code } });
      setCode('');
      load();
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };

  const leaveClass = async (c) => {
    const ok = window.confirm(
      `確定要退出課程「${c.name}」嗎？\n\n你在這門課裡的作答與點名紀錄會一併移除，之後要再參加需要重新輸入加入代碼。`
    );
    if (!ok) return;
    try {
      await api('/classes/' + c.id + '/leave', { method: 'DELETE' });
      load();
    } catch (e) { setErr(e.message); }
  };

  return (
    <div className="wrap">
      <form className="card" onSubmit={join}>
        <h2>加入課程</h2>
        <div className="row">
          <input style={{ flex: 1 }} placeholder="輸入老師給的 6 碼課程代碼" value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())} />
          <button disabled={busy}>加入</button>
        </div>
        {err && <div className="err">{err}</div>}
      </form>

      <h2 style={{ marginTop: 24 }}>我的課程</h2>
      {classes.length === 0 && <p className="muted">還沒有加入任何課程，請跟老師拿加入代碼。</p>}
      {classes.map((c) => (
        <div className="card" key={c.id}>
          <h2>{c.name}</h2>
          <div className="muted">{c.teacherName} 老師 · {c.quizCount} 份測驗</div>
          <div className="row" style={{ marginTop: 10 }}>
            <button onClick={() => onEnterCourse(c)}>進入課程</button>
            <button className="danger" onClick={() => leaveClass(c)}>退出課程</button>
          </div>
        </div>
      ))}
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

  if (!order) return <p className="muted">載入題目中…</p>;

  const setAnswer = (qid, content) => setAnswers((a) => ({ ...a, [qid]: content }));

  const submit = async () => {
    setErr('');
    for (const q of order) {
      const a = answers[q.id];
      if (q.type === 'short' ? !a || !String(a).trim() : (a === undefined || (Array.isArray(a) && a.length === 0))) {
        setErr('請完成所有題目再送出');
        return;
      }
    }
    setBusy(true);
    try {
      const payload = { answers: order.map((q) => ({ questionId: q.id, content: answers[q.id] })) };
      await api('/quizzes/' + quiz.id + '/submit', { method: 'POST', body: payload });
      onDone();
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };

  return (
    <div className="card">
      <h1 style={{ marginTop: 0 }}>{quiz.title} <KindTag kind={quiz.kind} /></h1>
      {order.map((q, i) => (
        <div key={q.id} style={{ borderTop: '1px solid var(--border)', marginTop: 14, paddingTop: 14 }}>
          <strong>第 {i + 1} 題</strong>
          <p style={{ whiteSpace: 'pre-wrap' }}>{q.description}</p>
          {q.type === 'single' && q.displayOptions.map(({ text, idx }) => (
            <div className="choice" key={idx}>
              <input type="radio" name={'q' + q.id} checked={answers[q.id] === idx} onChange={() => setAnswer(q.id, idx)} />
              <span>{text}</span>
            </div>
          ))}
          {q.type === 'multiple' && q.displayOptions.map(({ text, idx }) => {
            const cur = answers[q.id] || [];
            return (
              <div className="choice" key={idx}>
                <input type="checkbox" checked={cur.includes(idx)}
                  onChange={(e) => setAnswer(q.id, e.target.checked ? [...cur, idx] : cur.filter((x) => x !== idx))} />
                <span>{text}</span>
              </div>
            );
          })}
          {q.type === 'short' && (
            <textarea rows="3" value={answers[q.id] || ''} onChange={(e) => setAnswer(q.id, e.target.value)} placeholder="輸入你的答案" />
          )}
        </div>
      ))}
      {err && <div className="err">{err}</div>}
      <div style={{ marginTop: 16 }}>
        <button disabled={busy} onClick={submit}>送出作答</button>
      </div>
    </div>
  );
}

function QuizResult({ quizSummary }) {
  const [detail, setDetail] = useState(null);
  useEffect(() => { api('/quizzes/' + quizSummary.id + '/my-submission').then(setDetail); }, [quizSummary.id]);

  return (
    <div className="card">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h1 style={{ marginTop: 0 }}>{quizSummary.title} <KindTag kind={quizSummary.kind} /></h1>
        <span className={'tag ' + (quizSummary.myStatus === 'graded' ? 'ok' : 'wait')}>
          {quizSummary.myStatus === 'graded' ? (quizSummary.myScore + ' 分') : '部分待批改'}
        </span>
      </div>
      {!detail && <p className="muted">載入中…</p>}
      {detail && detail.answers.map((a) => (
        <div key={a.questionId} style={{ borderTop: '1px solid var(--border)', marginTop: 12, paddingTop: 12 }}>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <strong>第 {a.seq} 題</strong>
            <span className={'tag ' + (a.status === 'graded' ? 'ok' : 'wait')}>
              {a.status === 'graded' ? (a.score + ' 分') : '待批改'}
            </span>
          </div>
          <p style={{ whiteSpace: 'pre-wrap' }}>{a.description}</p>
          <p>你的作答：<AnswerCell a={a} /></p>
          {a.status === 'graded' && a.feedback && <p><strong>老師回饋：</strong>{a.feedback}</p>}
          {a.status === 'graded' && !a.feedback && <p className="muted">老師沒有留下文字回饋。</p>}
        </div>
      ))}
    </div>
  );
}

const KIND_FILTERS = [
  { value: 'all', label: '全部' },
  { value: 'normal', label: '一般' },
  { value: 'pretest', label: '前測' },
  { value: 'posttest', label: '後測' },
];

function StudentCourse({ cls, onBack }) {
  const [tab, setTab] = useState('todo');
  const [kindFilter, setKindFilter] = useState('all');
  const [list, setList] = useState([]);
  const [taking, setTaking] = useState(null);
  const [viewing, setViewing] = useState(null);
  const [flash, setFlash] = useState('');

  const load = useCallback(() => api('/classes/' + cls.id + '/quizzes').then(setList), [cls.id]);
  useEffect(() => { load(); }, [load]);

  const byKind = (z) => kindFilter === 'all' || z.kind === kindFilter;
  const todo = list.filter((z) => !z.myStatus && byKind(z));
  const done = list.filter((z) => z.myStatus && byKind(z));

  if (taking) {
    return (
      <div className="wrap">
        <button className="ghost" onClick={() => setTaking(null)}>← 返回課程</button>
        <QuizTaker quizSummary={taking} onDone={() => {
          setTaking(null);
          setFlash('已交卷！選擇題已自動批改，簡答題等待老師批改。');
          load();
          setTimeout(() => setFlash(''), 5000);
        }} />
      </div>
    );
  }

  if (viewing) {
    return (
      <div className="wrap">
        <button className="ghost" onClick={() => setViewing(null)}>← 返回課程</button>
        <QuizResult quizSummary={viewing} />
      </div>
    );
  }

  return (
    <div className="wrap">
      <button className="ghost" onClick={onBack}>← 返回首頁</button>
      <h1>{cls.name}</h1>
      <div className="tabs">
        <button className={tab === 'todo' ? 'active' : 'ghost'} onClick={() => setTab('todo')}>待完成 ({todo.length})</button>
        <button className={tab === 'done' ? 'active' : 'ghost'} onClick={() => setTab('done')}>已完成 ({done.length})</button>
      </div>

      <div className="row" style={{ marginTop: 12 }}>
        <span className="muted">類別：</span>
        {KIND_FILTERS.map((f) => (
          <span key={f.value} className={'chip ' + (kindFilter === f.value ? 'active' : '')}
            onClick={() => setKindFilter(f.value)}>{f.label}</span>
        ))}
      </div>

      {flash && (
        <div className="card" style={{ background: 'var(--ok-bg)', border: '1px solid var(--ok-border)', color: 'var(--ok-text)', fontWeight: 600 }}>
          {flash}
        </div>
      )}

      {tab === 'todo' && (
        todo.length === 0
          ? <p className="muted" style={{ marginTop: 14 }}>目前沒有待完成的測驗。</p>
          : todo.map((z) => (
            <div className="card" key={z.id}>
              <h2>{z.title} <KindTag kind={z.kind} /></h2>
              <div className="muted">{z.questionCount} 題{z.dueDate ? ' · 截止 ' + z.dueDate : ''}</div>
              <div style={{ marginTop: 10 }}><button onClick={() => setTaking(z)}>開始作答</button></div>
            </div>
          ))
      )}

      {tab === 'done' && (
        done.length === 0
          ? <p className="muted" style={{ marginTop: 14 }}>還沒有完成任何測驗。</p>
          : done.map((z) => (
            <div className="card" key={z.id}>
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <h2>{z.title} <KindTag kind={z.kind} /></h2>
                <span className={'tag ' + (z.myStatus === 'graded' ? 'ok' : 'wait')}>
                  {z.myStatus === 'graded' ? (z.myScore + ' 分') : '待批改'}
                </span>
              </div>
              <div className="muted">{z.questionCount} 題</div>
              <div style={{ marginTop: 10 }}><button className="ghost" onClick={() => setViewing(z)}>查看回饋</button></div>
            </div>
          ))
      )}
    </div>
  );
}

function StudentApp() {
  const [cls, setCls] = useState(null);
  if (cls) return <StudentCourse cls={cls} onBack={() => setCls(null)} />;
  return <StudentHome onEnterCourse={setCls} />;
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

  if (loading) return <div className="wrap">載入中…</div>;
  if (!user) return <AuthScreen onLogin={setUser} />;

  return (
    <>
      <header className="bar">
        <span className="brand">教學練習平台</span>
        <span className="who">
          {user.name}（{user.role === 'teacher' ? '教師' : '學生'}）
          <a href="#" onClick={(e) => { e.preventDefault(); logout(); }}>登出</a>
        </span>
      </header>
      {user.role === 'teacher' ? <TeacherApp /> : <StudentApp />}
    </>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
