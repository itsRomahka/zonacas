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
      balance INTEGER DEFAULT 1000,
      role TEXT DEFAULT 'user',
      total_bet INTEGER DEFAULT 0,
      total_win INTEGER DEFAULT 0,
      banned_until INTEGER DEFAULT 0,
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

    CREATE TABLE IF NOT EXISTS case_openings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      case_id INTEGER,
      reward INTEGER,
      opened_at INTEGER DEFAULT (strftime('%s', 'now')),
      FOREIGN KEY(user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS game_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      crash_point REAL,
      players_count INTEGER,
      created_at INTEGER DEFAULT (strftime('%s', 'now'))
    );
  `);

  // ВИПРАВЛЕНО: спочатку перевіряємо чи є вже такий користувач
  const existingUser = await db.get('SELECT id FROM users WHERE id = ?', OWNER_ID);
  if (!existingUser) {
    await db.run(
      'INSERT INTO users (id, username, balance, role) VALUES (?, ?, ?, ?)',
      [OWNER_ID, 'owner', 1000000, 'owner']
    );
    console.log('✅ Власника додано в базу');
  } else {
    console.log('✅ Власник вже є в базі');
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
    console.log('✅ Безкоштовний кейс додано');
  }
}

initDB();

// ===========================================
// API Endpoints
// ===========================================
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.post('/api/user', async (req, res) => {
  try {
    const { id, username } = req.body;
    let user = await db.get('SELECT * FROM users WHERE id = ?', id);
    
    if (!user) {
      await db.run(
        'INSERT INTO users (id, username, balance, role) VALUES (?, ?, ?, ?)',
        [id, username, 1000, 'user']
      );
      user = await db.get('SELECT * FROM users WHERE id = ?', id);
    }
    
    res.json(user);
  } catch (error) {
    console.error('Помилка в /api/user:', error);
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

app.get('/api/leaderboard', async (req, res) => {
  try {
    const leaderboard = await db.all(`
      SELECT username, (total_win - total_bet) as profit 
      FROM users 
      WHERE total_bet > 0 
      ORDER BY profit DESC 
      LIMIT 10
    `);
    res.json(leaderboard);
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
  const username = msg.from.username || `user_${userId}`;

  try {
    let user = await db.get('SELECT * FROM users WHERE id = ?', userId);
    if (!user) {
      await db.run(
        'INSERT INTO users (id, username, balance, role) VALUES (?, ?, ?, ?)',
        [userId, username, 1000, 'user']
      );
    }

    const banned = await db.get('SELECT banned_until FROM users WHERE id = ?', userId);
    if (banned && banned.banned_until > Math.floor(Date.now() / 1000)) {
      const until = new Date(banned.banned_until * 1000).toLocaleString();
      await bot.sendMessage(chatId, `❌ Ви забанені до ${until}`);
      return;
    }

    const webAppUrl = `https://${process.env.RAILWAY_STATIC_URL || 'localhost:3000'}`;
    
    await bot.sendMessage(chatId, '🎮 Ласкаво просимо до гри!', {
      reply_markup: {
        inline_keyboard: [[
          {
            text: '🎰 ВІДКРИТИ ГРУ',
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
  timeUntilStart: 10,
  players: [],
  history: []
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
  gameState.timeUntilStart = 10;
  
  for (let i = 10; i > 0; i--) {
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
  
  try {
    await db.run(
      'INSERT INTO game_history (crash_point, players_count) VALUES (?, ?)',
      [gameState.crashPoint, gameState.players.length]
    );
  } catch (error) {
    console.error('Помилка збереження історії:', error);
  }
  
  gameState.history.unshift({
    crashPoint: gameState.crashPoint,
    time: Date.now(),
    players: gameState.players.length
  });
  
  if (gameState.history.length > 10) {
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
        username: user.username,
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
  
  socket.on('openCase', async ({ userId, caseId }) => {
    try {
      const case_ = await db.get('SELECT * FROM cases WHERE id = ?', caseId);
      const user = await db.get('SELECT * FROM users WHERE id = ?', userId);
      
      if (!case_ || !user) return;
      
      if (case_.is_free) {
        const lastOpen = await db.get(
          'SELECT opened_at FROM case_openings WHERE user_id = ? AND case_id = ? ORDER BY opened_at DESC LIMIT 1',
          [userId, caseId]
        );
        
        if (lastOpen && (Date.now() / 1000) - lastOpen.opened_at < case_.cooldown) {
          socket.emit('error', 'Зачекайте перед наступним відкриттям');
          return;
        }
      } else {
        if (user.balance < case_.price) return;
        await db.run('UPDATE users SET balance = balance - ? WHERE id = ?', [case_.price, userId]);
      }
      
      const items = await db.all('SELECT * FROM case_items WHERE case_id = ?', caseId);
      
      const totalChance = items.reduce((sum, item) => sum + item.chance, 0);
      let random = Math.random() * totalChance;
      let selectedItem = null;
      
      for (const item of items) {
        if (random < item.chance) {
          selectedItem = item;
          break;
        }
        random -= item.chance;
      }
      
      if (!selectedItem) return;
      
      const reward = Math.floor(
        selectedItem.min_reward + Math.random() * (selectedItem.max_reward - selectedItem.min_reward)
      );
      
      await db.run('UPDATE users SET balance = balance + ? WHERE id = ?', [reward, userId]);
      
      await db.run(
        'INSERT INTO case_openings (user_id, case_id, reward) VALUES (?, ?, ?)',
        [userId, caseId, reward]
      );
      
      socket.emit('caseOpened', { reward, caseName: case_.name });
    } catch (error) {
      console.error('Помилка відкриття кейсу:', error);
    }
  });
});

// ===========================================
// СТВОРЮЄМО ПАПКУ PUBLIC І ФАЙЛ INDEX.HTML
// ===========================================
const publicDir = path.join(__dirname, 'public');
const fs = require('fs');

if (!fs.existsSync(publicDir)) {
  fs.mkdirSync(publicDir, { recursive: true });
}

const htmlContent = `<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Краш гра</title>
    <script src="https://telegram.org/js/telegram-web-app.js"></script>
    <script src="/socket.io/socket.io.js"></script>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0f0f1a; color: white; }
        .app { max-width: 1200px; margin: 0 auto; padding: 10px; }
        .tabs { display: flex; gap: 10px; margin-bottom: 20px; background: #1a1a2e; padding: 10px; border-radius: 12px; }
        .tab { flex: 1; padding: 12px; border: none; background: transparent; color: #8f8f9f; font-size: 16px; font-weight: 600; border-radius: 8px; cursor: pointer; }
        .tab.active { background: #2a2a3a; color: white; }
        .game-container { background: #1a1a2e; border-radius: 16px; padding: 20px; }
        .multiplier { font-size: 64px; font-weight: bold; text-align: center; margin: 20px 0; color: #4caf50; }
        .canvas-container { background: #0f0f1a; border-radius: 12px; padding: 20px; margin: 20px 0; height: 300px; }
        #gameCanvas { width: 100%; height: 100%; display: block; }
        .status { text-align: center; font-size: 18px; color: #8f8f9f; margin-bottom: 20px; }
        .bet-panel { background: #2a2a3a; border-radius: 12px; padding: 20px; }
        .balance { font-size: 24px; font-weight: bold; color: #4caf50; margin-bottom: 15px; }
        .bet-input { display: flex; gap: 10px; margin-bottom: 15px; }
        .bet-input input { flex: 1; padding: 12px; background: #1a1a2e; border: 2px solid #3a3a4a; border-radius: 8px; color: white; font-size: 16px; }
        .bet-input button { padding: 12px 24px; background: #4caf50; border: none; border-radius: 8px; color: white; font-weight: bold; cursor: pointer; }
        .bet-input button:disabled { opacity: 0.5; cursor: not-allowed; }
        .cashout-btn { width: 100%; padding: 16px; background: #ff9800; border: none; border-radius: 8px; color: white; font-size: 18px; font-weight: bold; cursor: pointer; }
        .players-list { margin-top: 20px; }
        .player-item { display: flex; justify-content: space-between; padding: 8px; background: #2a2a3a; border-radius: 6px; margin-bottom: 5px; }
        .cases-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 20px; margin-top: 20px; }
        .case-card { background: linear-gradient(145deg, #1a1a2e, #0f0f1a); border-radius: 16px; padding: 20px; text-align: center; cursor: pointer; }
        .case-icon { font-size: 48px; margin-bottom: 15px; }
        .case-name { font-size: 20px; font-weight: bold; margin-bottom: 10px; }
        .case-price { font-size: 18px; color: #4caf50; }
        .case-free { background: #ff9800; color: black; padding: 4px 8px; border-radius: 4px; font-size: 12px; display: inline-block; margin-top: 10px; }
        .leaderboard { background: #1a1a2e; border-radius: 16px; padding: 20px; }
        .leaderboard-title { font-size: 20px; margin-bottom: 15px; color: gold; }
        .leaderboard-item { display: flex; justify-content: space-between; padding: 8px; border-bottom: 1px solid #2a2a3a; }
        .admin-panel { position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); background: #1a1a2e; border: 3px solid gold; border-radius: 16px; padding: 20px; width: 90%; max-width: 800px; max-height: 80vh; overflow: auto; z-index: 1000; }
        .admin-tabs { display: flex; gap: 10px; margin-bottom: 20px; }
        .admin-tab { padding: 8px 16px; background: #2a2a3a; border: none; color: white; border-radius: 6px; cursor: pointer; }
        .admin-tab.active { background: gold; color: black; }
        .admin-section { background: #2a2a3a; border-radius: 12px; padding: 15px; margin-bottom: 15px; }
        .admin-table { width: 100%; border-collapse: collapse; }
        .admin-table th, .admin-table td { padding: 8px; text-align: left; border-bottom: 1px solid #3a3a4a; }
    </style>
</head>
<body>
    <div class="app">
        <div class="tabs" id="tabs">
            <button class="tab active" onclick="showTab('crash')">🎮 Краш</button>
            <button class="tab" onclick="showTab('cases')">📦 Кейси</button>
            <button class="tab" onclick="showTab('leaderboard')">🏆 Лідерборд</button>
        </div>
        
        <div id="crashTab" class="tab-content">
            <div class="game-container">
                <div class="multiplier" id="multiplier">1.00x</div>
                <div class="status" id="gameStatus">Очікування...</div>
                
                <div class="canvas-container">
                    <canvas id="gameCanvas" width="800" height="300"></canvas>
                </div>
                
                <div class="bet-panel">
                    <div class="balance" id="balance">1000 монет</div>
                    <div class="bet-input">
                        <input type="number" id="betAmount" placeholder="Сума ставки" min="1" value="10">
                        <button id="placeBetBtn">Зробити ставку</button>
                    </div>
                    <button id="cashoutBtn" class="cashout-btn" style="display: none;">💰 ЗАБРАТИ</button>
                </div>
                
                <div class="players-list" id="playersList">
                    <h3>Гравці в раунді</h3>
                </div>
            </div>
        </div>
        
        <div id="casesTab" class="tab-content" style="display: none;">
            <div class="cases-grid" id="casesGrid"></div>
        </div>
        
        <div id="leaderboardTab" class="tab-content" style="display: none;">
            <div class="leaderboard">
                <div class="leaderboard-title">Топ гравців</div>
                <div id="leaderboardList"></div>
            </div>
        </div>
    </div>
    
    <div id="adminPanel" style="display: none;"></div>

    <script>
        const tg = window.Telegram.WebApp;
        tg.ready();
        tg.expand();
        
        const socket = io();
        const user = tg.initDataUnsafe?.user || { id: ${OWNER_ID}, username: 'owner' };
        
        let currentBalance = 1000;
        let activeBet = null;
        let userRole = 'user';
        
        function showTab(tabName) {
            document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
            document.querySelectorAll('.tab-content').forEach(c => c.style.display = 'none');
            
            event.target.classList.add('active');
            document.getElementById(tabName + 'Tab').style.display = 'block';
            
            if (tabName === 'cases') loadCases();
            if (tabName === 'leaderboard') loadLeaderboard();
        }
        
        async function loadUser() {
            try {
                const res = await fetch('/api/user', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ id: user.id, username: user.username })
                });
                const userData = await res.json();
                currentBalance = userData.balance;
                userRole = userData.role;
                document.getElementById('balance').textContent = currentBalance + ' монет';
                
                if (userRole !== 'user') {
                    initAdminPanel();
                }
            } catch (error) {
                console.error('Помилка завантаження користувача:', error);
            }
        }
        
        loadUser();
        
        const canvas = document.getElementById('gameCanvas');
        const ctx = canvas.getContext('2d');
        
        socket.on('gameState', (state) => {
            document.getElementById('multiplier').textContent = state.multiplier.toFixed(2) + 'x';
            
            if (state.status === 'waiting') {
                document.getElementById('gameStatus').textContent = \`Старт через: \${state.timeUntilStart}с\`;
                document.getElementById('placeBetBtn').disabled = false;
                document.getElementById('cashoutBtn').style.display = 'none';
            } else if (state.status === 'running') {
                document.getElementById('gameStatus').textContent = '🛫 Летимо!';
                document.getElementById('placeBetBtn').disabled = true;
                
                if (activeBet) {
                    document.getElementById('cashoutBtn').style.display = 'block';
                    document.getElementById('cashoutBtn').textContent = \`💰 ЗАБРАТИ (\${state.multiplier.toFixed(2)}x)\`;
                }
            } else if (state.status === 'crashed') {
                document.getElementById('gameStatus').textContent = '💥 ВИБУХ!';
                document.getElementById('cashoutBtn').style.display = 'none';
                activeBet = null;
            }
            
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            
            if (state.status === 'running') {
                const progress = Math.min(state.multiplier / 5, 1);
                const x = 50 + (canvas.width - 100) * progress;
                const y = canvas.height - 50 - (canvas.height - 100) * progress * 0.5;
                
                ctx.beginPath();
                ctx.strokeStyle = '#4caf50';
                ctx.lineWidth = 3;
                ctx.moveTo(50, canvas.height - 50);
                ctx.lineTo(x, y);
                ctx.stroke();
                
                ctx.save();
                ctx.translate(x, y);
                ctx.fillStyle = 'white';
                ctx.beginPath();
                ctx.moveTo(0, -10);
                ctx.lineTo(20, 0);
                ctx.lineTo(0, 10);
                ctx.closePath();
                ctx.fill();
                ctx.restore();
            } else if (state.status === 'crashed') {
                for (let i = 0; i < 8; i++) {
                    const angle = (i / 8) * Math.PI * 2;
                    const dx = Math.cos(angle) * 40;
                    const dy = Math.sin(angle) * 40;
                    
                    ctx.beginPath();
                    ctx.fillStyle = \`hsl(\${30 + i * 20}, 100%, 50%)\`;
                    ctx.arc(canvas.width/2 + dx, canvas.height/2 + dy, 15, 0, Math.PI*2);
                    ctx.fill();
                }
            }
            
            const playersList = document.getElementById('playersList');
            playersList.innerHTML = '<h3>Гравці в раунді</h3>' + 
                state.players.map(p => \`
                    <div class="player-item">
                        <span>\${p.username}</span>
                        <span>\${p.betAmount} монет \${p.cashedOut ? '✅ x' + p.cashedAt.toFixed(2) : '🟡'}</span>
                    </div>
                \`).join('');
        });
        
        document.getElementById('placeBetBtn').addEventListener('click', () => {
            const amount = parseInt(document.getElementById('betAmount').value);
            if (amount > currentBalance) {
                alert('Недостатньо коштів!');
                return;
            }
            
            socket.emit('placeBet', { userId: user.id, amount });
            activeBet = { amount };
        });
        
        document.getElementById('cashoutBtn').addEventListener('click', () => {
            socket.emit('cashOut', { userId: user.id });
        });
        
        socket.on('cashOutSuccess', (data) => {
            alert(\`Ви виграли \${data.winAmount} монет!\`);
            activeBet = null;
            document.getElementById('cashoutBtn').style.display = 'none';
            loadUser();
        });
        
        async function loadCases() {
            try {
                const res = await fetch('/api/cases');
                const cases = await res.json();
                
                document.getElementById('casesGrid').innerHTML = cases.map(c => \`
                    <div class="case-card" onclick="openCase(\${c.id})">
                        <div class="case-icon">📦</div>
                        <div class="case-name">\${c.name}</div>
                        <div class="case-price">\${c.price} монет</div>
                        \${c.is_free ? '<div class="case-free">БЕЗКОШТОВНО (раз на годину)</div>' : ''}
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
            alert(\`🎉 Ви виграли \${data.reward} монет з кейсу "\${data.caseName}"!\`);
            loadUser();
        });
        
        async function loadLeaderboard() {
            try {
                const res = await fetch('/api/leaderboard');
                const leaderboard = await res.json();
                
                document.getElementById('leaderboardList').innerHTML = leaderboard.map((item, index) => \`
                    <div class="leaderboard-item">
                        <span>\${index + 1}. \${item.username}</span>
                        <span>\${item.profit} монет</span>
                    </div>
                \`).join('');
            } catch (error) {
                console.error('Помилка завантаження лідерборду:', error);
            }
        }
        
        function initAdminPanel() {
            const adminHtml = \`
                <div class="admin-panel">
                    <h2 style="color: gold; text-align: center;">🔧 Адмін панель</h2>
                    
                    <div class="admin-tabs">
                        <button class="admin-tab active" onclick="showAdminTab('users')">👥 Користувачі</button>
                        <button class="admin-tab" onclick="showAdminTab('game')">🎮 Гра</button>
                    </div>
                    
                    <div id="adminUsersTab" class="admin-section">
                        <table class="admin-table">
                            <thead>
                                <tr>
                                    <th>ID</th>
                                    <th>Username</th>
                                    <th>Баланс</th>
                                    <th>Роль</th>
                                    <th>Дії</th>
                                </tr>
                            </thead>
                            <tbody id="adminUsersList"></tbody>
                        </table>
                    </div>
                    
                    <div id="adminGameTab" class="admin-section" style="display: none;">
                        <button onclick="forceCrash()" style="background: red; color: white; padding: 10px; border: none; border-radius: 5px; width: 100%;">
                            💥 ПРИМУСОВИЙ ВИБУХ
                        </button>
                    </div>
                    
                    <button onclick="document.getElementById('adminPanel').style.display = 'none'" style="margin-top: 10px; width: 100%; padding: 10px;">
                        Закрити
                    </button>
                </div>
            \`;
            
            document.getElementById('adminPanel').innerHTML = adminHtml;
            
            const tabs = document.getElementById('tabs');
            const adminTab = document.createElement('button');
            adminTab.className = 'tab';
            adminTab.textContent = '⚙️ Адмін';
            adminTab.onclick = () => {
                document.getElementById('adminPanel').style.display = 'block';
                loadAdminUsers();
            };
            tabs.appendChild(adminTab);
        }
        
        window.showAdminTab = (tab) => {
            document.querySelectorAll('.admin-tab').forEach(t => t.classList.remove('active'));
            document.querySelectorAll('.admin-section').forEach(s => s.style.display = 'none');
            
            event.target.classList.add('active');
            document.getElementById('admin' + tab.charAt(0).toUpperCase() + tab.slice(1) + 'Tab').style.display = 'block';
            
            if (tab === 'users') loadAdminUsers();
        };
        
        function loadAdminUsers() {
            socket.emit('adminGetUsers', { adminId: user.id });
        }
        
        socket.on('adminUsersList', (users) => {
            const tbody = document.getElementById('adminUsersList');
            if (tbody) {
                tbody.innerHTML = users.map(u => \`
                    <tr>
                        <td>\${u.id}</td>
                        <td>\${u.username}</td>
                        <td><input type="number" value="\${u.balance}" onchange="setBalance(\${u.id}, this.value)" style="width: 80px;"></td>
                        <td>
                            <select onchange="setRole(\${u.id}, this.value)" \${userRole !== 'owner' ? 'disabled' : ''}>
                                <option value="user" \${u.role === 'user' ? 'selected' : ''}>Користувач</option>
                                <option value="helper" \${u.role === 'helper' ? 'selected' : ''}>Хелпер</option>
                                <option value="moderator" \${u.role === 'moderator' ? 'selected' : ''}>Модератор</option>
                                <option value="owner" \${u.role === 'owner' ? 'selected' : ''}>Власник</option>
                            </select>
                        </td>
                        <td>
                            <input type="number" placeholder="Годин" id="banHours_\${u.id}" style="width: 60px;">
                            <button onclick="banUser(\${u.id})">Бан</button>
                        </td>
                    </tr>
                \`).join('');
            }
        });
        
        window.setBalance = (userId, balance) => {
            socket.emit('adminSetBalance', { adminId: user.id, userId, balance: parseInt(balance) });
        };
        
        window.setRole = (userId, role) => {
            socket.emit('adminSetRole', { adminId: user.id, userId, role });
        };
        
        window.banUser = (userId) => {
            const hours = document.getElementById('banHours_' + userId).value;
            if (hours) {
                socket.emit('adminBan', { adminId: user.id, userId, hours: parseInt(hours) });
            }
        };
        
        window.forceCrash = () => {
            socket.emit('adminForceCrash', { adminId: user.id });
        };
        
        socket.on('adminGetUsers', ({ adminId }) => {
            if (adminId === user.id) {
                // Тут буде логіка отримання користувачів
            }
        });
        
        socket.on('adminSetBalance', ({ adminId, userId, balance }) => {
            if (adminId === user.id) {
                // Тут буде логіка зміни балансу
            }
        });
        
        socket.on('adminSetRole', ({ adminId, userId, role }) => {
            if (adminId === user.id) {
                // Тут буде логіка зміни ролі
            }
        });
        
        socket.on('adminBan', ({ adminId, userId, hours }) => {
            if (adminId === user.id) {
                // Тут буде логіка бану
            }
        });
        
        socket.on('adminForceCrash', ({ adminId }) => {
            if (adminId === user.id) {
                gameState.status = 'crashed';
                io.emit('gameState', gameState);
            }
        });
    </script>
</body>
</html>`;

fs.writeFileSync(path.join(publicDir, 'index.html'), htmlContent);
console.log('✅ index.html створено');

// ===========================================
// ЗАПУСК ГРИ
// ===========================================
startGameLoop();

// ===========================================
// ЗАПУСК СЕРВЕРА
// ===========================================
const PORT = process.env.PORT || 8080;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Сервер запущено на порту ${PORT}`);
  console.log(`✅ Твій ID: ${OWNER_ID} (ТИ ВЛАСНИК!)`);
  console.log(`✅ Відкрий в браузері: http://localhost:${PORT}`);
});

// Обробка помилок
process.on('uncaughtException', (err) => {
  console.error('❌ Необроблена помилка:', err);
});

process.on('unhandledRejection', (err) => {
  console.error('❌ Необроблений Promise:', err);
});
