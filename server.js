'use strict';

const path = require('node:path');
const express = require('express');
const { pool, init } = require('./db');
const { hashPassword, verifyPassword, signToken, verifyToken } = require('./auth');
const ai = require('./ai');
const { notify } = require('./notify');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;

// 包住每個 async route/middleware：讓裡面拋出的錯誤（例如資料庫查詢失敗）
// 統一交給下面的錯誤處理 middleware 回應 JSON，而不是變成沒有回應或 Express 預設的 HTML 錯誤頁。
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// 交易要用專屬連線時用這個，而不是直接 pool.connect()：
// pg 的 Client 物件如果連線中途被伺服器斷開（例如雲端 Postgres 的連線池把閒置連線收回），
// 會在這個 client 上單獨 emit 一個 'error' 事件；沒有人監聽的話 Node 預設行為是直接把整個
// process 炸掉。這裡統一補上監聽器，讓這種暫時性斷線只是記一筆 log，不會弄垮整個伺服器。
async function getClient() {
  const client = await pool.connect();
  // 連線池會重複借出同一個 client，監聽器只要掛一次；每次借出都掛的話會越疊越多（記憶體洩漏警告）
  if (!client.__errorHooked) {
    client.__errorHooked = true;
    client.on('error', (err) => {
      console.error('資料庫連線中途發生錯誤（已攔截，不會讓伺服器當掉）：', err.message);
    });
  }
  return client;
}

// ---------- helpers ----------
const publicUser = (u) => ({ id: u.id, email: u.email, name: u.name, role: u.role });

const auth = wrap(async (req, res, next) => {
  const header = req.headers.authorization || '';
  const payload = verifyToken(header.replace(/^Bearer\s+/i, ''));
  if (!payload) return res.status(401).json({ error: '未登入或登入已失效' });
  const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [payload.id]);
  if (!rows[0]) return res.status(401).json({ error: '帳號不存在' });
  req.user = rows[0];
  next();
});

function requireRole(role) {
  return (req, res, next) => {
    if (req.user.role !== role) return res.status(403).json({ error: '權限不足' });
    next();
  };
}

// s 可能已經是解析過的值（例如批改當下 req.body 傳進來的陣列/數字），
// 也可能是存在資料庫裡的 JSON 字串，兩種都要能正確處理。
const parse = (s, fallback) => {
  if (typeof s !== 'string') return s ?? fallback;
  try { return JSON.parse(s); } catch { return fallback; }
};

// 把簡答題「標準答案」拆成關鍵字：用逗號/頓號/分號/空白/換行分隔，去掉空白項目
function splitKeywords(refText) {
  return String(refText || '')
    .split(/[,，、;；\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// 替已交卷但缺少某些題目作答紀錄的學生補上空白作答（0 分）。後面要自己接 WHERE 與 ON CONFLICT。
const FILL_MISSING_ANSWERS = `
  INSERT INTO question_answers (quiz_submission_id, question_id, content, score, status)
  SELECT s.id, q.id, CASE WHEN q.type = 'multiple' THEN '[]' ELSE '""' END, 0, 'graded'
  FROM quiz_submissions s JOIN questions q ON q.quiz_id = s.quiz_id`;

// 自動批改：
// - 單選：全對 100，全錯 0
// - 多選：按比例給分——選對一個正解得 (100/正解數)，多選一個錯的就倒扣同樣比例，最低 0 分
//   例：4 個正解，選對 1 個 = 25 分；選對 2 個 = 50 分；選對 2 個又多選 1 個錯的 = 25 分
// - 簡答：這裡只做關鍵字比對——作答包含任一關鍵字給 100 分，否則 0 分（沒設關鍵字也是 0 分）。
//   有 AI 可用時，這個分數只是備用：實際分數由 AI 判讀意思後決定（見交卷流程與 generateOne）。
// 呼叫前請先用 normalizeAnswer() 把學生作答整理成固定格式。
function autoGrade(type, answerKey, content) {
  if (type === 'single') {
    // content 為 '' 代表沒作答；不能直接 Number('')（會變成 0，剛好等於第一個選項）
    return content !== '' && content === Number(parse(answerKey, -1)) ? 100 : 0;
  }
  if (type === 'multiple') {
    const key = toIndexList(parse(answerKey, []), Infinity);
    if (key.length === 0) return 0;
    const keySet = new Set(key);
    const correctSelected = content.filter((a) => keySet.has(a)).length;
    const wrongSelected = content.length - correctSelected;
    const per = 100 / key.length;
    const raw = (correctSelected - wrongSelected) * per;
    return Math.min(100, Math.max(0, Math.round(raw * 10) / 10));
  }
  if (type === 'short') {
    if (!content) return 0;
    const keywords = splitKeywords(parse(answerKey, '')).map(foldText).filter(Boolean);
    const studentAns = foldText(content);
    return keywords.some((k) => studentAns.includes(k)) ? 100 : 0;
  }
  return null;
}

// 比對簡答題關鍵字前先正規化：全形轉半形、不分大小寫、忽略所有空白
// （「ＤＮＡ」「dna」「葉 綠 素」都應該對得上「DNA」「葉綠素」）
function foldText(s) {
  return String(s ?? '').normalize('NFKC').toLowerCase().replace(/\s+/g, '');
}

// 把任意輸入整理成「不重複、合法的選項索引」陣列；不是陣列或索引超出範圍的都丟掉
function toIndexList(value, optionCount) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const v of value) {
    const n = typeof v === 'number' ? v : (typeof v === 'string' && /^\d+$/.test(v.trim()) ? Number(v) : NaN);
    if (Number.isInteger(n) && n >= 0 && n < optionCount && !out.includes(n)) out.push(n);
  }
  return out;
}

const MAX_SHORT_ANSWER = 2000;

// 學生送來的作答不能直接相信（可能是空的、型別錯、重複勾選、亂填索引），統一整理成：
//   單選：合法的選項索引（數字），沒作答或不合法 = ''
//   多選：不重複且合法的索引陣列
//   簡答：去頭尾空白的字串，最長 MAX_SHORT_ANSWER 字
function normalizeAnswer(q, content) {
  const optionCount = parse(q.options, []).length;
  if (q.type === 'single') {
    const one = toIndexList([content], optionCount);
    return one.length ? one[0] : '';
  }
  if (q.type === 'multiple') return toIndexList(content, optionCount);
  if (typeof content !== 'string' && typeof content !== 'number') return '';
  return String(content).trim().slice(0, MAX_SHORT_ANSWER);
}

async function generateJoinCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 避開易混淆字元 (0/O, 1/I)
  for (;;) {
    const code = Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
    const { rows } = await pool.query('SELECT 1 FROM classes WHERE join_code = $1', [code]);
    if (!rows.length) return code;
  }
}

function shapeClass(c) {
  return {
    id: c.id,
    name: c.name,
    joinCode: c.join_code,
    createdAt: c.created_at,
    teacherName: c.teacher_name ?? undefined,
    studentCount: c.student_count != null ? Number(c.student_count) : undefined,
    quizCount: c.quiz_count != null ? Number(c.quiz_count) : undefined,
    completedCount: c.completed_count != null ? Number(c.completed_count) : undefined,
    pendingCount: c.pending_count != null ? Number(c.pending_count) : undefined,
  };
}

