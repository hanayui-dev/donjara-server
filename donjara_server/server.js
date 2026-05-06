const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

const PORT = process.env.PORT || 3000;

// ============================================================
//  牌データ読み込み
// ============================================================
let TILES_DATA = { tiles: [], sets: [] };
try {
  const raw = fs.readFileSync(path.join(__dirname, 'tiles.json'), 'utf8');
  TILES_DATA = JSON.parse(raw);
  console.log(`牌データ読み込み: ${TILES_DATA.tiles.length}種, ${(TILES_DATA.sets||[]).length}セット`);
} catch(e) {
  console.error('tiles.json読み込みエラー:', e.message);
}

// ============================================================
//  ゲームロジック（サーバー側）
// ============================================================
function buildDeck(tiles) {
  const d = [];
  tiles.forEach(t => { for(let i=0;i<t.count;i++) d.push(t.id); });
  return d;
}

function shuffle(a) {
  const arr = [...a];
  for(let i=arr.length-1;i>0;i--){
    const j=Math.floor(Math.random()*(i+1));
    [arr[i],arr[j]]=[arr[j],arr[i]];
  }
  return arr;
}

// 手牌をセットで使い切れるか
function matchSet(hand, setTiles) {
  const h = [...hand];
  for(const id of setTiles){
    const i = h.indexOf(id);
    if(i===-1) return null;
    h.splice(i,1);
  }
  return h;
}

function canUseAll(hand, sets) {
  if(hand.length===0) return true;
  const s = [...hand].sort((a,b)=>a-b);
  // コウツ
  if(s.length>=3&&s[0]===s[1]&&s[1]===s[2]) {
    if(canUseAll(s.slice(3), sets)) return true;
  }
  // 対子
  if(s.length>=2&&s[0]===s[1]) {
    if(canUseAll(s.slice(2), sets)) return true;
  }
  // 登録セット
  for(const set of sets){
    const rem = matchSet(s, set.tiles);
    if(rem!==null&&rem.length<s.length) {
      if(canUseAll(rem, sets)) return true;
    }
  }
  return false;
}

function isWin(hand, sets) {
  return hand.length>0 && canUseAll([...hand], sets);
}

function canPon(hand, id) { return hand.filter(x=>x===id).length>=2; }

function canChi(hand, id, sets) {
  return sets.some(set => {
    if(set.tiles.length<3) return false;
    if(!set.tiles.includes(id)) return false;
    const need = [...set.tiles];
    need.splice(need.indexOf(id),1);
    const h = [...hand];
    for(const nid of need){
      const i=h.indexOf(nid);
      if(i===-1) return false;
      h.splice(i,1);
    }
    return true;
  });
}

function canMinkan(hand, id) { return hand.filter(x=>x===id).length>=3; }
function canAnkan(hand) {
  const counts = {};
  hand.forEach(id=>{ counts[id]=(counts[id]||0)+1; });
  return Object.keys(counts).filter(id=>counts[id]>=4).map(Number);
}
function canKakan(melds, hand) {
  return melds.filter(m=>m.type==='ポン').map(m=>m.tiles[0]).filter(id=>hand.includes(id));
}

// ============================================================
//  ルーム管理
// ============================================================
const rooms = {}; // roomId → room

function createRoom(roomId) {
  return {
    id: roomId,
    players: [],      // [{id, name, hand, melds, discards, ready}]
    spectators: [],
    status: 'waiting', // waiting / playing / finished
    game: null,
  };
}

function generateRoomId() {
  return Math.random().toString(36).slice(2,7).toUpperCase();
}

// ゲーム状態（特定プレイヤー視点で返す）
function getGameState(room, viewerId) {
  const g = room.game;
  if(!g) return null;
  return {
    players: g.players.map(p => ({
      id: p.id,
      name: p.name,
      handCount: p.hand.length,
      // 自分の手牌だけ公開
      hand: p.id===viewerId ? p.hand : null,
      melds: p.melds,
      discards: p.discards,
    })),
    deckCount: g.deck.length,
    cur: g.cur,       // 現在のターンのプレイヤーindex
    phase: g.phase,   // draw / discard / naki_wait
    lastDisc: g.lastDisc,
    lastDiscP: g.lastDiscP,
    drawn: g.phase==='discard' && g.players[g.cur].id===viewerId ? g.drawn : null,
    myIdx: g.players.findIndex(p=>p.id===viewerId),
  };
}

