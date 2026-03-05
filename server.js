const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const TelegramBot = require('node-telegram-bot-api');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');

// ТВІЙ ТОКЕН БОТА
const BOT_TOKEN = '8769585372:AAGDTdtfnbjX0XnqrMOrP99iQhygh4sGCKQ';
// ТВІЙ ID (ТИ ВЛАСНИК)
const OWNER_ID = 837614911;

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

app.use(cors());
app.use(express.json());

// ===========================================
// БАЗА ДАНИХ
// ===========================================
let db;

async function initDB() {
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
      name TEXT,
      price INTEGER,
      is_free INTEGER DEFAULT 0,
      cooldown INTEGER DEFAULT 3600
    );

    CREATE TABLE IF NOT EXISTS case_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      case_id INTEGER,
      min_reward INTEGER,
      max_reward INTEGER,
      chance INTEGER,
      FOREIGN KEY(case_id) REFERENCES cases(id)
    );

    CREATE TABLE IF NOT EXISTS game_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      crash_point REAL,
      players_count INTEGER,
      created_at INTEGER DEFAULT (strftime('%s', 'now'))
    );
  `);

  // Додаємо тебе як власника
  const existingUser = await db.get('SELECT id FROM users WHERE id = ?', OWNER_ID);
  if (!existingUser) {
    await db.run(
      'INSERT INTO users (id, username, first_name, balance, role) VALUES (?, ?, ?, ?, ?)',
      [OWNER_ID, 'vladyslav_owner', 'Владислав', 1000000, 'owner']
    );
    console.log('✅ Власника додано в базу');
  }

  // Додаємо безкоштовний кейс
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
}

initDB();

// ===========================================
// API
// ===========================================
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.post('/api/user', async (req, res) => {
  try {
    const { id, username, first_name } = req.body;
    let user = await db.get('SELECT * FROM users WHERE id = ?', id);
    
    if (!user) {
      await db.run(
        'INSERT INTO users (id, username, first_name, balance, role) VALUES (?, ?, ?, ?, ?)',
        [id, username || 'user', first_name || 'Гравець', 1000, 'user']
      );
      user = await db.get('SELECT * FROM users WHERE id = ?', id);
    }
    
    res.json(user);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ===========================================
// ТЕЛЕГРАМ БОТ
// ===========================================
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const username = msg.from.username || '';
  const firstName = msg.from.first_name || 'Гравець';

  try {
    let user = await db.get('SELECT * FROM users WHERE id = ?', userId);
    if (!user) {
      await db.run(
        'INSERT INTO users (id, username, first_name, balance, role) VALUES (?, ?, ?, ?, ?)',
        [userId, username, firstName, 1000, 'user']
      );
    }

    const webAppUrl = `https://${process.env.RAILWAY_STATIC_URL || 'localhost:3000'}`;
    
    await bot.sendMessage(chatId, '🎮 Ласкаво просимо до Crash Game!', {
      reply_markup: {
        inline_keyboard: [[
          {
            text: '🎰 ГРАТИ',
            web_app: { url: webAppUrl }
          }
        ]]
      }
    });
  } catch (error) {
    console.error('Помилка бота:', error);
  }
});

// ===========================================
// ГРА КРАШ
// ===========================================
let gameState = {
  status: 'waiting',
  multiplier: 1.00,
  crashPoint: 1.00,
  timeUntilStart: 8,
  players: [],
  history: [1.20, 1.64, 2.99, 20.19, 1.65, 1.00, 1.17, 1.00, 1.15]
};

function generateCrashPoint() {
  const houseEdge = 5;
  const random = Math.random();
  
  if (random * 100 < houseEdge) {
    return 1.0 + Math.random();
  } else {
    return 1.0 + Math.random() * 9;
  }
}

