const express = require('express');
const mysql = require('mysql2/promise');
const multer = require('multer');
const QRCode = require('qrcode');
const bwipjs = require('bwip-js');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = 3000;

const DB_CONFIG = {
  host: 'localhost',
  user: 'root',
  password: '',
  database: 'cyber_zavhoz'
};

app.use(cors());
app.use(express.json());
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

const tokens = new Map();

function auth(req, res, next) {
  const header = req.headers.authorization;
  if (!header) return res.status(401).json({ error: 'Нет токена' });
  const token = header.replace('Bearer ', '');
  const user = tokens.get(token);
  if (!user) return res.status(401).json({ error: 'Неверный токен' });
  req.user = user;
  next();
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'uploads/'),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.jpg';
    cb(null, `item_${req.params.id}_${Date.now()}${ext}`);
  }
});
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } });

let db;
async function initDB() {
  db = await mysql.createPool(DB_CONFIG);
  console.log('БД подключена');
}

// === АВТОРИЗАЦИЯ ===
app.post('/api/login', async (req, res) => {
  try {
    const { login, password } = req.body;
    const [rows] = await db.query(
      'SELECT * FROM users WHERE login = ? AND password = ?',
      [login, password]
    );
    if (rows.length === 0) return res.status(401).json({ error: 'Неверный логин или пароль' });
    const user = rows[0];
    const token = `${user.id}_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    tokens.set(token, { id: user.id, login: user.login, role: user.role, fullName: user.full_name });
    res.json({ token, role: user.role, fullName: user.full_name, login: user.login });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// === ИМУЩЕСТВО ===
app.get('/api/items', auth, async (req, res) => {
  try {
    const q = req.query.q || '';
    const sql = q
      ? `SELECT * FROM items WHERE name LIKE ? OR code LIKE ? OR location LIKE ? ORDER BY updated_at DESC`
      : `SELECT * FROM items ORDER BY updated_at DESC`;
    const params = q ? [`%${q}%`, `%${q}%`, `%${q}%`] : [];
    const [rows] = await db.query(sql, params);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

app.get('/api/items/code/:code', auth, async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM items WHERE code = ?', [req.params.code]);
    if (rows.length === 0) return res.status(404).json({ error: 'Не найдено' });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

app.get('/api/items/:id', auth, async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM items WHERE id = ?', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Не найдено' });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

app.post('/api/items', auth, async (req, res) => {
  try {
    const { code, name, category, location, responsible, notes, status } = req.body;
    const [result] = await db.query(
      'INSERT INTO items (code, name, category, location, responsible, notes, status) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [code, name, category || '', location || '', responsible || '', notes || '', status || 'active']
    );
    const [rows] = await db.query('SELECT * FROM items WHERE id = ?', [result.insertId]);
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    if (err.code === 'ER_DUP_ENTRY') return res.status(400).json({ error: 'Код уже существует' });
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

app.put('/api/items/:id', auth, async (req, res) => {
  try {
    const { code, name, category, location, responsible, notes, status } = req.body;
    await db.query(
      'UPDATE items SET code=?, name=?, category=?, location=?, responsible=?, notes=?, status=? WHERE id=?',
      [code, name, category || '', location || '', responsible || '', notes || '', status || 'active', req.params.id]
    );
    const [rows] = await db.query('SELECT * FROM items WHERE id = ?', [req.params.id]);
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

app.delete('/api/items/:id', auth, async (req, res) => {
  try {
    await db.query('DELETE FROM items WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// === ФОТО ===
app.post('/api/items/:id/photo', auth, upload.single('photo'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Файл не получен' });
    const filename = req.file.filename;
    const [rows] = await db.query('SELECT photo FROM items WHERE id = ?', [req.params.id]);
    if (rows.length > 0 && rows[0].photo) {
      const oldPath = path.join(__dirname, 'uploads', rows[0].photo);
      if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
    }
    await db.query('UPDATE items SET photo = ? WHERE id = ?', [filename, req.params.id]);
    res.json({ photo: filename, url: `/uploads/${filename}` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка загрузки' });
  }
});

// === КОДЫ ===
app.get('/api/items/:id/qr', auth, async (req, res) => {
  try {
    const [rows] = await db.query('SELECT code FROM items WHERE id = ?', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Не найдено' });
    const buffer = await QRCode.toBuffer(rows[0].code, { width: 400, margin: 2 });
    res.set('Content-Type', 'image/png');
    res.send(buffer);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка генерации QR' });
  }
});

app.get('/api/items/:id/barcode', auth, async (req, res) => {
  try {
    const [rows] = await db.query('SELECT code FROM items WHERE id = ?', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Не найдено' });
    const buffer = await bwipjs.toBuffer({
      bcid: 'code128',
      text: rows[0].code,
      scale: 3,
      height: 15,
      includetext: true,
      textxalign: 'center'
    });
    res.set('Content-Type', 'image/png');
    res.send(buffer);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка генерации штрихкода' });
  }
});

// === ПОЛЬЗОВАТЕЛИ (admin) ===
app.get('/api/users', auth, async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Нужны права администратора' });
    const [rows] = await db.query('SELECT id, login, full_name, role, created_at FROM users');
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

app.post('/api/users', auth, async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Нужны права администратора' });
    const { login, password, full_name, role } = req.body;
    const [result] = await db.query(
      'INSERT INTO users (login, password, full_name, role) VALUES (?, ?, ?, ?)',
      [login, password, full_name, role || 'user']
    );
    res.json({ id: result.insertId, login, full_name, role: role || 'user' });
  } catch (err) {
    console.error(err);
    if (err.code === 'ER_DUP_ENTRY') return res.status(400).json({ error: 'Логин уже занят' });
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

app.put('/api/users/:id', auth, async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Нужны права администратора' });
    const { full_name, role, password } = req.body;
    if (password) {
      await db.query('UPDATE users SET full_name=?, role=?, password=? WHERE id=?', [full_name, role, password, req.params.id]);
    } else {
      await db.query('UPDATE users SET full_name=?, role=? WHERE id=?', [full_name, role, req.params.id]);
    }
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

app.delete('/api/users/:id', auth, async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Нужны права администратора' });
    await db.query('DELETE FROM users WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

initDB().then(() => {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Сервер запущен на http://localhost:${PORT}`);
  });
}).catch(err => {
  console.error('Ошибка запуска:', err);
});