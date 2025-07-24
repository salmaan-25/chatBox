const express = require('express');
const session = require('express-session');
const bcrypt = require('bcrypt');
const { Server } = require('socket.io');
const http = require('http');
const fs = require('fs');
const path = require('path');
const multer = require('multer');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const USERS_FILE = path.join(__dirname, 'users.json');
let users = fs.existsSync(USERS_FILE) ? JSON.parse(fs.readFileSync(USERS_FILE)) : [];

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'public/uploads/'),
  filename: (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname))
});
const upload = multer({ storage });

app.set('view engine', 'ejs');
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'public/uploads')));
app.use(session({
  secret: 'secret-key',
  resave: false,
  saveUninitialized: true,
}));

let connectedUsers = {}; // { username: socket.id }
let rooms = {}; // { roomId: { admin, approvedUsers: Set, pending: Set } }
let roomMessages = {}; // { roomId: [ { user, text } ] }

app.get('/', (req, res) => {
  if (req.session.user) return res.redirect('/chat');
  res.redirect('/login');
});

app.get('/register', (req, res) => res.render('register', { error: null }));

app.post('/register', upload.single('profilePic'), async (req, res) => {
  const { username, password, displayName } = req.body;
  const profilePic = req.file ? `/uploads/${req.file.filename}` : null;

  if (users.find(u => u.username === username)) {
    return res.render('register', { error: 'Username already exists' });
  }

  const hashed = await bcrypt.hash(password, 10);
  users.push({ username, password: hashed, displayName, profilePic });
  fs.writeFileSync(USERS_FILE, JSON.stringify(users));
  res.redirect('/login');
});

app.get('/login', (req, res) => res.render('login', { error: null }));

app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  const user = users.find(u => u.username === username);
  if (!user || !(await bcrypt.compare(password, user.password))) {
    return res.render('login', { error: 'Invalid credentials' });
  }
  req.session.user = user;
  res.redirect('/chat');
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

app.post('/upload', upload.single('media'), (req, res) => {
  if (!req.file) return res.status(400).send('No file uploaded.');
  res.json({ filePath: '/uploads/' + req.file.filename });
});

function findSocketByUsername(username) {
  const socketId = connectedUsers[username];
  return socketId ? io.sockets.sockets.get(socketId) : null;
}

io.on('connection', socket => {
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

      // Store roomId and username for later use in message events
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
    const username = Object.keys(connectedUsers).find(name => connectedUsers[name] === socket.id);
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

const PORT = 3000;
server.listen(PORT, () => {
  console.log(`✅ Server running at http://localhost:${PORT}`);
});
