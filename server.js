'use strict';

const path = require('node:path');
const express = require('express');
const { pool, init } = require('./db');
const { hashPassword, verifyPassword, signToken, verifyToken } = require('./auth');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;

// 包住每個 async route/middleware：讓裡面拋出的錯誤（例如資料庫查詢失敗）
// 統一交給下面的錯誤處理 middleware 回應 JSON，而不是變成沒有回應或 Express 預設的 HTML 錯誤頁。
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

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

// 自動批改（選擇題）；簡答題回傳 null 交由老師批改
function autoGrade(type, answerKey, content) {
  if (type === 'single') {
    return Number(content) === Number(answerKey) ? 100 : 0;
  }
  if (type === 'multiple') {
    const key = [...(parse(answerKey, []))].map(Number).sort();
    const ans = [...(parse(content, []))].map(Number).sort();
    const same = key.length === ans.length && key.every((v, i) => v === ans[i]);
    return same ? 100 : 0;
  }
  return null;
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
  if (includeAnswer) shaped.answerKey = parse(q.answer_key, '');
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
  const { email, password } = req.body || {};
  const { rows } = await pool.query('SELECT * FROM users WHERE email = $1', [email || '']);
  const user = rows[0];
  if (!user || !verifyPassword(password || '', user.password_hash)) {
    return res.status(401).json({ error: 'email 或密碼錯誤' });
  }
  res.json({ token: signToken({ id: user.id }), user: publicUser(user) });
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
        (SELECT COUNT(*) FROM quizzes z WHERE z.class_id = c.id) AS quiz_count
      FROM classes c
      WHERE c.teacher_id = $1
      ORDER BY c.created_at DESC
    `, [req.user.id]);
    return res.json(rows.map(shapeClass));
  }
  const { rows } = await pool.query(`
    SELECT c.*, u.name AS teacher_name,
      (SELECT COUNT(*) FROM quizzes z WHERE z.class_id = c.id) AS quiz_count
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
  const client = await pool.connect();
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

  const client = await pool.connect();
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

  const client = await pool.connect();
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

  const client = await pool.connect();
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
      await client.query(
        `INSERT INTO questions (quiz_id, seq, description, type, options, answer_key)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [quizId, i + 1, q.description.trim(), q.type, JSON.stringify(opts), JSON.stringify(q.type === 'short' ? '' : q.answerKey)]
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
  const questionsRes = await pool.query('SELECT * FROM questions WHERE quiz_id = $1', [z.id]);
  const qMap = new Map(questionsRes.rows.map((q) => [q.id, q]));

  const client = await pool.connect();
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
    const subId = subRes.rows[0].id;

    let allGraded = true;
    for (const a of answers) {
      const q = qMap.get(a.questionId);
      if (!q) continue;
      const score = autoGrade(q.type, q.answer_key, a.content);
      if (score === null) allGraded = false;
      await client.query(`
        INSERT INTO question_answers (quiz_submission_id, question_id, content, score, status)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (quiz_submission_id, question_id) DO UPDATE SET
          content = $3, score = $4, status = $5, feedback = ''
      `, [subId, q.id, JSON.stringify(a.content ?? ''), score, score === null ? 'submitted' : 'graded']);
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
      SELECT qa.*, q.seq, q.description, q.type, q.options, q.answer_key
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
        content: parse(a.content, ''),
        score: a.score,
        feedback: a.feedback,
        status: a.status,
      })),
    });
  }
  res.json(result);
}));

// 教師一次批改一位學生整份測驗（可只送有異動的題目）
app.post('/api/quiz-submissions/:id/grade', auth, requireRole('teacher'), wrap(async (req, res) => {
  const subRes = await pool.query(`
    SELECT s.*, z.teacher_id FROM quiz_submissions s
    JOIN quizzes z ON z.id = s.quiz_id
    WHERE s.id = $1
  `, [req.params.id]);
  const sub = subRes.rows[0];
  if (!sub || sub.teacher_id !== req.user.id) return res.status(403).json({ error: '權限不足' });

  const { answers } = req.body || {};
  if (!Array.isArray(answers)) return res.status(400).json({ error: '缺少評分資料' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const a of answers) {
      await client.query(
        `UPDATE question_answers SET score = $1, feedback = $2, status = 'graded' WHERE id = $3 AND quiz_submission_id = $4`,
        [Number(a.score), a.feedback || '', a.answerId, sub.id]
      );
    }
    const remainRes = await client.query(
      `SELECT COUNT(*) AS n FROM question_answers WHERE quiz_submission_id = $1 AND status != 'graded'`,
      [sub.id]
    );
    if (Number(remainRes.rows[0].n) === 0) {
      await client.query(
        `UPDATE quiz_submissions SET status = 'graded', graded_at = to_char(now(), 'YYYY-MM-DD HH24:MI:SS') WHERE id = $1`,
        [sub.id]
      );
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
    SELECT qa.*, q.seq, q.description, q.type, q.options
    FROM question_answers qa JOIN questions q ON q.id = qa.question_id
    WHERE qa.quiz_submission_id = $1
    ORDER BY q.seq
  `, [sub.id]);
  res.json({
    status: sub.status,
    submittedAt: sub.submitted_at,
    answers: ansRes.rows.map((a) => ({
      questionId: a.question_id,
      seq: a.seq,
      description: a.description,
      type: a.type,
      options: parse(a.options, []),
      content: parse(a.content, ''),
      score: a.score,
      feedback: a.feedback,
      status: a.status,
    })),
  });
}));

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
  app.listen(PORT, () => console.log(`教學平台執行中： http://localhost:${PORT}`));
}

start();
