const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const TelegramBot = require('node-telegram-bot-api');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const fs = require('fs');

// ==================== КОНФІГУРАЦІЯ ====================
const BOT_TOKEN = '8769585372:AAGDTdtfnbjX0XnqrMOrP99iQhygh4sGCKQ';
const OWNER_ID = 837614911;
const PORT = process.env.PORT || 8080;

// ==================== ІНІЦІАЛІЗАЦІЯ ====================
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ==================== БАЗА ДАНИХ ====================
let db;
async function initDatabase() {
  db = await open({
    filename: './game.db',
    driver: sqlite3.Database
  });

  await db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY,
      username TEXT,
      first_name TEXT,
      balance INTEGER DEFAULT 1000,
      role TEXT DEFAULT 'user',
      total_bet INTEGER DEFAULT 0,
      total_win INTEGER DEFAULT 0,
      banned_until INTEGER DEFAULT 0,
      muted_until INTEGER DEFAULT 0,
      created_at INTEGER DEFAULT (strftime('%s', 'now'))
    );

    CREATE TABLE IF NOT EXISTS cases (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      price INTEGER NOT NULL,
      is_free INTEGER DEFAULT 0,
      cooldown INTEGER DEFAULT 3600,
      image TEXT
    );

    CREATE TABLE IF NOT EXISTS case_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      case_id INTEGER NOT NULL,
      min_reward INTEGER NOT NULL,
      max_reward INTEGER NOT NULL,
      chance INTEGER NOT NULL,
      FOREIGN KEY(case_id) REFERENCES cases(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS case_openings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      case_id INTEGER NOT NULL,
      reward INTEGER NOT NULL,
      opened_at INTEGER DEFAULT (strftime('%s', 'now')),
      FOREIGN KEY(user_id) REFERENCES users(id),
      FOREIGN KEY(case_id) REFERENCES cases(id)
    );

    CREATE TABLE IF NOT EXISTS game_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      crash_point REAL NOT NULL,
      players_count INTEGER DEFAULT 0,
      created_at INTEGER DEFAULT (strftime('%s', 'now'))
    );

    CREATE TABLE IF NOT EXISTS bets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      game_id INTEGER,
      amount INTEGER NOT NULL,
      cashed_at REAL,
      won INTEGER DEFAULT 0,
      FOREIGN KEY(user_id) REFERENCES users(id)
    );
  `);

  // Додаємо власника
  await db.run(
    `INSERT OR IGNORE INTO users (id, username, first_name, balance, role) 
     VALUES (?, ?, ?, ?, ?)`,
    [OWNER_ID, 'vladyslav_owner', 'Владислав', 1000000, 'owner']
  );

  // Додаємо стандартні кейси (якщо їх немає)
  const freeCase = await db.get('SELECT id FROM cases WHERE name = ?', 'Безкоштовний кейс');
  if (!freeCase) {
    const result = await db.run(
      'INSERT INTO cases (name, price, is_free, cooldown) VALUES (?, ?, ?, ?)',
      ['Безкоштовний кейс', 0, 1, 3600]
    );
    await db.run(
      'INSERT INTO case_items (case_id, min_reward, max_reward, chance) VALUES (?, ?, ?, ?)',
      [result.lastID, 1, 100, 100]
    );
  }

  const starterCase = await db.get('SELECT id FROM cases WHERE name = ?', 'Стартовий кейс');
  if (!starterCase) {
    const result = await db.run(
      'INSERT INTO cases (name, price, is_free) VALUES (?, ?, ?)',
      ['Стартовий кейс', 50, 0]
    );
    await db.run(
      'INSERT INTO case_items (case_id, min_reward, max_reward, chance) VALUES (?, ?, ?, ?)',
      [result.lastID, 20, 200, 100]
    );
  }

  console.log('✅ База даних готова');
}

initDatabase().catch(console.error);

// ==================== ТЕЛЕГРАМ БОТ ====================
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const username = msg.from.username || '';
  const firstName = msg.from.first_name || 'Гравець';

  try {
    const user = await db.get('SELECT * FROM users WHERE id = ?', userId);
    if (!user) {
      await db.run(
        'INSERT INTO users (id, username, first_name, balance) VALUES (?, ?, ?, ?)',
        [userId, username, firstName, 1000]
      );
    }

    const webAppUrl = `https://${process.env.RAILWAY_STATIC_URL || 'localhost:' + PORT}`;
    await bot.sendMessage(chatId, '🎮 Ласкаво просимо до Crash Game!', {
      reply_markup: {
        inline_keyboard: [[
          { text: '🎰 ГРАТИ', web_app: { url: webAppUrl } }
        ]]
      }
    });
  } catch (error) {
    console.error('Помилка бота:', error);
  }
});