function initGame(room) {
  const tiles = TILES_DATA.tiles;
  const sets = TILES_DATA.sets || [];
  const deck = shuffle(buildDeck(tiles));
  const players = room.players.map(p => ({
    ...p,
    hand: [],
    melds: [],
    discards: [],
  }));
  // 13枚ずつ配る
  for(let i=0;i<13;i++) for(let p=0;p<players.length;p++) players[p].hand.push(deck.pop());
  room.game = {
    players,
    deck,
    sets,
    cur: 0,
    phase: 'draw',
    drawn: null,
    lastDisc: null,
    lastDiscP: -1,
  };
}

// ============================================================
//  Socket.io イベント
// ============================================================
io.on('connection', (socket) => {
  console.log(`接続: ${socket.id}`);

  // ルーム作成
  socket.on('create_room', ({ name }, cb) => {
    const roomId = generateRoomId();
    rooms[roomId] = createRoom(roomId);
    const player = { id: socket.id, name: name||'プレイヤー', hand:[], melds:[], discards:[], ready:false };
    rooms[roomId].players.push(player);
    socket.join(roomId);
    socket.roomId = roomId;
    socket.playerName = name;
    console.log(`ルーム作成: ${roomId} by ${name}`);
    cb({ ok:true, roomId, playerIdx:0 });
    io.to(roomId).emit('room_update', getRoomInfo(roomId));
  });

  // ルーム参加
  socket.on('join_room', ({ roomId, name }, cb) => {
    const room = rooms[roomId];
    if(!room){ cb({ ok:false, error:'ルームが存在しません' }); return; }
    if(room.status!=='waiting'){ cb({ ok:false, error:'ゲームはすでに開始されています' }); return; }
    if(room.players.length>=4){ cb({ ok:false, error:'満員です（最大4人）' }); return; }
    const player = { id:socket.id, name:name||'プレイヤー', hand:[], melds:[], discards:[], ready:false };
    room.players.push(player);
    socket.join(roomId);
    socket.roomId = roomId;
    socket.playerName = name;
    const idx = room.players.length-1;
    console.log(`参加: ${name} → ルーム ${roomId}`);
    cb({ ok:true, roomId, playerIdx:idx });
    io.to(roomId).emit('room_update', getRoomInfo(roomId));
  });

  // ゲーム開始
  socket.on('start_game', ({ npcCount=0 }={}, cb) => {
    const room = rooms[socket.roomId];
    if(!room){ cb&&cb({ ok:false, error:'ルームなし' }); return; }
    if(room.players[0].id!==socket.id){ cb&&cb({ ok:false, error:'ホストのみ開始できます' }); return; }
    // NPCを追加
    const npcNames = ['NPC-ことり','NPC-海未','NPC-凛','NPC-真姫'];
    const addCount = Math.min(npcCount, 4 - room.players.length);
    for(let i=0;i<addCount;i++){
      room.players.push({
        id: 'npc_'+i+'_'+Date.now(),
        name: npcNames[i] || 'NPC'+(i+1),
        isNPC: true,
        hand:[], melds:[], discards:[], ready:false
      });
    }
    if(room.players.length<2){ cb&&cb({ ok:false, error:'2人以上必要です' }); return; }
    room.status = 'playing';
    initGame(room);
    console.log(`ゲーム開始: ルーム ${socket.roomId} (NPC${addCount}人)`);
    cb&&cb({ ok:true });
    broadcastGameState(room);
    setTimeout(()=>doTsumo(room), 500);
  });

  // 捨て牌
  socket.on('discard', ({ tileId, handIdx }, cb) => {
    const room = rooms[socket.roomId];
    if(!room||!room.game){ cb&&cb({ ok:false }); return; }
    const g = room.game;
    const curP = g.players[g.cur];
    if(curP.id!==socket.id || g.phase!=='discard'){ cb&&cb({ ok:false, error:'あなたの番ではありません' }); return; }

    // 手牌から除去
    const idx = handIdx!==undefined ? handIdx : curP.hand.indexOf(tileId);
    if(idx===-1 || curP.hand[idx]!==tileId){ cb&&cb({ ok:false, error:'牌が見つかりません' }); return; }
    curP.hand.splice(idx,1);
    curP.discards.push(tileId);
    g.lastDisc = tileId;
    g.lastDiscP = g.cur;
    g.drawn = null;
    g.phase = 'naki_wait';
    cb&&cb({ ok:true });
    broadcastGameState(room);
    // 鳴きチェック
    setTimeout(()=>checkNaki(room), 300);
  });

  // 鳴き（ポン/チー/明カン）
  socket.on('naki', ({ type, tiles }, cb) => {
    const room = rooms[socket.roomId];
    if(!room||!room.game){ cb&&cb({ ok:false }); return; }
    const g = room.game;
    if(g.phase!=='naki_wait'){ cb&&cb({ ok:false, error:'鳴きフェーズではありません' }); return; }

    const myIdx = g.players.findIndex(p=>p.id===socket.id);
    if(myIdx===-1){ cb&&cb({ ok:false }); return; }
    const p = g.players[myIdx];

    if(type==='ポン'||type==='チー'||type==='明カン'){
      // 手牌から使う牌を除去（捨て牌以外）
      tiles.slice(1).forEach(id=>{
        const i=p.hand.indexOf(id);
        if(i!==-1) p.hand.splice(i,1);
      });
      p.melds.push({ type, tiles:[...tiles] });
      if(type==='明カン'){
        g.cur = myIdx;
        doRinshanTsumo(room, myIdx);
      } else {
        g.cur = myIdx;
        g.phase = 'discard';
        g.drawn = null;
      }
    } else if(type==='暗カン'){
      const id=tiles[0];
      let r=0;
      for(let i=p.hand.length-1;i>=0&&r<4;i--){
        if(p.hand[i]===id){p.hand.splice(i,1);r++;}
      }
      p.melds.push({ type:'暗カン', tiles:[id,id,id,id] });
      g.cur = myIdx;
      doRinshanTsumo(room, myIdx);
    } else if(type==='加カン'){
      const id=tiles[0];
      const meld=p.melds.find(m=>m.type==='ポン'&&m.tiles[0]===id);
      if(meld){meld.type='加カン';meld.tiles.push(id);}
      const hi=p.hand.indexOf(id);
      if(hi!==-1) p.hand.splice(hi,1);
      g.cur = myIdx;
      doRinshanTsumo(room, myIdx);
    }

    cb&&cb({ ok:true });
    broadcastGameState(room);
  });

  // スキップ
  socket.on('skip', (_, cb) => {
    const room = rooms[socket.roomId];
    if(!room||!room.game){ cb&&cb({ ok:false }); return; }
    const g = room.game;
    if(g.phase!=='naki_wait'){ cb&&cb({ ok:false }); return; }
    cb&&cb({ ok:true });
    nextTurn(room);
  });

  // 上がり宣言
  socket.on('win_declare', ({ type, ronTile }, cb) => {
    const room = rooms[socket.roomId];
    if(!room||!room.game){ cb&&cb({ ok:false }); return; }
    const g = room.game;
    const myIdx = g.players.findIndex(p=>p.id===socket.id);
    if(myIdx===-1){ cb&&cb({ ok:false }); return; }
    const p = g.players[myIdx];
    const fullHand = ronTile ? [...p.hand, ronTile] : [...p.hand];
    if(!isWin(fullHand, g.sets)){ cb&&cb({ ok:false, error:'上がれません' }); return; }

    room.status = 'finished';
    cb&&cb({ ok:true });
    io.to(room.id).emit('game_over', {
      winnerIdx: myIdx,
      winnerName: p.name,
      type,
      hand: fullHand,
      melds: p.melds,
    });
    console.log(`上がり: ${p.name} (${type}) ルーム ${socket.roomId}`);
  });

  // 切断
  socket.on('disconnect', () => {
    const room = rooms[socket.roomId];
    if(room){
      room.players = room.players.filter(p=>p.id!==socket.id);
      if(room.players.length===0){
        delete rooms[socket.roomId];
        console.log(`ルーム削除: ${socket.roomId}`);
      } else {
        io.to(socket.roomId).emit('room_update', getRoomInfo(socket.roomId));
        if(room.status==='playing'){
          io.to(socket.roomId).emit('player_left', { name: socket.playerName });
        }
      }
    }
    console.log(`切断: ${socket.id}`);
  });
});

