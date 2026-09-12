'use strict';

require('dotenv').config();
const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  throw new Error('缺少 DATABASE_URL 環境變數，請在 .env 檔設定雲端 Postgres 的連線字串。');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }, // Supabase／大多數雲端 Postgres 都需要 SSL
});

pool.on('error', (err) => {
  console.error('資料庫連線池發生非預期錯誤：', err);
});

// 建表：跟原本 SQLite 版一樣的結構，語法換成 Postgres 相容
// （SERIAL 取代 AUTOINCREMENT；datetime('now') 換成 to_char(now(), ...) 維持一樣的顯示格式）
async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id            SERIAL PRIMARY KEY,
      email         TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      name          TEXT NOT NULL,
      role          TEXT NOT NULL CHECK (role IN ('teacher', 'student')),
      created_at    TEXT NOT NULL DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS')
    );

    -- 課程 / 班級：教師開課，學生用代碼加入。同時也是點名的分組單位。
    CREATE TABLE IF NOT EXISTS classes (
      id          SERIAL PRIMARY KEY,
      teacher_id  INTEGER NOT NULL REFERENCES users(id),
      name        TEXT NOT NULL,
      join_code   TEXT NOT NULL UNIQUE,
      created_at  TEXT NOT NULL DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS')
    );

    CREATE TABLE IF NOT EXISTS enrollments (
      class_id    INTEGER NOT NULL REFERENCES classes(id),
      student_id  INTEGER NOT NULL REFERENCES users(id),
      joined_at   TEXT NOT NULL DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS'),
      PRIMARY KEY (class_id, student_id)
    );

    CREATE TABLE IF NOT EXISTS attendance (
      id          SERIAL PRIMARY KEY,
      class_id    INTEGER NOT NULL REFERENCES classes(id),
      student_id  INTEGER NOT NULL REFERENCES users(id),
      date        TEXT NOT NULL,
      status      TEXT NOT NULL CHECK (status IN ('present', 'absent', 'late')),
      taken_at    TEXT NOT NULL DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS'),
      UNIQUE (class_id, student_id, date)
    );

    -- 一份測驗（有標題），底下包含多題，一次編輯、一次儲存
    CREATE TABLE IF NOT EXISTS quizzes (
      id          SERIAL PRIMARY KEY,
      class_id    INTEGER NOT NULL REFERENCES classes(id),
      teacher_id  INTEGER NOT NULL REFERENCES users(id),
      title       TEXT NOT NULL,
      kind        TEXT NOT NULL DEFAULT 'normal' CHECK (kind IN ('normal', 'pretest', 'posttest')),
      due_date    TEXT,
      created_at  TEXT NOT NULL DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS')
    );

    CREATE TABLE IF NOT EXISTS questions (
      id          SERIAL PRIMARY KEY,
      quiz_id     INTEGER NOT NULL REFERENCES quizzes(id),
      seq         INTEGER NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      type        TEXT NOT NULL CHECK (type IN ('single', 'multiple', 'short')),
      options     TEXT NOT NULL DEFAULT '[]',
      answer_key  TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS quiz_submissions (
      id           SERIAL PRIMARY KEY,
      quiz_id      INTEGER NOT NULL REFERENCES quizzes(id),
      student_id   INTEGER NOT NULL REFERENCES users(id),
      status       TEXT NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted', 'graded')),
      submitted_at TEXT NOT NULL DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS'),
      graded_at    TEXT,
      UNIQUE (quiz_id, student_id)
    );

    CREATE TABLE IF NOT EXISTS question_answers (
      id                  SERIAL PRIMARY KEY,
      quiz_submission_id  INTEGER NOT NULL REFERENCES quiz_submissions(id),
      question_id         INTEGER NOT NULL REFERENCES questions(id),
      content             TEXT NOT NULL DEFAULT '',
      score               REAL,
      feedback            TEXT NOT NULL DEFAULT '',
      status              TEXT NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted', 'graded')),
      UNIQUE (quiz_submission_id, question_id)
    );
  `);
}

module.exports = { pool, init };