// 確認該課程屬於這位教師；不是的話直接回應 403 並回傳 null
async function assertOwnsClass(req, res, classId) {
  const { rows } = await pool.query('SELECT * FROM classes WHERE id = $1', [classId]);
  const cls = rows[0];
  if (!cls || cls.teacher_id !== req.user.id) {
    res.status(403).json({ error: '權限不足' });
    return null;
  }
  return cls;
}

function shapeQuestion(q, { includeAnswer }) {
  const shaped = {
    id: q.id,
    seq: q.seq,
    description: q.description,
    type: q.type,
    options: parse(q.options, []),
  };
  if (includeAnswer) {
    shaped.answerKey = parse(q.answer_key, '');
    shaped.explanation = q.explanation || '';
  }
  return shaped;
}

function shapeQuiz(z) {
  return {
    id: z.id,
    classId: z.class_id,
    title: z.title,
    kind: z.kind || 'normal',
    dueDate: z.due_date,
    createdAt: z.created_at,
    questionCount: z.question_count != null ? Number(z.question_count) : undefined,
    submissionCount: z.submission_count != null ? Number(z.submission_count) : undefined,
    gradedCount: z.graded_count != null ? Number(z.graded_count) : undefined,
    myStatus: z.my_status ?? null,
    myScore: z.my_score ?? null,
  };
}

// ---------- auth routes ----------
app.post('/api/auth/register', wrap(async (req, res) => {
  const { email, password, name, role } = req.body || {};
  if (!email || !password || !name || !['teacher', 'student'].includes(role)) {
    return res.status(400).json({ error: '請填寫 email、密碼、姓名，並選擇身分' });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email))) {
    return res.status(400).json({ error: '請輸入正確的 email 格式（系統會寄成績通知到這個信箱）' });
  }
  if (String(password).length < 6) {
    return res.status(400).json({ error: '密碼至少 6 碼' });
  }
  const exists = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
  if (exists.rows.length) return res.status(409).json({ error: '此 email 已註冊' });

  const { rows } = await pool.query(
    'INSERT INTO users (email, password_hash, name, role) VALUES ($1, $2, $3, $4) RETURNING *',
    [email, hashPassword(password), name, role]
  );
  const user = rows[0];
  res.json({ token: signToken({ id: user.id }), user: publicUser(user) });
}));

app.post('/api/auth/login', wrap(async (req, res) => {
  const { email, password, role } = req.body || {};
  const { rows } = await pool.query('SELECT * FROM users WHERE email = $1', [email || '']);
  const user = rows[0];
  if (!user || !verifyPassword(password || '', user.password_hash)) {
    return res.status(401).json({ error: 'email 或密碼錯誤' });
  }
  // 前端會先選「我是老師／我是學生」再登入；如果選的身份跟帳號實際身份不符，直接擋下來，
  // 避免學生誤用老師入口（或反過來）登入自己的帳號。
  if (role && role !== user.role) {
    const actualLabel = user.role === 'teacher' ? '教師' : '學生';
    return res.status(403).json({ error: `此帳號是${actualLabel}帳號，請從「我是${actualLabel}」入口登入` });
  }
  res.json({ token: signToken({ id: user.id }), user: publicUser(user) });
}));

