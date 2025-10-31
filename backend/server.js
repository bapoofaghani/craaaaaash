// server.js - نسخه نهایی کامل

const express = require("express");
const path = require("path");
const mongoose = require("mongoose");
mongoose.set('useFindAndModify', false);
const cors = require("cors");
const passport = require("passport");
const passportLocal = require("passport-local").Strategy;
const cookieParser = require("cookie-parser");
const bcrypt = require("bcryptjs");
const session = require("express-session");
const bodyParser = require("body-parser");
require('dotenv').config();

const User = require("./models/user");
const Game_loop = require("./models/game_loop");
const GAME_LOOP_ID = '62b7e66b1da7901bfc65df0d';

const { Server } = require('socket.io');
const http = require('http');
const Stopwatch = require('statman-stopwatch');
const sw = new Stopwatch(true);

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// -------------------------
// Socket.io
let live_bettors_table = [];
let messages_list = [];
let betting_phase = false;
let game_phase = false;
let cashout_phase = true;
let game_crash_value = -69;
let phase_start_time = Date.now();
let sent_cashout = true;

io.on("connection", (socket) => {
  socket.on("clicked", (data) => { });
});

// -------------------------
// MongoDB
mongoose.connect(process.env.MONGOOSE_DB_LINK, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
});

// -------------------------
// Middleware
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(cors({ origin: true, credentials: true }));
app.use(session({
  secret: process.env.PASSPORT_SECRET,
  resave: true,
  saveUninitialized: true,
}));
app.use(cookieParser(process.env.PASSPORT_SECRET));
app.use(passport.initialize());
app.use(passport.session());
require("./passportConfig")(passport);

// -------------------------
// Auth
function checkAuthenticated(req, res, next) {
  if (req.isAuthenticated()) return next();
  return res.send("No User Authentication");
}

// -------------------------
// Login / Register
app.post("/login", (req, res, next) => {
  passport.authenticate("local", (err, user, info) => {
    if (err) throw err;
    if (!user) res.send("Username or Password is Wrong");
    else {
      req.logIn(user, (err) => {
        if (err) throw err;
        res.send("Login Successful");
      });
    }
  })(req, res, next);
});

app.post("/register", (req, res) => {
  if (req.body.username.length < 3 || req.body.password.length < 3) return;

  User.findOne({ username: req.body.username }, async (err, doc) => {
    if (err) throw err;
    if (doc) res.send("Username already exists");
    if (!doc) {
      const hashedPassword = await bcrypt.hash(req.body.password, 10);
      const newUser = new User({ username: req.body.username, password: hashedPassword });
      await newUser.save();
      res.send("Loading...");
    }
  });
});

// -------------------------
// Game APIs
app.get("/user", checkAuthenticated, async (req, res) => {
  res.send(req.user);
});

app.get("/logout", (req, res) => {
  req.logout();
  res.send("success2");
});

app.get("/multiply", checkAuthenticated, async (req, res) => {
  const thisUser = await User.findById(req.user._id);
  const game_loop = await Game_loop.findById(GAME_LOOP_ID);
  thisUser.balance += game_loop.multiplier_crash;
  await thisUser.save();
  res.json(thisUser);
});

app.get('/generate_crash_value', async (req, res) => {
  const randomInt = Math.floor(Math.random() * 6) + 1;
  const game_loop = await Game_loop.findById(GAME_LOOP_ID);
  game_loop.multiplier_crash = randomInt;
  await game_loop.save();
  res.json(randomInt);
});

app.get('/retrieve', async (req, res) => {
  const game_loop = await Game_loop.findById(GAME_LOOP_ID);
  res.json(game_loop.multiplier_crash);
});

app.post('/send_bet', checkAuthenticated, async (req, res) => {
  if (!betting_phase) return res.status(400).json({ customError: "IT IS NOT THE BETTING PHASE" });

  let theLoop = await Game_loop.findById(GAME_LOOP_ID);
  if (theLoop.active_player_id_list.includes(req.user.id)) 
    return res.status(400).json({ customError: "You are already betting this round" });

  const thisUser = await User.findById(req.user.id);
  if (req.body.bet_amount > thisUser.balance) 
    return res.status(400).json({ customError: "Bet too big" });

  await User.findByIdAndUpdate(req.user.id, { bet_amount: req.body.bet_amount, payout_multiplier: req.body.payout_multiplier });
  await User.findByIdAndUpdate(req.user.id, { balance: thisUser.balance - req.body.bet_amount });
  await Game_loop.findByIdAndUpdate(GAME_LOOP_ID, { $push: { active_player_id_list: req.user.id } });

  live_bettors_table.push({
    the_user_id: req.user.id,
    the_username: req.user.username,
    bet_amount: req.body.bet_amount,
    cashout_multiplier: null,
    profit: null,
    b_bet_live: true,
  });

  io.emit("receive_live_betting_table", JSON.stringify(live_bettors_table));
  res.json(`Bet placed for ${req.user.username}`);
});