// ============================================================
//  ゲーム進行（サーバー側）
// ============================================================
function doTsumo(room) {
  const g = room.game;
  if(!g||room.status!=='playing') return;
  if(g.deck.length===0){
    io.to(room.id).emit('ryukyoku', { message:'流局' });
    room.status = 'finished';
    return;
  }
  const t = g.deck.pop();
  g.drawn = t;
  g.phase = 'discard';
  g.players[g.cur].hand.push(t);
  broadcastGameState(room);
  // NPCのターンなら自動処理
  if(g.players[g.cur].isNPC){
    setTimeout(()=>npcTurn(room), 800);
  }
}

function npcTurn(room) {
  const g = room.game;
  if(!g||room.status!=='playing') return;
  const p = g.players[g.cur];
  if(!p.isNPC) return;
  // ランダムに1枚捨てる（ツモ切り）
  const di = Math.floor(Math.random()*p.hand.length);
  const did = p.hand[di];
  p.hand.splice(di,1);
  p.discards.push(did);
  g.lastDisc = did; g.lastDiscP = g.cur; g.drawn = null; g.phase = 'naki_wait';
  broadcastGameState(room);
  setTimeout(()=>checkNaki(room), 400);
}

function doRinshanTsumo(room, playerIdx) {
  const g = room.game;
  if(g.deck.length===0){ io.to(room.id).emit('ryukyoku',{message:'流局'}); room.status='finished'; return; }
  const t = g.deck.pop();
  g.drawn = t;
  g.phase = 'discard';
  g.players[playerIdx].hand.push(t);
  broadcastGameState(room);
}