// 兩端首頁總覽用的統計數字
app.get('/api/dashboard', auth, wrap(async (req, res) => {
  if (req.user.role === 'teacher') {
    const { rows } = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM classes WHERE teacher_id = $1) AS class_count,
        (SELECT COUNT(DISTINCT e.student_id) FROM enrollments e JOIN classes c ON c.id = e.class_id WHERE c.teacher_id = $1) AS student_count,
        (SELECT COUNT(*) FROM quizzes z JOIN classes c ON c.id = z.class_id WHERE c.teacher_id = $1) AS quiz_count,
        (SELECT COUNT(*) FROM question_answers qa
           JOIN quiz_submissions s ON s.id = qa.quiz_submission_id
           JOIN quizzes z ON z.id = s.quiz_id
           JOIN classes c ON c.id = z.class_id
           WHERE c.teacher_id = $1 AND qa.status != 'graded') AS pending_grading_count,
        (SELECT COUNT(*) FROM quiz_submissions s
           JOIN quizzes z ON z.id = s.quiz_id
           JOIN classes c ON c.id = z.class_id
           WHERE c.teacher_id = $1) AS submission_count
    `, [req.user.id]);
    const r = rows[0];
    return res.json({
      classCount: Number(r.class_count),
      studentCount: Number(r.student_count),
      quizCount: Number(r.quiz_count),
      pendingGradingCount: Number(r.pending_grading_count),
      submissionCount: Number(r.submission_count),
    });
  }
  const { rows } = await pool.query(`
    SELECT
      (SELECT COUNT(*) FROM enrollments WHERE student_id = $1) AS class_count,
      (SELECT COUNT(*) FROM quizzes z JOIN enrollments e ON e.class_id = z.class_id
         WHERE e.student_id = $1
         AND NOT EXISTS (SELECT 1 FROM quiz_submissions s WHERE s.quiz_id = z.id AND s.student_id = $1)
      ) AS pending_quiz_count,
      (SELECT COUNT(*) FROM quiz_submissions s
         JOIN quizzes z ON z.id = s.quiz_id
         JOIN enrollments e ON e.class_id = z.class_id AND e.student_id = $1
         WHERE s.student_id = $1
      ) AS completed_quiz_count
  `, [req.user.id]);
  const r = rows[0];
  res.json({
    classCount: Number(r.class_count),
    pendingQuizCount: Number(r.pending_quiz_count),
    completedQuizCount: Number(r.completed_quiz_count),
  });
}));

app.get('/api/me', auth, (req, res) => res.json({ user: publicUser(req.user) }));

// ---------- class (課程 / 班級) routes ----------
app.post('/api/classes', auth, requireRole('teacher'), wrap(async (req, res) => {
  const { name } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: '請輸入課程名稱' });
  const joinCode = await generateJoinCode();
  const { rows } = await pool.query(
    'INSERT INTO classes (teacher_id, name, join_code) VALUES ($1, $2, $3) RETURNING *',
    [req.user.id, name.trim(), joinCode]
  );
  res.json(shapeClass(rows[0]));
}));

app.get('/api/classes', auth, wrap(async (req, res) => {
  if (req.user.role === 'teacher') {
    const { rows } = await pool.query(`
      SELECT c.*,
        (SELECT COUNT(*) FROM enrollments e WHERE e.class_id = c.id) AS student_count,
        (SELECT COUNT(*) FROM quizzes z WHERE z.class_id = c.id) AS quiz_count,
        (SELECT COUNT(*) FROM quiz_submissions s JOIN quizzes z ON z.id = s.quiz_id
           WHERE z.class_id = c.id AND s.status = 'submitted') AS pending_count
      FROM classes c
      WHERE c.teacher_id = $1
      ORDER BY c.created_at DESC
    `, [req.user.id]);
    return res.json(rows.map(shapeClass));
  }
  const { rows } = await pool.query(`
    SELECT c.*, u.name AS teacher_name,
      (SELECT COUNT(*) FROM quizzes z WHERE z.class_id = c.id) AS quiz_count,
      (SELECT COUNT(*) FROM quiz_submissions s JOIN quizzes z ON z.id = s.quiz_id
         WHERE z.class_id = c.id AND s.student_id = $1) AS completed_count
    FROM classes c
    JOIN enrollments e ON e.class_id = c.id AND e.student_id = $1
    JOIN users u ON u.id = c.teacher_id
    ORDER BY c.created_at DESC
  `, [req.user.id]);
  res.json(rows.map(shapeClass));
}));

app.post('/api/classes/join', auth, requireRole('student'), wrap(async (req, res) => {
  const code = String(req.body?.code || '').trim().toUpperCase();
  if (!code) return res.status(400).json({ error: '請輸入課程代碼' });
  const { rows } = await pool.query('SELECT * FROM classes WHERE join_code = $1', [code]);
  const cls = rows[0];
  if (!cls) return res.status(404).json({ error: '找不到此課程代碼' });
  await pool.query(
    'INSERT INTO enrollments (class_id, student_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
    [cls.id, req.user.id]
  );
  res.json({ ok: true, className: cls.name });
}));

// 教師刪除整門課程：連同底下的測驗、題目、學生作答、點名紀錄一併刪除，無法復原
app.delete('/api/classes/:id', auth, requireRole('teacher'), wrap(async (req, res) => {
  const cls = await assertOwnsClass(req, res, req.params.id);
  if (!cls) return;
  const client = await getClient();
  try {
    await client.query('BEGIN');
    await client.query(`
      DELETE FROM question_answers WHERE quiz_submission_id IN (
        SELECT s.id FROM quiz_submissions s JOIN quizzes z ON z.id = s.quiz_id WHERE z.class_id = $1
      )
    `, [cls.id]);
    await client.query('DELETE FROM quiz_submissions WHERE quiz_id IN (SELECT id FROM quizzes WHERE class_id = $1)', [cls.id]);
    await client.query('DELETE FROM questions WHERE quiz_id IN (SELECT id FROM quizzes WHERE class_id = $1)', [cls.id]);
    await client.query('DELETE FROM quizzes WHERE class_id = $1', [cls.id]);
    await client.query('DELETE FROM attendance WHERE class_id = $1', [cls.id]);
    await client.query('DELETE FROM enrollments WHERE class_id = $1', [cls.id]);
    await client.query('DELETE FROM classes WHERE id = $1', [cls.id]);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  res.json({ ok: true });
}));

// 學生退出課程：移除自己的加入紀錄與在這門課裡的作答，不影響其他學生或課程本身
app.delete('/api/classes/:id/leave', auth, requireRole('student'), wrap(async (req, res) => {
  const classId = req.params.id;
  const enrolled = await pool.query(
    'SELECT 1 FROM enrollments WHERE class_id = $1 AND student_id = $2', [classId, req.user.id]
  );
  if (!enrolled.rows.length) return res.status(404).json({ error: '你並未加入此課程' });

  const client = await getClient();
  try {
    await client.query('BEGIN');
    await client.query(`
      DELETE FROM question_answers WHERE quiz_submission_id IN (
        SELECT s.id FROM quiz_submissions s JOIN quizzes z ON z.id = s.quiz_id
        WHERE z.class_id = $1 AND s.student_id = $2
      )
    `, [classId, req.user.id]);
    await client.query(`
      DELETE FROM quiz_submissions WHERE student_id = $1
        AND quiz_id IN (SELECT id FROM quizzes WHERE class_id = $2)
    `, [req.user.id, classId]);
    await client.query('DELETE FROM attendance WHERE class_id = $1 AND student_id = $2', [classId, req.user.id]);
    await client.query('DELETE FROM enrollments WHERE class_id = $1 AND student_id = $2', [classId, req.user.id]);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  res.json({ ok: true });
}));

// ---------- 班級名單（roster）----------
app.get('/api/classes/:id/roster', auth, requireRole('teacher'), wrap(async (req, res) => {
  if (!(await assertOwnsClass(req, res, req.params.id))) return;
  const { rows } = await pool.query(`
    SELECT u.id, u.name, u.email, e.joined_at
    FROM enrollments e JOIN users u ON u.id = e.student_id
    WHERE e.class_id = $1
    ORDER BY u.name
  `, [req.params.id]);
  res.json(rows.map((r) => ({ id: r.id, name: r.name, email: r.email, joinedAt: r.joined_at })));
}));

app.post('/api/classes/:id/roster', auth, requireRole('teacher'), wrap(async (req, res) => {
  const cls = await assertOwnsClass(req, res, req.params.id);
  if (!cls) return;
  const email = String(req.body?.email || '').trim();
  const { rows } = await pool.query("SELECT * FROM users WHERE email = $1 AND role = 'student'", [email]);
  const student = rows[0];
  if (!student) return res.status(404).json({ error: '找不到此 email 對應的學生帳號（需先請學生註冊）' });
  await pool.query(
    'INSERT INTO enrollments (class_id, student_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
    [cls.id, student.id]
  );
  res.json({ ok: true, student: publicUser(student) });
}));

app.delete('/api/classes/:id/roster/:studentId', auth, requireRole('teacher'), wrap(async (req, res) => {
  const cls = await assertOwnsClass(req, res, req.params.id);
  if (!cls) return;
  await pool.query(
    'DELETE FROM enrollments WHERE class_id = $1 AND student_id = $2',
    [req.params.id, req.params.studentId]
  );
  res.json({ ok: true });
}));

// ---------- 點名（attendance）----------
app.get('/api/classes/:id/attendance', auth, requireRole('teacher'), wrap(async (req, res) => {
  if (!(await assertOwnsClass(req, res, req.params.id))) return;
  const date = req.query.date || new Date().toISOString().slice(0, 10);
  const { rows } = await pool.query(`
    SELECT u.id AS student_id, u.name, u.email, a.status
    FROM enrollments e
    JOIN users u ON u.id = e.student_id
    LEFT JOIN attendance a ON a.class_id = e.class_id AND a.student_id = e.student_id AND a.date = $1
    WHERE e.class_id = $2
    ORDER BY u.name
  `, [date, req.params.id]);
  res.json({
    date,
    roster: rows.map((r) => ({ studentId: r.student_id, name: r.name, email: r.email, status: r.status || null })),
  });
}));

app.post('/api/classes/:id/attendance', auth, requireRole('teacher'), wrap(async (req, res) => {
  const cls = await assertOwnsClass(req, res, req.params.id);
  if (!cls) return;
  const { date, records } = req.body || {};
  if (!date || !Array.isArray(records)) return res.status(400).json({ error: '缺少日期或名單資料' });

  const client = await getClient();
  try {
    await client.query('BEGIN');
    for (const r of records) {
      if (!['present', 'absent', 'late'].includes(r.status)) continue;
      await client.query(`
        INSERT INTO attendance (class_id, student_id, date, status)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (class_id, student_id, date) DO UPDATE SET
          status = $4, taken_at = to_char(now(), 'YYYY-MM-DD HH24:MI:SS')
      `, [Number(req.params.id), Number(r.studentId), date, r.status]);
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  res.json({ ok: true });
}));

// ---------- 測驗（quiz = 標題 + 多題，一次建立、一次儲存）----------
app.post('/api/classes/:id/quizzes', auth, requireRole('teacher'), wrap(async (req, res) => {
  const cls = await assertOwnsClass(req, res, req.params.id);
  if (!cls) return;
  const { title, dueDate = null, questions, kind = 'normal' } = req.body || {};
  if (!title || !title.trim()) return res.status(400).json({ error: '請輸入測驗標題' });
  if (!['normal', 'pretest', 'posttest'].includes(kind)) {
    return res.status(400).json({ error: '測驗類型不正確' });
  }
  if (!Array.isArray(questions) || questions.length === 0) {
    return res.status(400).json({ error: '請至少新增一題' });
  }
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    if (!q.description || !q.description.trim()) {
      return res.status(400).json({ error: `第 ${i + 1} 題請輸入題目說明` });
    }
    if (!['single', 'multiple', 'short'].includes(q.type)) {
      return res.status(400).json({ error: `第 ${i + 1} 題的題型不正確` });
    }
    if (q.type !== 'short') {
      const opts = (q.options || []).map((s) => String(s).trim()).filter(Boolean);
      if (opts.length < 2) return res.status(400).json({ error: `第 ${i + 1} 題選擇題至少需要兩個選項` });
      if (q.type === 'single' && typeof q.answerKey !== 'number') {
        return res.status(400).json({ error: `第 ${i + 1} 題請設定正解` });
      }
      if (q.type === 'multiple' && (!Array.isArray(q.answerKey) || q.answerKey.length === 0)) {
        return res.status(400).json({ error: `第 ${i + 1} 題請至少勾選一個正解` });
      }
    }
  }

  const client = await getClient();
  try {
    await client.query('BEGIN');
    const quizRes = await client.query(
      'INSERT INTO quizzes (class_id, teacher_id, title, kind, due_date) VALUES ($1, $2, $3, $4, $5) RETURNING id',
      [cls.id, req.user.id, title.trim(), kind, dueDate || null]
    );
    const quizId = quizRes.rows[0].id;
    for (let i = 0; i < questions.length; i++) {
      const q = questions[i];
      const opts = q.type === 'short' ? [] : q.options.map((s) => String(s).trim()).filter(Boolean);
      const answerKeyValue = q.type === 'short' ? String(q.answerKey || '').trim() : q.answerKey;
      await client.query(
        `INSERT INTO questions (quiz_id, seq, description, type, options, answer_key, explanation)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [quizId, i + 1, q.description.trim(), q.type, JSON.stringify(opts), JSON.stringify(answerKeyValue), q.explanation || '']
      );
    }
    await client.query('COMMIT');
    res.json({ id: quizId, ok: true });
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}));