async function startGameLoop() {
  gameState.status = 'waiting';
  gameState.timeUntilStart = 8;
  
  for (let i = 8; i > 0; i--) {
    gameState.timeUntilStart = i;
    io.emit('gameState', gameState);
    await new Promise(r => setTimeout(r, 1000));
  }
  
  gameState.status = 'running';
  gameState.multiplier = 1.00;
  gameState.crashPoint = generateCrashPoint();
  
  io.emit('gameState', gameState);
  
  let currentMulti = 1.00;
  while (currentMulti < gameState.crashPoint && gameState.status === 'running') {
    await new Promise(r => setTimeout(r, 100));
    currentMulti += 0.05;
    gameState.multiplier = currentMulti;
    io.emit('gameState', gameState);
  }
  
  gameState.status = 'crashed';
  
  gameState.history.unshift(gameState.crashPoint);
  if (gameState.history.length > 9) {
    gameState.history.pop();
  }
  
  io.emit('gameState', gameState);
  
  await new Promise(r => setTimeout(r, 3000));
  gameState.players = [];
  startGameLoop();
}

// ===========================================
// WebSocket
// ===========================================
io.on('connection', (socket) => {
  console.log('Гравець підключився:', socket.id);
  socket.emit('gameState', gameState);
  
  socket.on('placeBet', async ({ userId, amount }) => {
    try {
      const user = await db.get('SELECT * FROM users WHERE id = ?', userId);
      
      if (!user || user.balance < amount) return;
      if (gameState.status !== 'waiting') return;
      if (user.banned_until > Math.floor(Date.now() / 1000)) return;
      
      await db.run('UPDATE users SET balance = balance - ? WHERE id = ?', [amount, userId]);
      
      gameState.players.push({
        userId,
        username: user.first_name || user.username || 'Гравець',
        betAmount: amount,
        cashedOut: false,
        cashedAt: null
      });
      
      io.emit('gameState', gameState);
    } catch (error) {
      console.error('Помилка ставки:', error);
    }
  });
  
  socket.on('cashOut', async ({ userId }) => {
    try {
      if (gameState.status !== 'running') return;
      
      const player = gameState.players.find(p => p.userId === userId);
      if (!player || player.cashedOut) return;
      
      player.cashedOut = true;
      player.cashedAt = gameState.multiplier;
      
      const winAmount = Math.floor(player.betAmount * gameState.multiplier);
      
      await db.run(
        'UPDATE users SET balance = balance + ?, total_bet = total_bet + ?, total_win = total_win + ? WHERE id = ?',
        [winAmount, player.betAmount, winAmount, userId]
      );
      
      socket.emit('cashOutSuccess', { winAmount });
      io.emit('gameState', gameState);
    } catch (error) {
      console.error('Помилка виводу:', error);
    }
  });
  
  // АДМІНКА
  socket.on('adminGetUsers', async ({ adminId }) => {
    try {
      const admin = await db.get('SELECT role FROM users WHERE id = ?', adminId);
      if (!admin || admin.role === 'user') return;
      
      const users = await db.all('SELECT id, username, first_name, balance, role, banned_until, muted_until FROM users ORDER BY role DESC, balance DESC LIMIT 100');
      socket.emit('adminUsersList', users);
    } catch (error) {
      console.error('Помилка отримання користувачів:', error);
    }
  });
  
  socket.on('adminSetBalance', async ({ adminId, userId, balance }) => {
    try {
      const admin = await db.get('SELECT role FROM users WHERE id = ?', adminId);
      if (!admin || (admin.role !== 'moderator' && admin.role !== 'owner' && admin.role !== 'helper')) return;
      
      await db.run('UPDATE users SET balance = ? WHERE id = ?', [balance, userId]);
      socket.emit('adminSuccess', 'Баланс оновлено');
    } catch (error) {
      console.error('Помилка зміни балансу:', error);
    }
  });
  
  socket.on('adminSetRole', async ({ adminId, userId, role }) => {
    try {
      const admin = await db.get('SELECT role FROM users WHERE id = ?', adminId);
      if (!admin || admin.role !== 'owner') return;
      
      await db.run('UPDATE users SET role = ? WHERE id = ?', [role, userId]);
      socket.emit('adminSuccess', 'Роль оновлено');
    } catch (error) {
      console.error('Помилка зміни ролі:', error);
    }
  });
  
  socket.on('adminBan', async ({ adminId, userId, hours }) => {
    try {
      const admin = await db.get('SELECT role FROM users WHERE id = ?', adminId);
      if (!admin || (admin.role !== 'moderator' && admin.role !== 'owner')) return;
      
      const bannedUntil = Math.floor(Date.now() / 1000) + (hours * 3600);
      await db.run('UPDATE users SET banned_until = ? WHERE id = ?', [bannedUntil, userId]);
      socket.emit('adminSuccess', `Користувача забанено на ${hours} годин`);
    } catch (error) {
      console.error('Помилка бану:', error);
    }
  });
  
  socket.on('adminMute', async ({ adminId, userId, hours }) => {
    try {
      const admin = await db.get('SELECT role FROM users WHERE id = ?', adminId);
      if (!admin || (admin.role !== 'moderator' && admin.role !== 'owner' && admin.role !== 'helper')) return;
      
      const mutedUntil = Math.floor(Date.now() / 1000) + (hours * 3600);
      await db.run('UPDATE users SET muted_until = ? WHERE id = ?', [mutedUntil, userId]);
      socket.emit('adminSuccess', `Користувача замучено на ${hours} годин`);
    } catch (error) {
      console.error('Помилка муту:', error);
    }
  });
  
  socket.on('adminUnban', async ({ adminId, userId }) => {
    try {
      const admin = await db.get('SELECT role FROM users WHERE id = ?', adminId);
      if (!admin || (admin.role !== 'moderator' && admin.role !== 'owner')) return;
      
      await db.run('UPDATE users SET banned_until = 0 WHERE id = ?', [userId]);
      socket.emit('adminSuccess', 'Користувача розбанено');
    } catch (error) {
      console.error('Помилка розбану:', error);
    }
  });
  
  socket.on('adminForceCrash', async ({ adminId }) => {
    try {
      const admin = await db.get('SELECT role FROM users WHERE id = ?', adminId);
      if (!admin || (admin.role !== 'moderator' && admin.role !== 'owner')) return;
      
      gameState.status = 'crashed';
      io.emit('gameState', gameState);
      socket.emit('adminSuccess', 'Примусовий вибух');
    } catch (error) {
      console.error('Помилка примусового вибуху:', error);
    }
  });
});

