const express = require('express');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const { Server } = require('socket.io');
const http = require('http');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const pool = new Pool({
  user: 'postgres',
  host: 'localhost',
  database: 'grpchat',
  password: 'salmaan@2004',
  port: 5432
});

// Middleware
app.set('view engine', 'ejs');
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'public/uploads')));

app.use(session({
  store: new pgSession({ pool }),
  secret: 'secret-key',
  resave: false,
  saveUninitialized: false,
}));

// Media upload setup
const uploadDir = path.join(__dirname, 'public/uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname))
});
const upload = multer({ storage });

// Room logic
let connectedUsers = {};
let rooms = {};
let roomMessages = {};

function findSocketByUsername(username) {
  const socketId = connectedUsers[username];
  return socketId ? io.sockets.sockets.get(socketId) : null;
}

// Routes
app.get('/', (req, res) => {
  if (req.session.user) return res.redirect('/chat');
  res.redirect('/login');
});

app.get('/register', (req, res) => res.render('register', { error: null }));

app.post('/register', upload.single('profilePic'), async (req, res) => {
  const { username, password, displayName } = req.body;
  const profilePic = req.file ? `/uploads/${req.file.filename}` : null;

  try {
    const existing = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
    if (existing.rows.length) {
      return res.render('register', { error: 'Username already exists' });
    }

    const hashed = await bcrypt.hash(password, 10);
    await pool.query('INSERT INTO users (username, password, display_name, profile_pic) VALUES ($1, $2, $3, $4)',
      [username, hashed, displayName, profilePic]);

    res.redirect('/login');
  } catch (err) {
    console.error(err);
    res.render('register', { error: 'Database error' });
  }
});

app.get('/login', (req, res) => res.render('login', { error: null }));

app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  try {
    const result = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
    const user = result.rows[0];
    if (!user || !(await bcrypt.compare(password, user.password))) {
      return res.render('login', { error: 'Invalid credentials' });
    }

    req.session.user = user;
    res.redirect('/chat');
  } catch (err) {
    console.error(err);
    res.render('login', { error: 'Database error' });
  }
});

app.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/');
});

app.get('/chat', (req, res) => {
  if (!req.session.user) return res.redirect('/login');
  res.render('index', { user: req.session.user });
});

app.get('/room/:id', (req, res) => {
  const currentUser = req.session.user;
  if (!currentUser) return res.redirect('/login');

  const roomId = req.params.id;
  if (!rooms[roomId]) {
    rooms[roomId] = {
      admin: currentUser.username,
      approvedUsers: new Set([currentUser.username]),
      pending: new Set()
    };
  }

  const isAdmin = rooms[roomId].admin === currentUser.username;

  res.render('chat', {
    roomId,
    user: currentUser,
    isAdmin
  });
});

app.post('/upload', upload.single('media'), async (req, res) => {
  if (!req.file) return res.status(400).send('No file uploaded.');
  const filePath = `/uploads/${req.file.filename}`;
  try {
    await pool.query('INSERT INTO media (file_path, uploaded_by) VALUES ($1, $2)',
      [filePath, req.session.user?.username || 'anonymous']);
    res.json({ filePath });
  } catch (err) {
    console.error(err);
    res.status(500).send('Upload failed');
  }
});

// Socket.IO
io.on('connection', (socket) => {
  socket.on('join-room', ({ roomId, username }) => {
    connectedUsers[username] = socket.id;
    const room = rooms[roomId];
    if (!room) return;

    if (room.approvedUsers.has(username)) {
      socket.join(roomId);
      if (!roomMessages[roomId]) roomMessages[roomId] = [];
      roomMessages[roomId].forEach(msg => socket.emit('message', msg));

      io.to(roomId).emit('message', {
        user: 'System',
        text: `${username} joined the room`
      });

      socket.data.username = username;
      socket.data.roomId = roomId;

    } else {
      room.pending.add(username);
      const adminSocket = findSocketByUsername(room.admin);
      if (adminSocket) {
        adminSocket.emit('join-request', { roomId, username });
      }
    }
  });

  socket.on('approve-user', ({ roomId, username }) => {
    const room = rooms[roomId];
    if (room && room.pending.has(username)) {
      room.pending.delete(username);
      room.approvedUsers.add(username);
      const userSocket = findSocketByUsername(username);
      if (userSocket) {
        userSocket.emit('approved', { roomId });
      }
    }
  });

  socket.on('reject-user', ({ roomId, username }) => {
    const room = rooms[roomId];
    if (room && room.pending.has(username)) {
      room.pending.delete(username);
      const userSocket = findSocketByUsername(username);
      if (userSocket) {
        userSocket.emit('rejected');
      }
    }
  });

  socket.on('chat-message', (msg) => {
    const username = socket.data.username;
    const roomId = socket.data.roomId;
    if (!username || !roomId || !rooms[roomId]?.approvedUsers.has(username)) return;

    const message = { user: username, text: msg };
    roomMessages[roomId].push(message);
    io.to(roomId).emit('message', message);
  });

  socket.on('chat message', (html) => {
    const username = socket.data.username;
    const roomId = socket.data.roomId;
    if (!username || !roomId || !rooms[roomId]?.approvedUsers.has(username)) return;

    const message = { user: username, text: html };
    roomMessages[roomId].push(message);
    io.to(roomId).emit('message', message);
  });

  socket.on('close-room', (roomId) => {
    const username = socket.data.username;
    const room = rooms[roomId];
    if (room && room.admin === username) {
      io.to(roomId).emit('message', { user: 'System', text: `Room "${roomId}" has been closed` });
      io.to(roomId).emit('room-closed');
      delete rooms[roomId];
      delete roomMessages[roomId];
    }
  });

  socket.on('disconnect', () => {
    const username = socket.data.username;
    const roomId = socket.data.roomId;
    if (roomId && rooms[roomId]) {
      const room = rooms[roomId];
      if (room.admin === username) {
        io.to(roomId).emit('message', {
          user: 'System',
          text: `Room "${roomId}" has been closed`
        });
        io.to(roomId).emit('room-closed');
        delete rooms[roomId];
        delete roomMessages[roomId];
      } else {
        io.to(roomId).emit('message', {
          user: 'System',
          text: `${username} left the room`
        });
      }
    }
    delete connectedUsers[username];
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});