function checkNaki(room) {
  const g = room.game;
  if(!g||g.phase!=='naki_wait') return;
  // 全プレイヤーに鳴き可否を通知
  const nakiOptions = {};
  g.players.forEach((p, idx) => {
    if(idx===g.lastDiscP) return;
    const opts = [];
    if(isWin([...p.hand, g.lastDisc], g.sets)) opts.push('ロン');
    if(canMinkan(p.hand, g.lastDisc)) opts.push('明カン');
    else if(canPon(p.hand, g.lastDisc)) opts.push('ポン');
    const upIdx = (idx-1+g.players.length)%g.players.length;
    if(g.lastDiscP===upIdx && canChi(p.hand, g.lastDisc, g.sets)) opts.push('チー');
    if(opts.length) nakiOptions[p.id] = opts;
  });

  // NPCプレイヤーのオプションを除外（NPCは鳴かない）
  const humanNakiOptions = {};
  Object.entries(nakiOptions).forEach(([pid, opts]) => {
    const p = g.players.find(p=>p.id===pid);
    if(!p?.isNPC) humanNakiOptions[pid] = opts;
  });

  if(Object.keys(humanNakiOptions).length===0){
    setTimeout(()=>nextTurn(room), 300);
  } else {
    broadcastGameState(room);
    io.to(room.id).emit('naki_available', {
      disc: g.lastDisc,
      options: humanNakiOptions,
    });
  }
}

function nextTurn(room) {
  const g = room.game;
  if(!g||room.status!=='playing') return;
  g.cur = (g.cur+1) % g.players.length;
  g.phase = 'draw';
  broadcastGameState(room);
  setTimeout(()=>doTsumo(room), 300);
}


// NPC: ツモ切り（最後にツモった牌をそのまま捨てる）
function npcTurn(room) {
  const g = room.game;
  if(!g||room.status!=='playing'||g.phase!=='discard') return;
  const p = g.players[g.cur];
  if(!p.isNpc) return;
  // ツモ切り（手牌の最後の牌を捨てる）
  const discIdx = p.hand.length - 1;
  const discId = p.hand.splice(discIdx, 1)[0];
  p.discards.push(discId);
  g.lastDisc = discId;
  g.lastDiscP = g.cur;
  g.drawn = null;
  g.phase = 'naki_wait';
  broadcastGameState(room);
  setTimeout(()=>checkNaki(room), 300);
}

function broadcastGameState(room) {
  room.players.forEach(p => {
    const socket = io.sockets.sockets.get(p.id);
    if(socket){
      socket.emit('game_state', getGameState(room, p.id));
    }
  });
}

function getRoomInfo(roomId) {
  const room = rooms[roomId];
  if(!room) return null;
  return {
    roomId: room.id,
    status: room.status,
    players: room.players.map(p=>({ id:p.id, name:p.name, isNPC:!!p.isNPC })),
    maxPlayers: 4,
  };
}

// ============================================================
//  静的ファイル配信
// ============================================================
app.use(express.static(path.join(__dirname, 'public')));
app.get('/tiles-meta', (req,res)=>{
  // 画像なしのメタデータのみ返す
  res.json({
    tiles: TILES_DATA.tiles.map(t=>({id:t.id,name:t.name,count:t.count,seq:t.seq})),
    sets: TILES_DATA.sets||[],
  });
});

server.listen(PORT, ()=>{
  console.log(`ドンジャラサーバー起動: port ${PORT}`);
});