// ===========================================
// СТВОРЮЄМО PUBLIC ТА INDEX.HTML
// ===========================================
const publicDir = path.join(__dirname, 'public');
const fs = require('fs');

if (!fs.existsSync(publicDir)) {
  fs.mkdirSync(publicDir, { recursive: true });
}

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
        
        body {
            background: #0a0c17;
            color: white;
            min-height: 100vh;
        }
        
        .container {
            max-width: 500px;
            margin: 0 auto;
            padding: 16px;
        }
        
        /* Шапка */
        .header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 16px;
            background: #151a2c;
            padding: 12px;
            border-radius: 20px;
        }
        
        .user-info {
            display: flex;
            align-items: center;
            gap: 12px;
        }
        
        .user-avatar {
            width: 48px;
            height: 48px;
            border-radius: 50%;
            background: linear-gradient(135deg, #667eea, #764ba2);
            display: flex;
            align-items: center;
            justify-content: center;
            font-weight: bold;
            font-size: 20px;
            color: white;
        }
        
        .user-details {
            display: flex;
            flex-direction: column;
        }
        
        .user-name {
            font-weight: 600;
            font-size: 16px;
        }
        
        .user-username {
            font-size: 13px;
            color: #888;
        }
        
        .balance {
            background: #2a2f45;
            padding: 8px 16px;
            border-radius: 30px;
            font-weight: bold;
            color: #4caf50;
            font-size: 18px;
        }
        
        /* Навігація */
        .nav {
            display: flex;
            background: #151a2c;
            border-radius: 30px;
            padding: 4px;
            margin-bottom: 20px;
        }
        
        .nav-item {
            flex: 1;
            text-align: center;
            padding: 10px;
            border-radius: 26px;
            font-weight: 600;
            font-size: 14px;
            color: #888;
            cursor: pointer;
            transition: all 0.2s;
        }
        
        .nav-item.active {
            background: #2a2f45;
            color: white;
        }
        
        /* Історія */
        .history {
            display: flex;
            gap: 8px;
            overflow-x: auto;
            padding: 8px 0;
            margin-bottom: 16px;
        }
        
        .history-item {
            background: #151a2c;
            padding: 6px 12px;
            border-radius: 20px;
            font-size: 14px;
            font-weight: 600;
            white-space: nowrap;
        }
        
        .history-item.green { color: #4caf50; }
        .history-item.red { color: #f44336; }
        .history-item.blue { color: #2196f3; }
        .history-item.orange { color: #ff9800; }
        
        /* Гра */
        .game-area {
            background: #151a2c;
            border-radius: 24px;
            padding: 20px;
            margin-bottom: 20px;
        }
        
        .multiplier {
            font-size: 72px;
            font-weight: bold;
            text-align: center;
            line-height: 1;
            margin-bottom: 8px;
        }
        
        .multiplier.running { color: #4caf50; text-shadow: 0 0 20px rgba(76, 175, 80, 0.3); }
        .multiplier.crashed { color: #f44336; }
        
        .game-status {
            text-align: center;
            font-size: 16px;
            color: #888;
            margin-bottom: 20px;
        }
        
        /* Графік */
        .chart-container {
            background: #0a0c17;
            border-radius: 16px;
            padding: 20px;
            margin-bottom: 20px;
            height: 200px;
            position: relative;
        }
        
        #gameCanvas {
            width: 100%;
            height: 100%;
            display: block;
        }
        
        /* Ставки */
        .bets-info {
            display: flex;
            justify-content: space-between;
            margin-bottom: 12px;
            font-size: 14px;
            color: #888;
        }
        
        .bets-count {
            color: #4caf50;
            font-weight: bold;
        }
        
        .players-bets {
            background: #0a0c17;
            border-radius: 12px;
            padding: 8px;
            margin-bottom: 16px;
            max-height: 100px;
            overflow-y: auto;
        }
        
        .player-bet {
            display: flex;
            justify-content: space-between;
            padding: 4px 8px;
            font-size: 13px;
            border-bottom: 1px solid #1a1f33;
        }
        
        .player-bet:last-child {
            border-bottom: none;
        }
        
        /* Панель ставок */
        .bet-panel {
            background: #0a0c17;
            border-radius: 30px;
            padding: 12px;
            display: flex;
            gap: 12px;
            margin-bottom: 12px;
        }
        
        .bet-input {
            flex: 1;
            background: #151a2c;
            border: none;
            border-radius: 24px;
            padding: 12px 20px;
            color: white;
            font-size: 18px;
            font-weight: bold;
            text-align: center;
        }
        
        .bet-input:focus {
            outline: 2px solid #4caf50;
        }
        
        .bet-button {
            background: #4caf50;
            border: none;
            border-radius: 24px;
            padding: 12px 24px;
            color: white;
            font-weight: bold;
            font-size: 16px;
            cursor: pointer;
        }
        
        .bet-button:disabled {
            opacity: 0.5;
            cursor: not-allowed;
        }
        
        .cashout-button {
            background: #ff9800;
            border: none;
            border-radius: 24px;
            padding: 16px;
            color: white;
            font-weight: bold;
            font-size: 18px;
            width: 100%;
            cursor: pointer;
            margin-bottom: 16px;
        }
        
        .quick-bets {
            display: flex;
            gap: 8px;
            margin-bottom: 12px;
        }
        
        .quick-bet {
            flex: 1;
            background: #151a2c;
            border: none;
            border-radius: 20px;
            padding: 10px;
            color: white;
            font-weight: 600;
            font-size: 14px;
            cursor: pointer;
        }
        
        .auto-cashout {
            display: flex;
            align-items: center;
            gap: 8px;
            margin-bottom: 12px;
            color: #888;
            font-size: 14px;
        }
        
        .auto-cashout input {
            background: #151a2c;
            border: none;
            border-radius: 16px;
            padding: 8px 12px;
            color: white;
            width: 80px;
            text-align: center;
        }
        
        .how-to-play {
            background: #151a2c;
            border-radius: 16px;
            padding: 12px;
            margin-top: 16px;
        }
        
        .how-to-play h3 {
            font-size: 14px;
            color: #888;
            margin-bottom: 8px;
        }
        
        .how-to-play p {
            font-size: 12px;
            color: #aaa;
            line-height: 1.4;
        }
        
        /* Адмін панель */
        .admin-panel {
            background: #151a2c;
            border-radius: 24px;
            padding: 20px;
            margin-top: 20px;
        }
        
        .admin-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 20px;
        }
        
        .admin-title {
            font-size: 20px;
            font-weight: bold;
            color: gold;
        }
        
        .admin-level {
            background: #0a0c17;
            padding: 6px 12px;
            border-radius: 20px;
            font-size: 12px;
            font-weight: 600;
        }
        
        .level-owner { color: gold; }
        .level-moderator { color: #2196f3; }
        .level-helper { color: #4caf50; }
        
        .admin-search {
            background: #0a0c17;
            border: none;
            border-radius: 20px;
            padding: 12px;
            width: 100%;
            color: white;
            margin-bottom: 20px;
        }
        
        .admin-tabs {
            display: flex;
            gap: 8px;
            margin-bottom: 20px;
        }
        
        .admin-tab {
            flex: 1;
            background: #0a0c17;
            border: none;
            border-radius: 20px;
            padding: 10px;
            color: #888;
            font-weight: 600;
            cursor: pointer;
        }
        
        .admin-tab.active {
            background: gold;
            color: black;
        }
        
        .admin-user-card {
            background: #0a0c17;
            border-radius: 16px;
            padding: 16px;
            margin-bottom: 12px;
        }
        
        .admin-user-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 12px;
        }
        
        .admin-user-name {
            font-weight: bold;
        }
        
        .admin-user-role {
            padding: 4px 8px;
            border-radius: 12px;
            font-size: 11px;
            font-weight: 600;
        }
        
        .role-badge-owner { background: gold; color: black; }
        .role-badge-moderator { background: #2196f3; color: white; }
        .role-badge-helper { background: #4caf50; color: white; }
        .role-badge-user { background: #2a2f45; color: #888; }
        
        .admin-controls {
            display: grid;
            grid-template-columns: repeat(2, 1fr);
            gap: 8px;
        }
        
        .admin-control {
            padding: 10px;
            border: none;
            border-radius: 8px;
            color: white;
            font-weight: 600;
            cursor: pointer;
            font-size: 13px;
        }
        
        .admin-control.green { background: #2e7d32; }
        .admin-control.red { background: #c62828; }
        .admin-control.blue { background: #1565c0; }
        .admin-control.purple { background: #6a1b9a; }
        
        .admin-slider {
            display: flex;
            align-items: center;
            gap: 8px;
            margin-bottom: 12px;
        }
        
        .admin-slider input[type="range"] {
            flex: 1;
            height: 4px;
            -webkit-appearance: none;
            background: #2a2f45;
            border-radius: 2px;
        }
        
        .admin-slider input[type="range"]::-webkit-slider-thumb {
            -webkit-appearance: none;
            width: 20px;
            height: 20px;
            background: gold;
            border-radius: 50%;
            cursor: pointer;
        }
        
        .admin-slider-value {
            min-width: 50px;
            text-align: right;
            color: gold;
            font-weight: bold;
        }
        
        .game-tab, .admin-tab-content {
            display: none;
        }
        
        .game-tab.active, .admin-tab-content.active {
            display: block;
        }
    </style>
</head>
<body>
    <div class="container">
        <!-- Шапка з користувачем -->
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
            <div class="nav-item" onclick="switchTab('admin')" id="adminNavItem" style="display: none;">⚙️ Адмін</div>
        </div>
        
        <!-- Вкладка ГРИ -->
        <div id="gameTab" class="game-tab active">
            <!-- Історія крашу -->
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
                
                <div class="players-bets" id="playersBets">
                    <!-- Гравці -->
                </div>
                
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
        
        <!-- Вкладка АДМІНКИ -->
        <div id="adminTab" class="admin-tab-content">
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
                
                <!-- Користувачі -->
                <div id="adminUsersTab" class="admin-tab-content active">
                    <div id="adminUsersList"></div>
                </div>
                
                <!-- Керування грою -->
                <div id="adminGameTab" class="admin-tab-content">
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
        
        // Відображаємо інформацію про користувача
        function updateUserInfo(userData) {
            document.getElementById('userName').textContent = userData.first_name || 'Гравець';
            document.getElementById('userUsername').textContent = userData.username ? '@' + userData.username : '';
            document.getElementById('userAvatar').textContent = (userData.first_name || '?').charAt(0).toUpperCase();
            document.getElementById('balance').textContent = userData.balance + ' монет';
        }
        
        // Історія крашу
        function updateHistory(history) {
            const container = document.getElementById('historyContainer');
            if (!container) return;
            
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
            
            document.getElementById('gameTab').classList.remove('active');
            document.getElementById('adminTab').classList.remove('active');
            
            if (tab === 'game') {
                document.getElementById('gameTab').classList.add('active');
            } else if (tab === 'admin') {
                document.getElementById('adminTab').classList.add('active');
                loadAdminUsers();
            }
        }
        
        function showAdminTab(tab) {
            document.querySelectorAll('.admin-tab').forEach(t => t.classList.remove('active'));
            document.querySelectorAll('.admin-tab-content').forEach(c => c.classList.remove('active'));
            
            event.target.classList.add('active');
            document.getElementById('admin' + tab.charAt(0).toUpperCase() + tab.slice(1) + 'Tab').classList.add('active');
            
            if (tab === 'users') loadAdminUsers();
        }
        
        // Швидкі ставки
        function setBet(amount) {
            document.getElementById('betAmount').value = amount;
        }
        
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
                    
                    // Автовивід
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
            
            // Список гравців
            const playersHtml = state.players.map(p => \`
                <div class="player-bet">
                    <span>\${p.username}</span>
                    <span>\${p.betAmount} \${p.cashedOut ? '✅ ' + p.cashedAt.toFixed(2) + 'x' : ''}</span>
                </div>
            \`).join('');
            document.getElementById('playersBets').innerHTML = playersHtml || '<div class="player-bet">Немає ставок</div>';
            
            // Історія
            if (state.history) {
                updateHistory(state.history);
            }
            
            // Графік
            drawChart(state);
        });
        
        function drawChart(state) {
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            
            // Сітка
            ctx.strokeStyle = '#2a2f45';
            ctx.lineWidth = 1;
            ctx.beginPath();
            for (let i = 0; i <= 4; i++) {
                const y = canvas.height - (canvas.height / 4) * i;
                ctx.moveTo(0, y);
                ctx.lineTo(canvas.width, y);
            }
            ctx.stroke();
            
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
        
        // Ставка
        document.getElementById('placeBetBtn').addEventListener('click', () => {
            const amount = parseInt(document.getElementById('betAmount').value);
            socket.emit('placeBet', { userId: user.id, amount });
            activeBet = { amount };
        });
        
        // Вивід
        document.getElementById('cashoutBtn').addEventListener('click', () => {
            socket.emit('cashOut', { userId: user.id });
        });
        
        socket.on('cashOutSuccess', (data) => {
            alert(\`🎉 Ви виграли \${data.winAmount} монет!\`);
            activeBet = null;
            document.getElementById('cashoutBtn').style.display = 'none';
            loadUser();
        });
        
        // Завантаження користувача
        async function loadUser() {
            try {
                const res = await fetch('/api/user', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ 
                        id: user.id, 
                        username: user.username,
                        first_name: user.first_name 
                    })
                });
                const userData = await res.json();
                currentBalance = userData.balance;
                userRole = userData.role;
                
                updateUserInfo(userData);
                
                // Показуємо кнопку адмінки якщо є права
                if (userRole !== 'user') {
                    document.getElementById('adminNavItem').style.display = 'block';
                    document.getElementById('adminLevel').textContent = userRole.toUpperCase();
                }
            } catch (error) {
                console.error('Помилка:', error);
            }
        }
        
        // Адмінка - завантаження користувачів
        function loadAdminUsers() {
            socket.emit('adminGetUsers', { adminId: user.id });
        }
        
        socket.on('adminUsersList', (users) => {
            const container = document.getElementById('adminUsersList');
            if (!container) return;
            
            container.innerHTML = users.map(u => \`
                <div class="admin-user-card">
                    <div class="admin-user-header">
                        <span class="admin-user-name">\${u.first_name || u.username || 'Гравець'}</span>
                        <span class="admin-user-role role-badge-\${u.role}">\${u.role}</span>
                    </div>
                    
                    <div class="admin-controls">
                        <button class="admin-control green" onclick="setBalance(\${u.id}, prompt('Новий баланс:', \${u.balance}))">
                            💰 \${u.balance}
                        </button>
                        <button class="admin-control red" onclick="banUser(\${u.id}, prompt('Годин бану:', 24))">
                            🔨 Бан
                        </button>
                        <button class="admin-control blue" onclick="muteUser(\${u.id}, prompt('Годин муту:', 1))">
                            🔇 Мут
                        </button>
                        \${userRole === 'owner' ? \`
                            <select onchange="setRole(\${u.id}, this.value)" style="grid-column: span 2; padding: 8px; background: #151a2c; border: none; border-radius: 8px; color: white; margin-top: 8px;">
                                <option value="user" \${u.role === 'user' ? 'selected' : ''}>👤 Користувач</option>
                                <option value="helper" \${u.role === 'helper' ? 'selected' : ''}>🟢 Хелпер (рівень 1)</option>
                                <option value="moderator" \${u.role === 'moderator' ? 'selected' : ''}>🔵 Модератор (рівень 2)</option>
                                <option value="owner" \${u.role === 'owner' ? 'selected' : ''}>👑 Власник (рівень 3)</option>
                            </select>
                        \` : ''}
                    </div>
                </div>
            \`).join('');
        });
        
        // Функції адмінки
        window.setBalance = (userId, balance) => {
            if (balance) socket.emit('adminSetBalance', { adminId: user.id, userId, balance: parseInt(balance) });
        };
        
        window.setRole = (userId, role) => {
            socket.emit('adminSetRole', { adminId: user.id, userId, role });
        };
        
        window.banUser = (userId, hours) => {
            if (hours) socket.emit('adminBan', { adminId: user.id, userId, hours: parseInt(hours) });
        };
        
        window.muteUser = (userId, hours) => {
            if (hours) socket.emit('adminMute', { adminId: user.id, userId, hours: parseInt(hours) });
        };
        
        window.forceCrash = () => {
            if (confirm('Точно вибухнути?')) {
                socket.emit('adminForceCrash', { adminId: user.id });
            }
        };
        
        // Пошук
        document.getElementById('adminSearch')?.addEventListener('input', (e) => {
            const search = e.target.value.toLowerCase();
            document.querySelectorAll('.admin-user-card').forEach(card => {
                const name = card.querySelector('.admin-user-name')?.textContent.toLowerCase() || '';
                card.style.display = name.includes(search) ? 'block' : 'none';
            });
        });
        
        // Слайдери
        document.getElementById('minCrash')?.addEventListener('input', (e) => {
            document.getElementById('minCrashValue').textContent = e.target.value + 'x';
        });
        
        document.getElementById('maxCrash')?.addEventListener('input', (e) => {
            document.getElementById('maxCrashValue').textContent = e.target.value + 'x';
        });
        
        document.getElementById('houseEdge')?.addEventListener('input', (e) => {
            document.getElementById('houseEdgeValue').textContent = e.target.value + '%';
        });
        
        // Запуск
        loadUser();
    </script>
</body>
</html>`;

fs.writeFileSync(path.join(publicDir, 'index.html'), htmlContent);
console.log('✅ index.html створено');

// ===========================================
// ЗАПУСК
// ===========================================
startGameLoop();

const PORT = process.env.PORT || 8080;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Сервер запущено на порту ${PORT}`);
  console.log(`✅ Твій ID: ${OWNER_ID} (ТИ ВЛАСНИК!)`);
});

process.on('uncaughtException', (err) => {
  console.error('❌ Помилка:', err);
});

process.on('unhandledRejection', (err) => {
  console.error('❌ Помилка:', err);
});