// 編輯已發布的測驗（就算學生已經作答完畢也能改）：
// 題目陣列裡帶 id 的視為修改既有題目，沒帶 id 的視為新題目；
// 原本存在但這次沒出現在陣列裡的題目視為被刪除，連同該題學生的作答一起移除（其他題目的作答不受影響）。
app.put('/api/quizzes/:id', auth, requireRole('teacher'), wrap(async (req, res) => {
  const zRes = await pool.query('SELECT * FROM quizzes WHERE id = $1', [req.params.id]);
  const z = zRes.rows[0];
  if (!z || z.teacher_id !== req.user.id) return res.status(403).json({ error: '權限不足' });

  const { title, dueDate = null, questions, kind = 'normal' } = req.body || {};
  if (!title || !title.trim()) return res.status(400).json({ error: '請輸入測驗標題' });
  if (!['normal', 'pretest', 'posttest'].includes(kind)) {
    return res.status(400).json({ error: '測驗類型不正確' });
  }
  if (!Array.isArray(questions) || questions.length === 0) {
    return res.status(400).json({ error: '請至少保留一題' });
  }
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    if (!q.description || !q.description.trim()) {
      return res.status(400).json({ error: `第 ${i + 1} 題請輸入題目說明` });
    }
    if (!['single', 'multiple', 'short'].includes(q.type)) {
      return res.status(400).json({ error: `第 ${i + 1} 題的題型不正確` });
    }
    if (q.type !== 'short') {
      const opts = (q.options || []).map((s) => String(s).trim()).filter(Boolean);
      if (opts.length < 2) return res.status(400).json({ error: `第 ${i + 1} 題選擇題至少需要兩個選項` });
      if (q.type === 'single' && typeof q.answerKey !== 'number') {
        return res.status(400).json({ error: `第 ${i + 1} 題請設定正解` });
      }
      if (q.type === 'multiple' && (!Array.isArray(q.answerKey) || q.answerKey.length === 0)) {
        return res.status(400).json({ error: `第 ${i + 1} 題請至少勾選一個正解` });
      }
    }
  }

  const client = await getClient();
  try {
    await client.query('BEGIN');
    await client.query(
      'UPDATE quizzes SET title = $1, kind = $2, due_date = $3 WHERE id = $4',
      [title.trim(), kind, dueDate || null, z.id]
    );

    const existingRes = await client.query('SELECT id FROM questions WHERE quiz_id = $1', [z.id]);
    const existingIds = new Set(existingRes.rows.map((r) => r.id));
    const keptIds = new Set();
    let addedNewQuestion = false;

    for (let i = 0; i < questions.length; i++) {
      const q = questions[i];
      const opts = q.type === 'short' ? [] : q.options.map((s) => String(s).trim()).filter(Boolean);
      const answerKeyValue = q.type === 'short' ? String(q.answerKey || '').trim() : q.answerKey;
      const answerKeyJson = JSON.stringify(answerKeyValue);
      if (q.id && existingIds.has(q.id)) {
        await client.query(
          'UPDATE questions SET seq = $1, description = $2, type = $3, options = $4, answer_key = $5, explanation = $6 WHERE id = $7',
          [i + 1, q.description.trim(), q.type, JSON.stringify(opts), answerKeyJson, q.explanation || '', q.id]
        );
        keptIds.add(q.id);
      } else {
        const ins = await client.query(
          `INSERT INTO questions (quiz_id, seq, description, type, options, answer_key, explanation)
           VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
          [z.id, i + 1, q.description.trim(), q.type, JSON.stringify(opts), answerKeyJson, q.explanation || '']
        );
        keptIds.add(ins.rows[0].id);
        addedNewQuestion = true;
      }
    }

    const removedIds = [...existingIds].filter((id) => !keptIds.has(id));
    if (removedIds.length) {
      await client.query('DELETE FROM question_answers WHERE question_id = ANY($1::int[])', [removedIds]);
      await client.query('DELETE FROM questions WHERE id = ANY($1::int[])', [removedIds]);
    }

    // 新增了題目的話，已經交過卷的學生就少答了這一題：替他們補一筆空白作答（0 分），
    // 整份的分數才算得出來。學生可以重新作答把新題目補上。
    if (addedNewQuestion) {
      await client.query(`${FILL_MISSING_ANSWERS} WHERE s.quiz_id = $1 ON CONFLICT DO NOTHING`, [z.id]);
    }

    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}));

app.get('/api/classes/:id/quizzes', auth, wrap(async (req, res) => {
  if (req.user.role === 'teacher') {
    if (!(await assertOwnsClass(req, res, req.params.id))) return;
    const { rows } = await pool.query(`
      SELECT z.*,
        (SELECT COUNT(*) FROM questions q WHERE q.quiz_id = z.id) AS question_count,
        (SELECT COUNT(*) FROM quiz_submissions s WHERE s.quiz_id = z.id) AS submission_count,
        (SELECT COUNT(*) FROM quiz_submissions s WHERE s.quiz_id = z.id AND s.status = 'graded') AS graded_count
      FROM quizzes z
      WHERE z.class_id = $1
      ORDER BY z.created_at DESC
    `, [req.params.id]);
    return res.json(rows.map(shapeQuiz));
  }
  const enrolled = await pool.query(
    'SELECT 1 FROM enrollments WHERE class_id = $1 AND student_id = $2', [req.params.id, req.user.id]
  );
  if (!enrolled.rows.length) return res.status(403).json({ error: '你尚未加入此課程' });
  const { rows } = await pool.query(`
    SELECT z.*,
      (SELECT COUNT(*) FROM questions q WHERE q.quiz_id = z.id) AS question_count,
      s.id AS my_submission_id,
      s.status AS my_status
    FROM quizzes z
    LEFT JOIN quiz_submissions s ON s.quiz_id = z.id AND s.student_id = $1
    WHERE z.class_id = $2
    ORDER BY z.created_at DESC
  `, [req.user.id, req.params.id]);

  const result = [];
  for (const z of rows) {
    const questionCount = Number(z.question_count);
    let myScore = null;
    if (z.my_submission_id) {
      const agg = await pool.query(`
        SELECT SUM(score) AS total, SUM(CASE WHEN status = 'graded' THEN 1 ELSE 0 END) AS graded_n
        FROM question_answers WHERE quiz_submission_id = $1
      `, [z.my_submission_id]);
      const { total, graded_n } = agg.rows[0];
      if (Number(graded_n) === questionCount && questionCount > 0) {
        myScore = Math.round((Number(total) / questionCount) * 10) / 10;
      }
    }
    result.push(shapeQuiz({ ...z, my_score: myScore }));
  }
  res.json(result);
}));

app.get('/api/quizzes/:id', auth, wrap(async (req, res) => {
  const zRes = await pool.query('SELECT * FROM quizzes WHERE id = $1', [req.params.id]);
  const z = zRes.rows[0];
  if (!z) return res.status(404).json({ error: '找不到測驗' });
  if (req.user.role === 'teacher' && z.teacher_id !== req.user.id) {
    return res.status(403).json({ error: '權限不足' });
  }
  if (req.user.role === 'student') {
    const enrolledRes = await pool.query(
      'SELECT 1 FROM enrollments WHERE class_id = $1 AND student_id = $2', [z.class_id, req.user.id]
    );
    if (!enrolledRes.rows.length) return res.status(403).json({ error: '你尚未加入此課程' });
  }
  const qsRes = await pool.query('SELECT * FROM questions WHERE quiz_id = $1 ORDER BY seq', [z.id]);
  const includeAnswer = req.user.role === 'teacher';
  res.json({ ...shapeQuiz(z), questions: qsRes.rows.map((q) => shapeQuestion(q, { includeAnswer })) });
}));

// ---------- 學生作答 / 老師批改 ----------
app.post('/api/quizzes/:id/submit', auth, requireRole('student'), wrap(async (req, res) => {
  const zRes = await pool.query('SELECT * FROM quizzes WHERE id = $1', [req.params.id]);
  const z = zRes.rows[0];
  if (!z) return res.status(404).json({ error: '找不到測驗' });
  const enrolledRes = await pool.query(
    'SELECT 1 FROM enrollments WHERE class_id = $1 AND student_id = $2', [z.class_id, req.user.id]
  );
  if (!enrolledRes.rows.length) return res.status(403).json({ error: '你尚未加入此課程' });

  const { answers } = req.body || {};
  if (!Array.isArray(answers) || answers.length === 0) {
    return res.status(400).json({ error: '缺少作答內容' });
  }
  const questionsRes = await pool.query('SELECT * FROM questions WHERE quiz_id = $1 ORDER BY seq', [z.id]);
  const questionIds = new Set(questionsRes.rows.map((q) => q.id));
  // 只收屬於這份測驗的題目；questionId 可能是字串，同一題送兩次以最後一次為準
  const submitted = new Map();
  for (const a of answers) {
    const qid = a && typeof a === 'object' ? Number(a.questionId) : NaN;
    if (questionIds.has(qid)) submitted.set(qid, a.content);
  }
  if (submitted.size === 0) return res.status(400).json({ error: '缺少作答內容' });

  let subId;
  const client = await getClient();
  try {
    await client.query('BEGIN');
    await client.query(`
      INSERT INTO quiz_submissions (quiz_id, student_id, status)
      VALUES ($1, $2, 'submitted')
      ON CONFLICT (quiz_id, student_id) DO UPDATE SET
        status = 'submitted', submitted_at = to_char(now(), 'YYYY-MM-DD HH24:MI:SS'), graded_at = NULL
    `, [z.id, req.user.id]);
    const subRes = await client.query(
      'SELECT id FROM quiz_submissions WHERE quiz_id = $1 AND student_id = $2', [z.id, req.user.id]
    );
    subId = subRes.rows[0].id;

    let allGraded = true;
    // 每一題都要有一筆作答紀錄：沒送來的題目當成空白作答（0 分），
    // 這樣整份測驗的分數、批改狀態才算得出來，不會出現「已批改卻沒有分數」
    for (const q of questionsRes.rows) {
      const content = normalizeAnswer(q, submitted.get(q.id));
      let score = autoGrade(q.type, q.answer_key, content);
      // 簡答題有寫內容、而且有 AI 可用時，分數交給 AI 判讀（關鍵字看不懂「不是葉綠素」這種否定句，
      // 也看不出換個說法的正確答案）。先把關鍵字的分數暫存在 ai_hold，AI 判讀完才正式給分；
      // AI 失敗或超過每日上限時，就用這個暫存的關鍵字分數。
      let hold = null;
      if (q.type === 'short' && content && aiWillJudge(req.user)) { hold = score; score = null; }
      if (score === null) allGraded = false;
      await client.query(`
        INSERT INTO question_answers (quiz_submission_id, question_id, content, score, status, ai_hold)
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (quiz_submission_id, question_id) DO UPDATE SET
          content = $3, score = $4, status = $5, ai_hold = $6, feedback = '', ai_feedback = '', ai_status = '', ai_verdict = ''
      `, [subId, q.id, JSON.stringify(content), score, score === null ? 'submitted' : 'graded', hold]);
    }
    if (allGraded) {
      await client.query(
        `UPDATE quiz_submissions SET status = 'graded', graded_at = to_char(now(), 'YYYY-MM-DD HH24:MI:SS') WHERE id = $1`,
        [subId]
      );
    }
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  // 回應已送出，AI 回饋在背景產生；失敗只記 log，不影響學生交卷
  startAiFeedback(subId, req.user).catch((e) => console.error('AI 回饋啟動失敗：', e.message));
  sendSubmissionEvent(subId, 'quiz.submitted').catch((e) => console.error('通知失敗：', e.message));
}));

// 把一份作答整理成通知內容送給 n8n（n8n 再寄 email 給 student.email）。
// 分數只有在整份都批改完成時才有值（選擇題自動批改完、簡答題可能還在等老師）。
async function sendSubmissionEvent(subId, event) {
  const { rows } = await pool.query(`
    SELECT s.status, s.submitted_at, s.graded_at, z.title AS quiz_title, z.kind, c.name AS class_name,
           u.name AS student_name, u.email AS student_email, t.name AS teacher_name
    FROM quiz_submissions s
    JOIN quizzes z ON z.id = s.quiz_id
    JOIN classes c ON c.id = z.class_id
    JOIN users u ON u.id = s.student_id
    JOIN users t ON t.id = z.teacher_id
    WHERE s.id = $1
  `, [subId]);
  const s = rows[0];
  if (!s) return;
  const ansRes = await pool.query(`
    SELECT qa.score, qa.feedback, q.seq, q.description
    FROM question_answers qa JOIN questions q ON q.id = qa.question_id
    WHERE qa.quiz_submission_id = $1 ORDER BY q.seq
  `, [subId]);
  const answers = ansRes.rows;
  const allGraded = s.status === 'graded' && answers.length > 0;
  const score = allGraded
    ? Math.round((answers.reduce((sum, a) => sum + Number(a.score || 0), 0) / answers.length) * 10) / 10
    : null;
  await notify(event, {
    student: { name: s.student_name, email: s.student_email },
    teacher: { name: s.teacher_name },
    class: { name: s.class_name },
    quiz: { title: s.quiz_title, kind: s.kind },
    status: s.status,
    score,
    submittedAt: s.submitted_at,
    gradedAt: s.graded_at,
    questionCount: answers.length,
    answers: allGraded
      ? answers.map((a) => ({ seq: a.seq, question: a.description, score: a.score, teacherFeedback: a.feedback || '' }))
      : [],
  });
}

// ---------- AI 小老師 ----------
const DEMO_STUDENT_EMAIL = 'demo.student@demo.com';
const AI_CONCURRENCY = 3;
// AI 判讀結果對應的簡答題分數
const VERDICT_SCORE = { correct: 100, partial: 50, incorrect: 0 };

// 伺服器啟動時收尾：分數已改成自動給（AI 或關鍵字），不再有「等老師批改」的題目。
// 還沒有分數的作答（舊版留下的待批改，或 AI 判讀到一半伺服器就重啟）在這裡補上分數：
// 有 AI 判讀結果就照判讀，否則用暫存的關鍵字分數，都沒有就是 0 分。
async function settleLeftovers() {
  await pool.query(`${FILL_MISSING_ANSWERS} ON CONFLICT DO NOTHING`);
  const { rowCount } = await pool.query(`
    UPDATE question_answers SET
      score = COALESCE(CASE ai_verdict WHEN 'correct' THEN 100 WHEN 'partial' THEN 50 WHEN 'incorrect' THEN 0 END, ai_hold, 0),
      status = 'graded', ai_hold = NULL,
      ai_status = CASE WHEN ai_status = 'pending' THEN 'failed' ELSE ai_status END
    WHERE status <> 'graded' OR ai_status = 'pending'
  `);
  await pool.query(`
    UPDATE quiz_submissions s SET status = 'graded', graded_at = to_char(now(), 'YYYY-MM-DD HH24:MI:SS')
    WHERE s.status = 'submitted'
      AND NOT EXISTS (SELECT 1 FROM question_answers qa WHERE qa.quiz_submission_id = s.id AND qa.status <> 'graded')
  `);
  if (rowCount) console.log('已替 ' + rowCount + ' 筆未完成的作答補上分數');
}

// 這位學生的作答會不會送給 AI（有設金鑰，而且不是被關閉 AI 的示範帳號）
const aiWillJudge = (user) => ai.aiEnabled() && !(user.email === DEMO_STUDENT_EMAIL && !ai.demoAllowed());

// AI 沒辦法判讀（超過每日上限、呼叫失敗）時，把暫存的關鍵字分數還給這一題
const RELEASE_HOLD = `score = COALESCE(ai_hold, score), status = CASE WHEN ai_hold IS NOT NULL THEN 'graded' ELSE status END, ai_hold = NULL`;

// 某一題的分數因為 AI 判讀而確定之後，檢查整份是不是都批改完了；是的話更新狀態並通知學生
async function settleSubmission(subId) {
  const { rows } = await pool.query(`
    UPDATE quiz_submissions SET status = 'graded', graded_at = to_char(now(), 'YYYY-MM-DD HH24:MI:SS')
    WHERE id = $1 AND status = 'submitted'
      AND NOT EXISTS (SELECT 1 FROM question_answers WHERE quiz_submission_id = $1 AND status <> 'graded')
    RETURNING id
  `, [subId]);
  if (rows.length) sendSubmissionEvent(subId, 'quiz.graded').catch((e) => console.error('通知失敗：', e.message));
}

// 把這份作答裡「還沒有 AI 回饋」的題目標成 pending（或 off / limit），然後在背景逐題產生。
async function startAiFeedback(subId, user) {
  if (!ai.aiEnabled()) return;
  const isDemo = user.email === DEMO_STUDENT_EMAIL;
  if (isDemo && !ai.demoAllowed()) {
    await pool.query(`UPDATE question_answers SET ai_status = 'off' WHERE quiz_submission_id = $1 AND ai_status IN ('', 'failed', 'limit')`, [subId]);
    return;
  }
  // 用量記在 ai_usage（每人每天一筆累加）。不能用作答紀錄去數：重新作答會覆蓋同一筆紀錄，次數就不會增加
  const usedRes = await pool.query(
    `SELECT n FROM ai_usage WHERE student_id = $1 AND day = to_char(now(), 'YYYY-MM-DD')`, [user.id]
  );
  let remaining = Math.max(0, ai.dailyLimit() - Number(usedRes.rows[0] ? usedRes.rows[0].n : 0));
  const todo = await pool.query(
    `SELECT id FROM question_answers WHERE quiz_submission_id = $1 AND ai_status IN ('', 'failed', 'limit') ORDER BY id`, [subId]
  );
  const ids = [];
  for (const r of todo.rows) {
    if (remaining > 0) {
      ids.push(r.id); remaining -= 1;
      await pool.query(`UPDATE question_answers SET ai_status = 'pending', ai_at = to_char(now(), 'YYYY-MM-DD HH24:MI:SS') WHERE id = $1`, [r.id]);
    } else {
      await pool.query(`UPDATE question_answers SET ai_status = 'limit', ${RELEASE_HOLD} WHERE id = $1`, [r.id]);
    }
  }
  if (ids.length) {
    await pool.query(`
      INSERT INTO ai_usage (student_id, day, n) VALUES ($1, to_char(now(), 'YYYY-MM-DD'), $2)
      ON CONFLICT (student_id, day) DO UPDATE SET n = ai_usage.n + $2
    `, [user.id, ids.length]);
  }
  await settleSubmission(subId);
  // 不 await：讓呼叫端可以立刻結束；內部自己處理錯誤
  runAiQueue(ids).catch((e) => console.error('AI 回饋執行失敗：', e.message));
}

async function runAiQueue(ids) {
  const queue = [...ids];
  const worker = async () => {
    while (queue.length) {
      const id = queue.shift();
      await generateOne(id);
    }
  };
  await Promise.all(Array.from({ length: Math.min(AI_CONCURRENCY, queue.length) }, worker));
}

async function generateOne(answerId) {
  const { rows } = await pool.query(`
    SELECT qa.id, qa.quiz_submission_id, qa.content, qa.score, q.description, q.type, q.options, q.answer_key, q.explanation
    FROM question_answers qa JOIN questions q ON q.id = qa.question_id
    WHERE qa.id = $1 AND qa.ai_status = 'pending'
  `, [answerId]);
  const row = rows[0];
  if (!row) return;
  let text = '', status = 'done', verdict = '';
  try {
    if (row.type === 'short' && parse(row.content, '')) {
      // 簡答題：AI 同時判讀對錯（verdict）和寫回饋
      ({ verdict, feedback: text } = await ai.judgeShort(ai.buildUserMessage(row, parse)));
    } else {
      text = await ai.callClaude(ai.buildUserMessage(row, parse));
    }
  } catch (e) {
    console.error(`AI 回饋失敗（answer ${answerId}）：`, e.message);
    status = 'failed';
  }
  // 條件包含 content：學生若在這段時間內重新作答，舊的結果不會蓋掉新的。
  // 等 AI 判讀的題目（ai_hold 不是 NULL）在這裡正式給分：正確 100、部分正確 50、不正確 0；
  // AI 失敗就用暫存的關鍵字分數。其他題目（選擇題、空白簡答）分數早就確定，這裡不會動。
  const aiScore = status === 'failed' ? null : VERDICT_SCORE[verdict];
  await pool.query(`
    UPDATE question_answers SET ai_feedback = $1, ai_status = $2, ai_verdict = $5,
      score = CASE WHEN ai_hold IS NOT NULL THEN COALESCE($6::real, ai_hold) ELSE score END,
      status = CASE WHEN ai_hold IS NOT NULL THEN 'graded' ELSE status END,
      ai_hold = NULL
    WHERE id = $3 AND ai_status = 'pending' AND content = $4
  `, [text, status, answerId, row.content, verdict, aiScore === undefined ? null : aiScore]);
  await settleSubmission(row.quiz_submission_id);
}

// 學生按「重新產生」：只處理失敗或超過上限而沒產生的題目
app.post('/api/quizzes/:id/ai-retry', auth, requireRole('student'), wrap(async (req, res) => {
  const subRes = await pool.query('SELECT id FROM quiz_submissions WHERE quiz_id = $1 AND student_id = $2', [req.params.id, req.user.id]);
  if (!subRes.rows[0]) return res.status(404).json({ error: '尚未作答' });
  await startAiFeedback(subRes.rows[0].id, req.user);
  res.json({ ok: true });
}));

// 教師看某測驗所有學生的作答（用於批改）
app.get('/api/quizzes/:id/submissions', auth, requireRole('teacher'), wrap(async (req, res) => {
  const zRes = await pool.query('SELECT * FROM quizzes WHERE id = $1', [req.params.id]);
  const z = zRes.rows[0];
  if (!z || z.teacher_id !== req.user.id) return res.status(403).json({ error: '權限不足' });
  const subsRes = await pool.query(`
    SELECT s.*, u.name AS student_name, u.email AS student_email
    FROM quiz_submissions s JOIN users u ON u.id = s.student_id
    WHERE s.quiz_id = $1
    ORDER BY s.submitted_at DESC
  `, [z.id]);

  const result = [];
  for (const s of subsRes.rows) {
    const ansRes = await pool.query(`
      SELECT qa.*, q.seq, q.description, q.type, q.options, q.answer_key, q.explanation
      FROM question_answers qa JOIN questions q ON q.id = qa.question_id
      WHERE qa.quiz_submission_id = $1
      ORDER BY q.seq
    `, [s.id]);
    result.push({
      id: s.id,
      studentName: s.student_name,
      studentEmail: s.student_email,
      status: s.status,
      submittedAt: s.submitted_at,
      answers: ansRes.rows.map((a) => ({
        answerId: a.id,
        questionId: a.question_id,
        seq: a.seq,
        description: a.description,
        type: a.type,
        options: parse(a.options, []),
        answerKey: parse(a.answer_key, ''),
        explanation: a.explanation || '',
        content: parse(a.content, ''),
        score: a.score,
        feedback: a.feedback,
        status: a.status,
        aiFeedback: a.ai_feedback || '',
        aiStatus: a.ai_status || '',
        aiVerdict: a.ai_verdict || '',
      })),
    });
  }
  res.json(result);
}));

// 教師回饋：老師只寫文字回饋，不改分數（分數由系統與 AI 決定）
app.post('/api/quiz-submissions/:id/feedback', auth, requireRole('teacher'), wrap(async (req, res) => {
  const subRes = await pool.query(`
    SELECT s.*, z.teacher_id FROM quiz_submissions s
    JOIN quizzes z ON z.id = s.quiz_id
    WHERE s.id = $1
  `, [req.params.id]);
  const sub = subRes.rows[0];
  if (!sub || sub.teacher_id !== req.user.id) return res.status(403).json({ error: '權限不足' });

  const { answers } = req.body || {};
  if (!Array.isArray(answers)) return res.status(400).json({ error: '缺少回饋資料' });
  let changed = 0;
  for (const a of answers) {
    if (!a || typeof a !== 'object') continue;
    const r = await pool.query(
      `UPDATE question_answers SET feedback = $1 WHERE id = $2 AND quiz_submission_id = $3 AND feedback <> $1`,
      [String(a.feedback || '').trim().slice(0, 2000), Number(a.answerId) || 0, sub.id]
    );
    changed += r.rowCount;
  }
  res.json({ ok: true, changed });
  // 回饋有變動、而且這份作答已經有分數時，通知學生來看
  if (changed && sub.status === 'graded') {
    sendSubmissionEvent(sub.id, 'quiz.graded').catch((e) => console.error('通知失敗：', e.message));
  }
}));

// 教師重置某位學生的某份作答：刪掉作答明細（含分數、老師回饋、AI 回饋）與交卷紀錄，學生回到「未作答」
app.delete('/api/quiz-submissions/:id', auth, requireRole('teacher'), wrap(async (req, res) => {
  const subRes = await pool.query(`
    SELECT s.id, z.teacher_id FROM quiz_submissions s
    JOIN quizzes z ON z.id = s.quiz_id
    WHERE s.id = $1
  `, [req.params.id]);
  const sub = subRes.rows[0];
  if (!sub || sub.teacher_id !== req.user.id) return res.status(403).json({ error: '權限不足' });

  const client = await getClient();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM question_answers WHERE quiz_submission_id = $1', [sub.id]);
    await client.query('DELETE FROM quiz_submissions WHERE id = $1', [sub.id]);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  res.json({ ok: true });
}));

// 學生看自己某份測驗的作答明細與老師回饋
app.get('/api/quizzes/:id/my-submission', auth, requireRole('student'), wrap(async (req, res) => {
  const zRes = await pool.query('SELECT * FROM quizzes WHERE id = $1', [req.params.id]);
  const z = zRes.rows[0];
  if (!z) return res.status(404).json({ error: '找不到測驗' });
  const subRes = await pool.query(
    'SELECT * FROM quiz_submissions WHERE quiz_id = $1 AND student_id = $2', [z.id, req.user.id]
  );
  const sub = subRes.rows[0];
  if (!sub) return res.status(404).json({ error: '尚未作答' });
  const ansRes = await pool.query(`
    SELECT qa.*, q.seq, q.description, q.type, q.options, q.answer_key, q.explanation
    FROM question_answers qa JOIN questions q ON q.id = qa.question_id
    WHERE qa.quiz_submission_id = $1
    ORDER BY q.seq
  `, [sub.id]);
  res.json({
    status: sub.status,
    submittedAt: sub.submitted_at,
    // 這個 API 只有在學生已經交卷後才能查，這時候讓他們直接看到正確答案跟詳細解釋沒問題
    answers: ansRes.rows.map((a) => ({
      questionId: a.question_id,
      seq: a.seq,
      description: a.description,
      type: a.type,
      options: parse(a.options, []),
      answerKey: parse(a.answer_key, ''),
      explanation: a.explanation || '',
      content: parse(a.content, ''),
      score: a.score,
      feedback: a.feedback,
      status: a.status,
      aiFeedback: a.ai_feedback || '',
      aiStatus: a.ai_status || '',
        aiVerdict: a.ai_verdict || '',
    })),
  });
}));

// ---------- 試玩（demo）帳號 ----------
// 登入／註冊頁會顯示這組公開的試玩帳密，讓人不用註冊就能體驗。
// 這組帳號是「所有人共用、密碼公開」的，所以只放示範資料；正式上線若不想開放，
// 在環境變數設 DEMO_ACCOUNTS=off 就會完全關閉（不建立帳號，登入頁也不顯示）。
const DEMO = {
  password: 'demo1234',
  teacher: { email: 'demo.teacher@demo.com', name: '示範老師' },
  student: { email: 'demo.student@demo.com', name: '示範同學' },
  className: '示範課程：自然小學堂',
};
const demoEnabled = () => String(process.env.DEMO_ACCOUNTS || '').toLowerCase() !== 'off';

app.get('/api/demo', (req, res) => {
  if (!demoEnabled()) return res.json({ enabled: false });
  res.json({ enabled: true, password: DEMO.password, teacher: DEMO.teacher, student: DEMO.student });
});

// 把一批測驗（含題目）寫進某門課；quiz.questions[] 的格式跟示範課程一致
async function insertDemoQuizzes(client, classId, teacherId, quizzes) {
  for (const q of quizzes) {
    const quizId = (await client.query(
      'INSERT INTO quizzes (class_id, teacher_id, title, kind) VALUES ($1, $2, $3, $4) RETURNING id',
      [classId, teacherId, q.title, q.kind || 'normal']
    )).rows[0].id;
    for (let i = 0; i < q.questions.length; i++) {
      const x = q.questions[i];
      await client.query(
        `INSERT INTO questions (quiz_id, seq, description, type, options, answer_key, explanation)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [quizId, i + 1, x.description, x.type, JSON.stringify(x.options || []), JSON.stringify(x.answerKey ?? ''), x.explanation || '']
      );
    }
  }
}

// 第二門示範課程：「公民與社會題庫」——40 題，依 6 個章節各一份測驗（資料在 demo_quiz_bank.json）
const DEMO_BANK_CLASS = '公民與社會題庫（40 題）';
async function ensureBankClass(teacher, student) {
  let quizzes;
  try { quizzes = require('./demo_quiz_bank.json'); } catch { return; }
  let cls = (await pool.query(
    'SELECT * FROM classes WHERE teacher_id = $1 AND name = $2', [teacher.id, DEMO_BANK_CLASS]
  )).rows[0];
  if (!cls) {
    const client = await getClient();
    try {
      await client.query('BEGIN');
      const joinCode = await generateJoinCode();
      cls = (await client.query(
        'INSERT INTO classes (teacher_id, name, join_code) VALUES ($1, $2, $3) RETURNING *',
        [teacher.id, DEMO_BANK_CLASS, joinCode]
      )).rows[0];
      await insertDemoQuizzes(client, cls.id, teacher.id, quizzes);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }
  await pool.query(
    'INSERT INTO enrollments (class_id, student_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [cls.id, student.id]
  );
}

// 啟動時確保試玩帳號、示範課程、示範測驗都在（刪掉了下次啟動會補回來；已存在就不動）
async function ensureDemoData() {
  if (!demoEnabled()) return;
  const ensureUser = async (u, role) => {
    const found = await pool.query('SELECT * FROM users WHERE email = $1', [u.email]);
    if (found.rows[0]) return found.rows[0];
    const ins = await pool.query(
      'INSERT INTO users (email, password_hash, name, role) VALUES ($1, $2, $3, $4) RETURNING *',
      [u.email, hashPassword(DEMO.password), u.name, role]
    );
    return ins.rows[0];
  };
  const teacher = await ensureUser(DEMO.teacher, 'teacher');
  const student = await ensureUser(DEMO.student, 'student');
  // 帳號若被別人佔用成其他身分就不要硬塞資料
  if (teacher.role !== 'teacher' || student.role !== 'student') return;

  // 舊版的示範課程名稱開頭帶有表情符號，改名成純文字（只做一次；改過之後就找不到舊名稱了）
  for (const name of [DEMO.className, DEMO_BANK_CLASS]) {
    await pool.query(
      'UPDATE classes SET name = $1 WHERE teacher_id = $2 AND name <> $1 AND name LIKE $3',
      [name, teacher.id, '% ' + name]
    );
  }

  let cls = (await pool.query(
    'SELECT * FROM classes WHERE teacher_id = $1 AND name = $2', [teacher.id, DEMO.className]
  )).rows[0];

  if (!cls) {
    const client = await getClient();
    try {
      await client.query('BEGIN');
      const joinCode = await generateJoinCode();
      cls = (await client.query(
        'INSERT INTO classes (teacher_id, name, join_code) VALUES ($1, $2, $3) RETURNING *',
        [teacher.id, DEMO.className, joinCode]
      )).rows[0];
      const quizzes = [
        { title: '課前小測驗：你知道多少？', kind: 'pretest', questions: [
          { description: '植物是靠什麼製造養分的？', type: 'single', options: ['光合作用', '睡覺', '喝牛奶'], answerKey: 0, explanation: '植物利用陽光、水和二氧化碳製造養分，這叫光合作用。' },
          { description: '下面哪些是植物？（可複選）', type: 'multiple', options: ['玫瑰', '石頭', '向日葵', '腳踏車'], answerKey: [0, 2], explanation: '玫瑰和向日葵是植物；石頭和腳踏車不是生物。' },
        ] },
        { title: '動物小觀察', kind: 'normal', questions: [
          { description: '魚主要生活在哪裡？', type: 'single', options: ['水裡', '天空', '沙漠'], answerKey: 0, explanation: '魚用鰓呼吸，生活在水裡。' },
          { description: '請寫出一種你知道的會飛的動物。', type: 'short', answerKey: '鳥,蝴蝶,蝙蝠,蜜蜂,蜻蜓', explanation: '小鳥、蝴蝶、蝙蝠、蜜蜂、蜻蜓都會飛喔！（寫到任何一個關鍵字系統會自動給分）' },
        ] },
        { title: '期末後測：我學會了！', kind: 'posttest', questions: [
          { description: '水結成冰是幾度？', type: 'single', options: ['0 度', '100 度', '50 度'], answerKey: 0, explanation: '水在 0 度會結冰、100 度會沸騰。' },
        ] },
      ];
      await insertDemoQuizzes(client, cls.id, teacher.id, quizzes);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }
  await pool.query(
    'INSERT INTO enrollments (class_id, student_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [cls.id, student.id]
  );
  await ensureBankClass(teacher, student);
}

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// 統一錯誤處理：任何 route 裡沒接住的例外（含資料庫錯誤）都回 JSON，
// 前端才拿得到有意義的錯誤訊息，而不是一段 HTML 錯誤頁解析失敗後顯示的「發生錯誤」。
app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: '伺服器發生錯誤，請稍後再試' });
});

async function start() {
  try {
    await init();
  } catch (e) {
    console.error('資料庫連線或初始化失敗：', e.message);
    process.exit(1);
  }
  try {
    await ensureDemoData();
  } catch (e) {
    // 試玩資料建不起來不影響正式功能，記一筆就好，不要讓伺服器起不來
    console.error('建立試玩帳號/示範資料失敗（不影響其他功能）：', e.message);
  }
  if (String(process.env.SETTLE_ON_START || '').toLowerCase() !== 'off') {
    await settleLeftovers().catch((e) => console.error('補分數失敗（不影響其他功能）：', e.message));
  }
  app.listen(PORT, () => console.log(`教學平台執行中： http://localhost:${PORT}`));
}

start();