app.get('/calculate_winnings', checkAuthenticated, async (req, res) => {
  let theLoop = await Game_loop.findById(GAME_LOOP_ID);
  for (const playerId of theLoop.active_player_id_list) {
    const currUser = await User.findById(playerId);
    if (currUser.payout_multiplier <= game_crash_value) {
      currUser.balance += currUser.bet_amount * currUser.payout_multiplier;
      await currUser.save();
    }
  }
  theLoop.active_player_id_list = [];
  await theLoop.save();
  res.json("Winnings calculated");
});

app.get('/get_chat_history', async (req, res) => {
  const theLoop = await Game_loop.findById(GAME_LOOP_ID);
  res.json(theLoop.chat_messages_list);
});

app.post('/send_message_to_chatbox', checkAuthenticated, async (req, res) => {
  const message_json = {
    the_user_id: req.user.id,
    the_username: req.user.username,
    message_body: req.body.message_to_textbox,
    the_time: new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
    the_date: new Date().toLocaleDateString(),
  };
  await Game_loop.findByIdAndUpdate(GAME_LOOP_ID, { $push: { chat_messages_list: message_json } });
  messages_list.push(message_json);
  io.emit("receive_message_for_chat_box", JSON.stringify(messages_list));
  res.send("Message sent");
});

// -------------------------
// Serve React build
app.use(express.static(path.join(__dirname, '../client/build')));
app.get('*', (req, res) => {
  res.sendFile(path.resolve(__dirname, '../client/build', 'index.html'));
});

// -------------------------
// Game Loop
const cashout = async () => {
  const theLoop = await Game_loop.findById(GAME_LOOP_ID);
  for (const playerId of theLoop.active_player_id_list) {
    const currUser = await User.findById(playerId);
    if (currUser.payout_multiplier <= game_crash_value) {
      currUser.balance += currUser.bet_amount * currUser.payout_multiplier;
      await currUser.save();
    }
  }
  theLoop.active_player_id_list = [];
  await theLoop.save();
};

const loopUpdate = async () => {
  let time_elapsed = (Date.now() - phase_start_time) / 1000.0;

  if (betting_phase) {
    if (time_elapsed > 6) {
      sent_cashout = false;
      betting_phase = false;
      game_phase = true;
      io.emit('start_multiplier_count');
      phase_start_time = Date.now();
    }
  } else if (game_phase) {
    const current_multiplier = (1.0024 * Math.pow(1.0718, time_elapsed)).toFixed(2);
    if (current_multiplier > game_crash_value) {
      io.emit('stop_multiplier_count', game_crash_value.toFixed(2));
      game_phase = false;
      cashout_phase = true;
      phase_start_time = Date.now();
    }
  } else if (cashout_phase) {
    if (!sent_cashout) {
      await cashout();
      sent_cashout = true;

      const update_loop = await Game_loop.findById(GAME_LOOP_ID);
      await update_loop.updateOne({ $push: { previous_crashes: game_crash_value } });
      await update_loop.updateOne({ $unset: { "previous_crashes.0": 1 } });
      await update_loop.updateOne({ $pull: { "previous_crashes": null } });

      const round_list = update_loop.round_id_list;
      await update_loop.updateOne({ $push: { round_id_list: round_list[round_list.length - 1] + 1 } });
      await update_loop.updateOne({ $unset: { "round_id_list.0": 1 } });
      await update_loop.updateOne({ $pull: { "round_id_list": null } });
    }

    if (time_elapsed > 3) {
      cashout_phase = false;
      betting_phase = true;

      let randomInt = Math.floor(Math.random() * (9999999999 - 0 + 1) + 0);
      if (randomInt % 33 === 0) game_crash_value = 1;
      else {
        let random_0_1 = Math.random();
        while (random_0_1 === 0) random_0_1 = Math.random();
        game_crash_value = 0.01 + (0.99 / random_0_1);
        game_crash_value = Math.round(game_crash_value * 100) / 100;
      }

      io.emit('update_user');
      const theLoop = await Game_loop.findById(GAME_LOOP_ID);
      io.emit('crash_history', theLoop.previous_crashes);
      io.emit('get_round_id_list', theLoop.round_id_list);
      io.emit('start_betting_phase');
      live_bettors_table = [];
      phase_start_time = Date.now();
    }
  }
};

// Run loop every second
setInterval(loopUpdate, 1000);

// -------------------------
// Start server
const PORT = process.env.PORT || 4000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});