// ==================== API ====================
app.post('/api/user', async (req, res) => {
  try {
    const { id, username, first_name } = req.body;
    let user = await db.get('SELECT * FROM users WHERE id = ?', id);
    if (!user) {
      await db.run(
        'INSERT INTO users (id, username, first_name, balance) VALUES (?, ?, ?, ?)',
        [id, username || 'user', first_name || 'Гравець', 1000]
      );
      user = await db.get('SELECT * FROM users WHERE id = ?', id);
    }
    res.json(user);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/leaderboard', async (req, res) => {
  try {
    const leaderboard = await db.all(`
      SELECT first_name, username, (total_win - total_bet) as profit, balance
      FROM users 
      WHERE total_bet > 0 OR total_win > 0
      ORDER BY profit DESC 
      LIMIT 10
    `);
    res.json(leaderboard);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/cases', async (req, res) => {
  try {
    const cases = await db.all('SELECT * FROM cases');
    res.json(cases);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==================== ГРА КРАШ ====================
let gameState = {
  status: 'waiting',        // waiting, running, crashed
  multiplier: 1.00,
  crashPoint: 1.00,
  timeUntilStart: 8,
  players: [],
  history: [1.20, 1.64, 2.99, 20.19, 1.65, 1.00, 1.17, 1.00, 1.15]
};

function generateCrashPoint() {
  const houseEdge = 5; // 5% перевага казино
  const r = Math.random();
  if (r * 100 < houseEdge) {
    return 1.0 + Math.random(); // 1.0 - 2.0
  } else {
    return 1.0 + Math.random() * 9; // 1.0 - 10.0
  }
}

async function gameLoop() {
  while (true) {
    // Режим очікування
    gameState.status = 'waiting';
    gameState.timeUntilStart = 8;
    for (let i = 8; i > 0; i--) {
      gameState.timeUntilStart = i;
      io.emit('gameState', gameState);
      await new Promise(r => setTimeout(r, 1000));
    }

    // Старт раунду
    gameState.status = 'running';
    gameState.multiplier = 1.00;
    gameState.crashPoint = generateCrashPoint();
    io.emit('gameState', gameState);

    // Збільшуємо множник
    let currentMulti = 1.00;
    while (currentMulti < gameState.crashPoint) {
      await new Promise(r => setTimeout(r, 100));
      currentMulti += 0.05;
      gameState.multiplier = currentMulti;
      io.emit('gameState', gameState);
    }

    // Вибух
    gameState.status = 'crashed';
    io.emit('gameState', gameState);

    // Зберігаємо в історію
    try {
      await db.run(
        'INSERT INTO game_history (crash_point, players_count) VALUES (?, ?)',
        [gameState.crashPoint, gameState.players.length]
      );
    } catch (e) { console.error('Помилка збереження історії:', e); }

    // Додаємо в локальну історію
    gameState.history.unshift(gameState.crashPoint);
    if (gameState.history.length > 9) gameState.history.pop();

    // Чекаємо 3 секунди перед наступним раундом
    await new Promise(r => setTimeout(r, 3000));
    gameState.players = [];
  }
}
gameLoop().catch(console.error);

// ==================== WEB SOCKET ПОДІЇ ====================
io.on('connection', (socket) => {
  console.log('🔌 Гравець підключився:', socket.id);
  socket.emit('gameState', gameState);

  // Ставка
  socket.on('placeBet', async ({ userId, amount }) => {
    try {
      const user = await db.get('SELECT * FROM users WHERE id = ?', userId);
      if (!user) return socket.emit('notification', { type: 'error', message: 'Користувача не знайдено' });
      if (user.banned_until > Math.floor(Date.now() / 1000))
        return socket.emit('notification', { type: 'error', message: 'Ви забанені' });
      if (user.balance < amount)
        return socket.emit('notification', { type: 'error', message: 'Недостатньо коштів' });
      if (gameState.status !== 'waiting')
        return socket.emit('notification', { type: 'error', message: 'Зараз не можна ставити' });

      // Знімаємо гроші
      await db.run('UPDATE users SET balance = balance - ? WHERE id = ?', [amount, userId]);

      gameState.players.push({
        userId,
        username: user.first_name || user.username || 'Гравець',
        betAmount: amount,
        cashedOut: false,
        cashedAt: null
      });

      io.emit('gameState', gameState);
      socket.emit('notification', { type: 'success', message: 'Ставку прийнято' });
    } catch (error) {
      console.error('Помилка ставки:', error);
    }
  });

  // Вивід
  socket.on('cashOut', async ({ userId }) => {
    try {
      if (gameState.status !== 'running')
        return socket.emit('notification', { type: 'error', message: 'Зараз не можна вивести' });

      const player = gameState.players.find(p => p.userId === userId);
      if (!player || player.cashedOut)
        return socket.emit('notification', { type: 'error', message: 'Ставка не знайдена або вже виведена' });

      player.cashedOut = true;
      player.cashedAt = gameState.multiplier;

      const winAmount = Math.floor(player.betAmount * gameState.multiplier);

      await db.run(
        'UPDATE users SET balance = balance + ?, total_bet = total_bet + ?, total_win = total_win + ? WHERE id = ?',
        [winAmount, player.betAmount, winAmount, userId]
      );

      socket.emit('cashOutSuccess', { winAmount });
      socket.emit('notification', { type: 'success', message: `Ви виграли ${winAmount} монет!` });
      io.emit('gameState', gameState);
    } catch (error) {
      console.error('Помилка виводу:', error);
    }
  });

  // Відкриття кейсу
  socket.on('openCase', async ({ userId, caseId }) => {
    try {
      const caseData = await db.get('SELECT * FROM cases WHERE id = ?', caseId);
      const user = await db.get('SELECT * FROM users WHERE id = ?', userId);
      if (!caseData || !user) return;

      // Перевірка на бан
      if (user.banned_until > Math.floor(Date.now() / 1000))
        return socket.emit('notification', { type: 'error', message: 'Ви забанені' });

      // Перевірка для безкоштовного кейсу
      if (caseData.is_free) {
        const lastOpen = await db.get(
          'SELECT opened_at FROM case_openings WHERE user_id = ? AND case_id = ? ORDER BY opened_at DESC LIMIT 1',
          [userId, caseId]
        );
        const now = Math.floor(Date.now() / 1000);
        if (lastOpen && (now - lastOpen.opened_at < caseData.cooldown)) {
          const remaining = caseData.cooldown - (now - lastOpen.opened_at);
          const minutes = Math.floor(remaining / 60);
          const seconds = remaining % 60;
          return socket.emit('notification', { type: 'error', message: `Зачекайте ${minutes}х ${seconds}с` });
        }
      } else {
        if (user.balance < caseData.price)
          return socket.emit('notification', { type: 'error', message: 'Недостатньо коштів' });
        await db.run('UPDATE users SET balance = balance - ? WHERE id = ?', [caseData.price, userId]);
      }

      // Отримуємо предмети кейсу
      const items = await db.all('SELECT * FROM case_items WHERE case_id = ?', caseId);
      if (!items.length) return socket.emit('notification', { type: 'error', message: 'Кейс порожній' });

      // Вибір виграшу згідно з шансами
      const totalChance = items.reduce((sum, i) => sum + i.chance, 0);
      let rand = Math.random() * totalChance;
      let selected = null;
      for (const item of items) {
        if (rand < item.chance) {
          selected = item;
          break;
        }
        rand -= item.chance;
      }
      if (!selected) return;

      const reward = Math.floor(selected.min_reward + Math.random() * (selected.max_reward - selected.min_reward));

      // Нараховуємо виграш
      await db.run('UPDATE users SET balance = balance + ? WHERE id = ?', [reward, userId]);
      await db.run(
        'INSERT INTO case_openings (user_id, case_id, reward) VALUES (?, ?, ?)',
        [userId, caseId, reward]
      );

      socket.emit('caseOpened', { reward, caseName: caseData.name });
      socket.emit('notification', { type: 'success', message: `Ви виграли ${reward} монет!` });
    } catch (error) {
      console.error('Помилка відкриття кейсу:', error);
    }
  });

  // ==================== АДМІН ПАНЕЛЬ ====================
  socket.on('adminGetUsers', async ({ adminId }) => {
    try {
      const admin = await db.get('SELECT role FROM users WHERE id = ?', adminId);
      if (!admin || admin.role === 'user') return;
      const users = await db.all('SELECT id, username, first_name, balance, role, banned_until, muted_until FROM users ORDER BY role DESC, balance DESC');
      socket.emit('adminUsersList', users);
    } catch (error) {
      console.error('adminGetUsers error:', error);
    }
  });

  socket.on('adminSetBalance', async ({ adminId, userId, balance }) => {
    try {
      const admin = await db.get('SELECT role FROM users WHERE id = ?', adminId);
      if (!admin || (admin.role !== 'moderator' && admin.role !== 'owner' && admin.role !== 'helper'))
        return socket.emit('notification', { type: 'error', message: 'Недостатньо прав' });
      await db.run('UPDATE users SET balance = ? WHERE id = ?', [balance, userId]);
      socket.emit('notification', { type: 'success', message: 'Баланс оновлено' });
      io.emit('adminUsersUpdated');
    } catch (error) {
      console.error('adminSetBalance error:', error);
    }
  });

  socket.on('adminSetRole', async ({ adminId, userId, role }) => {
    try {
      const admin = await db.get('SELECT role FROM users WHERE id = ?', adminId);
      if (!admin || admin.role !== 'owner')
        return socket.emit('notification', { type: 'error', message: 'Тільки власник' });
      await db.run('UPDATE users SET role = ? WHERE id = ?', [role, userId]);
      socket.emit('notification', { type: 'success', message: 'Роль оновлено' });
      io.emit('adminUsersUpdated');
    } catch (error) {
      console.error('adminSetRole error:', error);
    }
  });

  socket.on('adminBan', async ({ adminId, userId, hours }) => {
    try {
      const admin = await db.get('SELECT role FROM users WHERE id = ?', adminId);
      if (!admin || (admin.role !== 'moderator' && admin.role !== 'owner'))
        return socket.emit('notification', { type: 'error', message: 'Недостатньо прав' });
      const bannedUntil = Math.floor(Date.now() / 1000) + hours * 3600;
      await db.run('UPDATE users SET banned_until = ? WHERE id = ?', [bannedUntil, userId]);
      socket.emit('notification', { type: 'success', message: `Користувача забанено на ${hours} год.` });
      io.emit('adminUsersUpdated');
    } catch (error) {
      console.error('adminBan error:', error);
    }
  });

  socket.on('adminMute', async ({ adminId, userId, hours }) => {
    try {
      const admin = await db.get('SELECT role FROM users WHERE id = ?', adminId);
      if (!admin || (admin.role !== 'moderator' && admin.role !== 'owner' && admin.role !== 'helper'))
        return socket.emit('notification', { type: 'error', message: 'Недостатньо прав' });
      const mutedUntil = Math.floor(Date.now() / 1000) + hours * 3600;
      await db.run('UPDATE users SET muted_until = ? WHERE id = ?', [mutedUntil, userId]);
      socket.emit('notification', { type: 'success', message: `Користувача замучено на ${hours} год.` });
      io.emit('adminUsersUpdated');
    } catch (error) {
      console.error('adminMute error:', error);
    }
  });

  socket.on('adminUnban', async ({ adminId, userId }) => {
    try {
      const admin = await db.get('SELECT role FROM users WHERE id = ?', adminId);
      if (!admin || (admin.role !== 'moderator' && admin.role !== 'owner'))
        return socket.emit('notification', { type: 'error', message: 'Недостатньо прав' });
      await db.run('UPDATE users SET banned_until = 0 WHERE id = ?', [userId]);
      socket.emit('notification', { type: 'success', message: 'Користувача розбанено' });
      io.emit('adminUsersUpdated');
    } catch (error) {
      console.error('adminUnban error:', error);
    }
  });

  socket.on('adminForceCrash', async ({ adminId }) => {
    try {
      const admin = await db.get('SELECT role FROM users WHERE id = ?', adminId);
      if (!admin || (admin.role !== 'moderator' && admin.role !== 'owner'))
        return socket.emit('notification', { type: 'error', message: 'Недостатньо прав' });
      gameState.status = 'crashed';
      io.emit('gameState', gameState);
      socket.emit('notification', { type: 'success', message: 'Примусовий вибух' });
    } catch (error) {
      console.error('adminForceCrash error:', error);
    }
  });
});

// ==================== СТВОРЕННЯ PUBLIC ТА INDEX.HTML ====================
const publicDir = path.join(__dirname, 'public');
if (!fs.existsSync(publicDir)) fs.mkdirSync(publicDir, { recursive: true });

const htmlContent = `<!DOCTYPE html>
<html lang="uk">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <title>Crash Game</title>
    <script src="https://telegram.org/js/telegram-web-app.js"></script>
    <script src="/socket.io/socket.io.js"></script>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
        }
        body { background: #0a0c17; color: white; min-height: 100vh; }
        .container { max-width: 500px; margin: 0 auto; padding: 16px; position: relative; }
        
        /* Сповіщення */
        #notification {
            position: fixed; top: 20px; left: 50%; transform: translateX(-50%);
            background: #1a1f33; color: white; padding: 12px 24px; border-radius: 30px;
            font-size: 14px; font-weight: 500; z-index: 1000;
            box-shadow: 0 4px 12px rgba(0,0,0,0.3); display: none;
            border-left: 4px solid; max-width: 90%; text-align: center;
        }
        .notification.success { border-left-color: #4caf50; }
        .notification.error { border-left-color: #f44336; }
        .notification.info { border-left-color: #2196f3; }

        /* Шапка */
        .header {
            display: flex; justify-content: space-between; align-items: center;
            margin-bottom: 16px; background: #151a2c; padding: 12px; border-radius: 20px;
        }
        .user-info { display: flex; align-items: center; gap: 12px; }
        .user-avatar {
            width: 48px; height: 48px; border-radius: 50%;
            background: linear-gradient(135deg, #667eea, #764ba2);
            display: flex; align-items: center; justify-content: center;
            font-weight: bold; font-size: 20px; color: white;
        }
        .user-details { display: flex; flex-direction: column; }
        .user-name { font-weight: 600; font-size: 16px; }
        .user-username { font-size: 13px; color: #888; }
        .balance {
            background: #2a2f45; padding: 8px 16px; border-radius: 30px;
            font-weight: bold; color: #4caf50; font-size: 18px;
        }

        /* Навігація */
        .nav {
            display: flex; background: #151a2c; border-radius: 30px; padding: 4px; margin-bottom: 20px;
        }
        .nav-item {
            flex: 1; text-align: center; padding: 10px; border-radius: 26px;
            font-weight: 600; font-size: 14px; color: #888; cursor: pointer;
        }
        .nav-item.active { background: #2a2f45; color: white; }

        /* Історія */
        .history {
            display: flex; gap: 8px; overflow-x: auto; padding: 8px 0; margin-bottom: 16px;
        }
        .history-item {
            background: #151a2c; padding: 6px 12px; border-radius: 20px;
            font-size: 14px; font-weight: 600; white-space: nowrap;
        }
        .history-item.green { color: #4caf50; }
        .history-item.red { color: #f44336; }
        .history-item.blue { color: #2196f3; }
        .history-item.orange { color: #ff9800; }

        /* Гра */
        .game-area {
            background: #151a2c; border-radius: 24px; padding: 20px; margin-bottom: 20px;
        }
        .multiplier {
            font-size: 72px; font-weight: bold; text-align: center; line-height: 1; margin-bottom: 8px;
        }
        .multiplier.running { color: #4caf50; text-shadow: 0 0 20px rgba(76,175,80,0.3); }
        .multiplier.crashed { color: #f44336; }
        .game-status { text-align: center; font-size: 16px; color: #888; margin-bottom: 20px; }

        /* Графік */
        .chart-container {
            background: #0a0c17; border-radius: 16px; padding: 20px; margin-bottom: 20px; height: 200px;
        }
        #gameCanvas { width: 100%; height: 100%; display: block; }

        /* Ставки */
        .bets-info {
            display: flex; justify-content: space-between; margin-bottom: 12px; font-size: 14px; color: #888;
        }
        .bets-count { color: #4caf50; font-weight: bold; }
        .players-bets {
            background: #0a0c17; border-radius: 12px; padding: 8px; margin-bottom: 16px;
            max-height: 100px; overflow-y: auto;
        }
        .player-bet {
            display: flex; justify-content: space-between; padding: 4px 8px;
            font-size: 13px; border-bottom: 1px solid #1a1f33;
        }
        .player-bet:last-child { border-bottom: none; }

        /* Панель ставок */
        .bet-panel {
            background: #0a0c17; border-radius: 30px; padding: 12px; display: flex; gap: 12px; margin-bottom: 12px;
        }
        .bet-input {
            flex: 1; background: #151a2c; border: none; border-radius: 24px; padding: 12px 20px;
            color: white; font-size: 18px; font-weight: bold; text-align: center;
        }
        .bet-input:focus { outline: 2px solid #4caf50; }
        .bet-button {
            background: #4caf50; border: none; border-radius: 24px; padding: 12px 24px;
            color: white; font-weight: bold; font-size: 16px; cursor: pointer;
        }
        .bet-button:disabled { opacity: 0.5; cursor: not-allowed; }
        .cashout-button {
            background: #ff9800; border: none; border-radius: 24px; padding: 16px;
            color: white; font-weight: bold; font-size: 18px; width: 100%; cursor: pointer; margin-bottom: 16px;
        }
        .quick-bets { display: flex; gap: 8px; margin-bottom: 12px; }
        .quick-bet {
            flex: 1; background: #151a2c; border: none; border-radius: 20px; padding: 10px;
            color: white; font-weight: 600; font-size: 14px; cursor: pointer;
        }
        .auto-cashout {
            display: flex; align-items: center; gap: 8px; margin-bottom: 12px; color: #888; font-size: 14px;
        }
        .auto-cashout input {
            background: #151a2c; border: none; border-radius: 16px; padding: 8px 12px;
            color: white; width: 80px; text-align: center;
        }
        .how-to-play {
            background: #151a2c; border-radius: 16px; padding: 12px; margin-top: 16px;
        }
        .how-to-play h3 { font-size: 14px; color: #888; margin-bottom: 8px; }
        .how-to-play p { font-size: 12px; color: #aaa; line-height: 1.4; }

        /* Кейси */
        .cases-grid {
            display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 20px;
        }
        .case-card {
            background: #151a2c; border-radius: 16px; padding: 16px; text-align: center; cursor: pointer;
        }
        .case-icon { font-size: 40px; margin-bottom: 8px; }
        .case-name { font-weight: bold; margin-bottom: 4px; }
        .case-price { color: #4caf50; font-weight: 600; font-size: 14px; }
        .case-free { background: #ff9800; color: black; padding: 4px 8px; border-radius: 12px; font-size: 12px; margin-top: 8px; display: inline-block; }

        /* Адмін панель */
        .admin-panel {
            background: #151a2c; border-radius: 24px; padding: 20px; margin-top: 20px;
        }
        .admin-header {
            display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px;
        }
        .admin-title { font-size: 20px; font-weight: bold; color: gold; }
        .admin-level {
            background: #0a0c17; padding: 6px 12px; border-radius: 20px; font-size: 12px; font-weight: 600;
        }
        .level-owner { color: gold; }
        .level-moderator { color: #2196f3; }
        .level-helper { color: #4caf50; }
        .admin-search {
            background: #0a0c17; border: none; border-radius: 20px; padding: 12px; width: 100%;
            color: white; margin-bottom: 20px;
        }
        .admin-tabs {
            display: flex; gap: 8px; margin-bottom: 20px;
        }
        .admin-tab {
            flex: 1; background: #0a0c17; border: none; border-radius: 20px; padding: 10px;
            color: #888; font-weight: 600; cursor: pointer;
        }
        .admin-tab.active { background: gold; color: black; }
        .admin-user-card {
            background: #0a0c17; border-radius: 16px; padding: 16px; margin-bottom: 12px;
        }
        .admin-user-header {
            display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;
        }
        .admin-user-name { font-weight: bold; }
        .admin-user-role {
            padding: 4px 8px; border-radius: 12px; font-size: 11px; font-weight: 600;
        }
        .role-badge-owner { background: gold; color: black; }
        .role-badge-moderator { background: #2196f3; color: white; }
        .role-badge-helper { background: #4caf50; color: white; }
        .role-badge-user { background: #2a2f45; color: #888; }
        .admin-controls {
            display: grid; grid-template-columns: repeat(2, 1fr); gap: 8px;
        }
        .admin-control {
            padding: 10px; border: none; border-radius: 8px; color: white;
            font-weight: 600; cursor: pointer; font-size: 13px;
        }
        .admin-control.green { background: #2e7d32; }
        .admin-control.red { background: #c62828; }
        .admin-control.blue { background: #1565c0; }
        .admin-control.purple { background: #6a1b9a; }

        /* Лідерборд */
        .leaderboard-panel {
            background: #151a2c; border-radius: 24px; padding: 20px;
        }
        .leaderboard-item {
            display: flex; align-items: center; gap: 12px; padding: 10px 0; border-bottom: 1px solid #2a2f45;
        }
        .leaderboard-rank {
            width: 30px; height: 30px; background: #0a0c17; border-radius: 50%;
            display: flex; align-items: center; justify-content: center; font-weight: bold;
        }
        .rank-1 { color: gold; }
        .rank-2 { color: silver; }
        .rank-3 { color: #cd7f32; }
        .leaderboard-info { flex: 1; }
        .leaderboard-name { font-weight: 600; }
        .leaderboard-profit { color: #4caf50; font-weight: bold; font-size: 14px; }

        .tab-content { display: none; }
        .tab-content.active { display: block; }
    </style>
</head>
<body>
    <div class="container">
        <div id="notification"></div>

        <!-- Шапка -->
        <div class="header">
            <div class="user-info">
                <div class="user-avatar" id="userAvatar"></div>
                <div class="user-details">
                    <div class="user-name" id="userName">Завантаження...</div>
                    <div class="user-username" id="userUsername">@username</div>
                </div>
            </div>
            <div class="balance" id="balance">1000</div>
        </div>

        <!-- Навігація -->
        <div class="nav">
            <div class="nav-item active" onclick="switchTab('game')">🎮 Гра</div>
            <div class="nav-item" onclick="switchTab('cases')">📦 Кейси</div>
            <div class="nav-item" onclick="switchTab('leaderboard')">🏆 Топ</div>
            <div class="nav-item" id="adminNavItem" style="display: none;" onclick="switchTab('admin')">⚙️ Адмін</div>
        </div>

        <!-- Вкладка ГРИ -->
        <div id="gameTab" class="tab-content active">
            <div class="history" id="historyContainer"></div>
            <div class="game-area">
                <div class="multiplier" id="multiplier">1.00x</div>
                <div class="game-status" id="gameStatus">Зробіть ставку</div>
                <div class="chart-container">
                    <canvas id="gameCanvas" width="400" height="180"></canvas>
                </div>
                <div class="bets-info">
                    <span>СТАВКИ: <span class="bets-count" id="betsCount">0</span></span>
                    <span id="totalBets">0</span>
                </div>
                <div class="players-bets" id="playersBets"></div>
                <div class="bet-panel">
                    <input type="number" class="bet-input" id="betAmount" value="50" min="1" placeholder="50">
                    <button class="bet-button" id="placeBetBtn">Поставити</button>
                </div>
                <button class="cashout-button" id="cashoutBtn" style="display: none;">💰 ЗАБРАТИ</button>
                <div class="quick-bets">
                    <button class="quick-bet" onclick="setBet(50)">50</button>
                    <button class="quick-bet" onclick="setBet(100)">100</button>
                    <button class="quick-bet" onclick="setBet(250)">250</button>
                    <button class="quick-bet" onclick="setBet(500)">500</button>
                </div>
                <div class="auto-cashout">
                    <span>Авто (напр.</span>
                    <input type="number" id="autoCashout" value="2.0" step="0.1" min="1.1">
                    <span>x)</span>
                </div>
                <div class="how-to-play">
                    <h3>Як грати</h3>
                    <p>• Роби ставку під час фази ставок<br>• Множник росте: 1.00x → 2x → 10x ...<br>• Натисни «Забрати» поки не пізно!<br>• Не встиг — втрачаєш ставку</p>
                </div>
            </div>
        </div>

        <!-- Вкладка КЕЙСИ -->
        <div id="casesTab" class="tab-content">
            <div class="cases-grid" id="casesGrid"></div>
        </div>

        <!-- Вкладка ЛІДЕРБОРД -->
        <div id="leaderboardTab" class="tab-content">
            <div class="leaderboard-panel">
                <h3 style="margin-bottom: 16px; color: gold;">🏆 Топ гравців</h3>
                <div id="leaderboardList"></div>
            </div>
        </div>

        <!-- Вкладка АДМІНКИ -->
        <div id="adminTab" class="tab-content">
            <div class="admin-panel">
                <div class="admin-header">
                    <div class="admin-title">🔧 Адмін панель</div>
                    <div class="admin-level" id="adminLevel">OWNER</div>
                </div>
                <input type="text" class="admin-search" id="adminSearch" placeholder="🔍 Пошук користувача...">
                <div class="admin-tabs">
                    <button class="admin-tab active" onclick="showAdminTab('users')">👥 Користувачі</button>
                    <button class="admin-tab" onclick="showAdminTab('game')">🎮 Гра</button>
                </div>
                <div id="adminUsersTab" class="admin-tab-content" style="display: block;">
                    <div id="adminUsersList"></div>
                </div>
                <div id="adminGameTab" class="admin-tab-content" style="display: none;">
                    <div class="admin-user-card">
                        <h3 style="margin-bottom: 12px;">🎰 Параметри крашу</h3>
                        <div class="admin-slider">
                            <span>Мін. множник</span>
                            <input type="range" id="minCrash" min="1.0" max="2.0" step="0.1" value="1.1">
                            <span class="admin-slider-value" id="minCrashValue">1.1x</span>
                        </div>
                        <div class="admin-slider">
                            <span>Макс. множник</span>
                            <input type="range" id="maxCrash" min="2.0" max="20.0" step="0.5" value="10.0">
                            <span class="admin-slider-value" id="maxCrashValue">10.0x</span>
                        </div>
                        <div class="admin-slider">
                            <span>Перевага казино</span>
                            <input type="range" id="houseEdge" min="0" max="20" step="1" value="5">
                            <span class="admin-slider-value" id="houseEdgeValue">5%</span>
                        </div>
                        <button class="admin-control red" onclick="forceCrash()" style="width: 100%; margin-top: 8px;">💥 ПРИМУСОВИЙ ВИБУХ</button>
                    </div>
                </div>
            </div>
        </div>
    </div>

    <script>
        const tg = window.Telegram.WebApp;
        tg.ready();
        tg.expand();

        const socket = io();
        const user = tg.initDataUnsafe?.user || { 
            id: ${OWNER_ID}, 
            username: 'vladyslav_owner',
            first_name: 'Владислав'
        };

        let currentBalance = 1000;
        let activeBet = null;
        let userRole = 'user';
        let autoCashout = 2.0;

        // Сповіщення
        function showNotification(message, type = 'info') {
            const notif = document.getElementById('notification');
            notif.textContent = message;
            notif.className = 'notification ' + type;
            notif.style.display = 'block';
            setTimeout(() => notif.style.display = 'none', 3000);
        }

        // Оновлення інформації користувача
        function updateUserInfo(userData) {
            document.getElementById('userName').textContent = userData.first_name || 'Гравець';
            document.getElementById('userUsername').textContent = userData.username ? '@' + userData.username : '';
            document.getElementById('userAvatar').textContent = (userData.first_name || '?').charAt(0).toUpperCase();
            document.getElementById('balance').textContent = userData.balance + ' монет';
            currentBalance = userData.balance;
            userRole = userData.role;

            if (userRole !== 'user') {
                document.getElementById('adminNavItem').style.display = 'block';
                document.getElementById('adminLevel').textContent = userRole.toUpperCase();
            } else {
                document.getElementById('adminNavItem').style.display = 'none';
            }
        }

        // Історія крашу
        function updateHistory(history) {
            const container = document.getElementById('historyContainer');
            container.innerHTML = history.map(h => {
                let color = 'green';
                if (h >= 10) color = 'orange';
                else if (h >= 5) color = 'blue';
                else if (h < 1.1) color = 'red';
                return \`<div class="history-item \${color}">\${h.toFixed(2)}x</div>\`;
            }).join('');
        }

        // Перемикання вкладок
        function switchTab(tab) {
            document.querySelectorAll('.nav-item').forEach(t => t.classList.remove('active'));
            event.target.classList.add('active');
            document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
            document.getElementById(tab + 'Tab').classList.add('active');
            if (tab === 'cases') loadCases();
            if (tab === 'leaderboard') loadLeaderboard();
            if (tab === 'admin') loadAdminUsers();
        }

        // Швидкі ставки
        window.setBet = (amount) => document.getElementById('betAmount').value = amount;

        // Автовивід
        document.getElementById('autoCashout').addEventListener('change', (e) => {
            autoCashout = parseFloat(e.target.value);
        });

        // Гра
        const canvas = document.getElementById('gameCanvas');
        const ctx = canvas.getContext('2d');

        socket.on('gameState', (state) => {
            document.getElementById('multiplier').textContent = state.multiplier.toFixed(2) + 'x';
            document.getElementById('multiplier').className = 'multiplier ' + state.status;

            if (state.status === 'waiting') {
                document.getElementById('gameStatus').textContent = \`Старт через: \${state.timeUntilStart}с\`;
                document.getElementById('placeBetBtn').disabled = false;
                document.getElementById('cashoutBtn').style.display = 'none';
            } else if (state.status === 'running') {
                document.getElementById('gameStatus').textContent = '🛫 Гра йде!';
                document.getElementById('placeBetBtn').disabled = true;
                if (activeBet) {
                    document.getElementById('cashoutBtn').style.display = 'block';
                    document.getElementById('cashoutBtn').textContent = \`💰 ЗАБРАТИ \${state.multiplier.toFixed(2)}x\`;
                    if (autoCashout > 0 && state.multiplier >= autoCashout) {
                        socket.emit('cashOut', { userId: user.id });
                    }
                }
            } else if (state.status === 'crashed') {
                document.getElementById('gameStatus').textContent = '💥 ВИБУХ!';
                document.getElementById('cashoutBtn').style.display = 'none';
                activeBet = null;
            }

            document.getElementById('betsCount').textContent = state.players.length;
            const playersHtml = state.players.map(p => \`
                <div class="player-bet">
                    <span>\${p.username}</span>
                    <span>\${p.betAmount} \${p.cashedOut ? '✅ ' + p.cashedAt.toFixed(2) + 'x' : ''}</span>
                </div>
            \`).join('');
            document.getElementById('playersBets').innerHTML = playersHtml || '<div class="player-bet">Немає ставок</div>';

            if (state.history) updateHistory(state.history);
            drawChart(state);
        });

        function drawChart(state) {
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            ctx.strokeStyle = '#2a2f45';
            ctx.lineWidth = 1;
            for (let i = 0; i <= 4; i++) {
                const y = canvas.height - (canvas.height / 4) * i;
                ctx.beginPath();
                ctx.moveTo(0, y);
                ctx.lineTo(canvas.width, y);
                ctx.stroke();
            }
            if (state.status === 'running') {
                const progress = Math.min(state.multiplier / 10, 1);
                const x = canvas.width * progress;
                const y = canvas.height - (canvas.height * progress * 0.7);
                ctx.beginPath();
                ctx.strokeStyle = '#4caf50';
                ctx.lineWidth = 3;
                ctx.moveTo(0, canvas.height);
                ctx.lineTo(x, y);
                ctx.stroke();
            }
        }

        document.getElementById('placeBetBtn').addEventListener('click', () => {
            const amount = parseInt(document.getElementById('betAmount').value);
            if (amount > currentBalance) {
                showNotification('Недостатньо коштів', 'error');
                return;
            }
            socket.emit('placeBet', { userId: user.id, amount });
            activeBet = { amount };
        });

        document.getElementById('cashoutBtn').addEventListener('click', () => {
            socket.emit('cashOut', { userId: user.id });
        });

        socket.on('cashOutSuccess', (data) => {
            showNotification(\`Ви виграли \${data.winAmount} монет!\`, 'success');
            activeBet = null;
            document.getElementById('cashoutBtn').style.display = 'none';
            loadUser();
        });

        socket.on('notification', (data) => {
            showNotification(data.message, data.type);
        });

        // Завантаження користувача
        async function loadUser() {
            try {
                const res = await fetch('/api/user', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ id: user.id, username: user.username, first_name: user.first_name })
                });
                const userData = await res.json();
                updateUserInfo(userData);
            } catch (error) {
                console.error('Помилка завантаження користувача:', error);
            }
        }

        // Кейси
        async function loadCases() {
            try {
                const res = await fetch('/api/cases');
                const cases = await res.json();
                const grid = document.getElementById('casesGrid');
                grid.innerHTML = cases.map(c => \`
                    <div class="case-card" onclick="openCase(\${c.id})">
                        <div class="case-icon">📦</div>
                        <div class="case-name">\${c.name}</div>
                        <div class="case-price">\${c.price} монет</div>
                        \${c.is_free ? '<div class="case-free">БЕЗКОШТОВНО</div>' : ''}
                    </div>
                \`).join('');
            } catch (error) {
                console.error('Помилка завантаження кейсів:', error);
            }
        }

        window.openCase = (caseId) => {
            socket.emit('openCase', { userId: user.id, caseId });
        };

        socket.on('caseOpened', (data) => {
            showNotification(\`Ви виграли \${data.reward} монет з кейсу "\${data.caseName}"!\`, 'success');
            loadUser();
        });

        // Лідерборд
        async function loadLeaderboard() {
            try {
                const res = await fetch('/api/leaderboard');
                const data = await res.json();
                const list = document.getElementById('leaderboardList');
                list.innerHTML = data.map((item, index) => {
                    const name = item.first_name || item.username || 'Гравець';
                    const profit = item.profit || 0;
                    return \`
                        <div class="leaderboard-item">
                            <div class="leaderboard-rank rank-\${index+1}">\${index+1}</div>
                            <div class="leaderboard-info">
                                <div class="leaderboard-name">\${name}</div>
                                <div class="leaderboard-profit">+\${profit} монет</div>
                            </div>
                        </div>
                    \`;
                }).join('');
            } catch (error) {
                console.error('Помилка лідерборду:', error);
            }
        }

        // Адмінка
        function showAdminTab(tab) {
            document.querySelectorAll('.admin-tab').forEach(t => t.classList.remove('active'));
            document.querySelectorAll('.admin-tab-content').forEach(c => c.style.display = 'none');
            event.target.classList.add('active');
            if (tab === 'users') {
                document.getElementById('adminUsersTab').style.display = 'block';
                loadAdminUsers();
            } else {
                document.getElementById('adminGameTab').style.display = 'block';
            }
        }

        function loadAdminUsers() {
            socket.emit('adminGetUsers', { adminId: user.id });
        }

        socket.on('adminUsersList', (users) => {
            const container = document.getElementById('adminUsersList');
            container.innerHTML = users.map(u => \`
                <div class="admin-user-card">
                    <div class="admin-user-header">
                        <span class="admin-user-name">\${u.first_name || u.username || 'Гравець'}</span>
                        <span class="admin-user-role role-badge-\${u.role}">\${u.role}</span>
                    </div>
                    <div class="admin-controls">
                        <button class="admin-control green" onclick="setBalance(\${u.id})">💰 \${u.balance}</button>
                        <button class="admin-control red" onclick="banUser(\${u.id})">🔨 Бан</button>
                        <button class="admin-control blue" onclick="muteUser(\${u.id})">🔇 Мут</button>
                        \${userRole === 'owner' ? \`
                            <select onchange="setRole(\${u.id}, this.value)" style="grid-column: span 2; padding: 8px; background: #151a2c; border: none; border-radius: 8px; color: white; margin-top: 8px;">
                                <option value="user" \${u.role === 'user' ? 'selected' : ''}>👤 Користувач</option>
                                <option value="helper" \${u.role === 'helper' ? 'selected' : ''}>🟢 Хелпер (рівень 1)</option>
                                <option value="moderator" \${u.role === 'moderator' ? 'selected' : ''}>🔵 Модератор (рівень 2)</option>
                                <option value="owner" \${u.role === 'owner' ? 'selected' : ''}>👑 Власник (рівень 3)</option>
                            </select>
                        \` : ''}
                        <button class="admin-control purple" onclick="unbanUser(\${u.id})" style="grid-column: span 2;">✅ Розбан</button>
                    </div>
                </div>
            \`).join('');
        });

        socket.on('adminUsersUpdated', () => {
            loadAdminUsers();
        });

        window.setBalance = (userId) => {
            const newBalance = prompt('Введіть новий баланс:');
            if (newBalance !== null) {
                socket.emit('adminSetBalance', { adminId: user.id, userId, balance: parseInt(newBalance) });
            }
        };

        window.setRole = (userId, role) => {
            socket.emit('adminSetRole', { adminId: user.id, userId, role });
        };

        window.banUser = (userId) => {
            const hours = prompt('Годин бану:', '24');
            if (hours !== null) {
                socket.emit('adminBan', { adminId: user.id, userId, hours: parseInt(hours) });
            }
        };

        window.muteUser = (userId) => {
            const hours = prompt('Годин муту:', '1');
            if (hours !== null) {
                socket.emit('adminMute', { adminId: user.id, userId, hours: parseInt(hours) });
            }
        };

        window.unbanUser = (userId) => {
            if (confirm('Розбанити користувача?')) {
                socket.emit('adminUnban', { adminId: user.id, userId });
            }
        };

        window.forceCrash = () => {
            if (confirm('Точно вибухнути?')) {
                socket.emit('adminForceCrash', { adminId: user.id });
            }
        };

        // Пошук в адмінці
        document.getElementById('adminSearch').addEventListener('input', (e) => {
            const search = e.target.value.toLowerCase();
            document.querySelectorAll('.admin-user-card').forEach(card => {
                const name = card.querySelector('.admin-user-name')?.textContent.toLowerCase() || '';
                card.style.display = name.includes(search) ? 'block' : 'none';
            });
        });

        // Слайдери
        ['minCrash', 'maxCrash', 'houseEdge'].forEach(id => {
            const el = document.getElementById(id);
            if (el) {
                el.addEventListener('input', (e) => {
                    document.getElementById(id + 'Value').textContent = e.target.value + (id === 'houseEdge' ? '%' : 'x');
                });
            }
        });

        loadUser();
    </script>
</body>
</html>`;

fs.writeFileSync(path.join(publicDir, 'index.html'), htmlContent);
console.log('✅ index.html створено');

// ==================== ЗАПУСК СЕРВЕРА ====================
server.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Сервер запущено на порту ${PORT}`);
  console.log(`✅ Твій ID: ${OWNER_ID} (ТИ ВЛАСНИК!)`);
  console.log(`✅ Відкрий в браузері: http://localhost:${PORT}`);
});

// Глобальний перехоплювач помилок
process.on('uncaughtException', (err) => console.error('❌ uncaughtException:', err));
process.on('unhandledRejection', (err) => console.error('❌ unhandledRejection:', err));
