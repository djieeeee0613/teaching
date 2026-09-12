'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

// 簽章密鑰：優先用環境變數 SECRET（正式部署請這樣設定）。
// 本機開發沒設的話，自動產生一組隨機密鑰存到本地 .secret 檔（已加入 .gitignore，不會被推上 GitHub），
// 這樣就不會有任何寫死在程式碼裡、公開後可被冒用的密鑰。
function loadOrCreateSecret() {
  if (process.env.SECRET) return process.env.SECRET;
  const secretFile = path.join(__dirname, '.secret');
  try {
    return fs.readFileSync(secretFile, 'utf8').trim();
  } catch {
    const generated = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(secretFile, generated, { mode: 0o600 });
    console.warn('⚠️  未設定 SECRET 環境變數，已自動產生本機用密鑰於 .secret（正式部署請改用環境變數）。');
    return generated;
  }
}

const SECRET = loadOrCreateSecret();

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  const test = crypto.scryptSync(password, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(test, 'hex'));
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

// 極簡 JWT-like token：payload.signature
function signToken(payload) {
  const body = b64url(JSON.stringify({ ...payload, iat: Date.now() }));
  const sig = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function verifyToken(token) {
  if (!token || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  const expected = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  if (sig.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    return JSON.parse(Buffer.from(body, 'base64url').toString());
  } catch {
    return null;
  }
}

module.exports = { hashPassword, verifyPassword, signToken, verifyToken };
