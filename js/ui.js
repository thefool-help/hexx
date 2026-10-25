/**
 * ui.js —— 海克斯棋（Hex）图形界面与交互控制
 * ============================================================================
 * 本文件负责“界面设计”，使用 HTML5 Canvas 绘制菱形六边形棋盘，
 * 并处理鼠标交互、菜单控制、人机/AI 对战流程、悔棋/提示等功能。
 *
 * 界面颜色约定：
 *   - 红方（连接上下边界）：棋子 #e11d48 系，边界高亮 #ef4444；
 *   - 蓝方（连接左右边界）：棋子 #2563eb 系，边界高亮 #3b82f6。
 */
(function () {
  'use strict';

  /* ============================ 常量与配色 ============================ */

  var R = window.HexGame.RED;
  var B = window.HexGame.BLUE;
  var EMPTY = window.HexGame.EMPTY;

  // 难度 -> 搜索深度 / 时间预算
  var DIFFICULTY = {
    easy:   { maxDepth: 2, timeLimitMs: 400 },
    medium: { maxDepth: 4, timeLimitMs: 1200 },
    hard:   { maxDepth: 6, timeLimitMs: 2500 }
  };

  var COLORS = {
    bg: '#0f172a',
    hexFill: '#f1f5f9',
    hexStroke: '#94a3b8',
    redEdge: '#ef4444',
    blueEdge: '#3b82f6',
    redPiece: '#e11d48',
    bluePiece: '#2563eb',
    hint: 'rgba(34,197,94,0.35)',
    hover: '#0ea5e9',
    lastMove: '#f59e0b',
    label: '#64748b'
  };

  /* ============================ 全局状态 ============================ */

  var canvas = document.getElementById('board');
  var ctx = canvas.getContext('2d');

  var boardWrap = document.getElementById('board-wrap');

  // 下拉框与按钮
  var sizeSel = document.getElementById('size');
  var modeSel = document.getElementById('mode');
  var diffSel = document.getElementById('difficulty');
  var newGameBtn = document.getElementById('newGame');
  var undoBtn = document.getElementById('undo');
  var hintBtn = document.getElementById('hint');
  var aiMoveBtn = document.getElementById('aiMove');
  var pauseBtn = document.getElementById('pause');

  // 状态显示区
  var turnIndicator = document.getElementById('turnIndicator');
  var messageEl = document.getElementById('message');
  var infoEl = document.getElementById('info');

  var state = null; // 当前棋局状态（见 newGame）
  var layout = null; // 当前画布布局 { size, originX, originY }
  var cssW = 0;
  var cssH = 0;
  var dpr = window.devicePixelRatio || 1;

  /* ============================ 棋局状态初始化 ============================ */

  function newGame() {
    var N = parseInt(sizeSel.value, 10);
    var mode = modeSel.value;

    var humanColor = null;
    var aiColor = null;
    if (mode === 'human-red') { humanColor = R; aiColor = B; }
    else if (mode === 'human-blue') { humanColor = B; aiColor = R; }

    state = {
      N: N,
      board: window.HexGame.createBoard(N),
      turn: R,                    // 红方先行
      mode: mode,
      humanColor: humanColor,
      aiColor: aiColor,
      difficulty: diffSel.value,
      history: [],                // [{r,c,color}, ...]
      gameOver: false,
      winner: null,
      aiThinking: false,
      aiRunning: false,           // AI 对战是否在自动进行
      aiTimer: null,
      lastMove: null,             // {r,c}
      hintCell: null,             // {r,c}
      hoverCell: null,            // {r,c}
      lastAIInfo: null            // {depth,nodes,score}
    };

    resize(); // 棋盘尺寸变化后重算布局并绘制
    updateStatus();

    // 若 AI 先行（我方执蓝 / AI 对战），启动 AI
    if (mode === 'human-blue') {
      scheduleAI();
    } else if (mode === 'ai-ai') {
      state.aiRunning = true;
      scheduleAI();
    }
  }

  /* ============================ 画布布局与绘制 ============================ */

  /** 根据容器尺寸计算六边形布局参数。 */
  function computeLayout(N, W, H) {
    // 菱形六边形棋盘的外接矩形（以 size 为单位）：
    //   宽 = √3·(1.5N - 0.5)，高 = 1.5N + 0.5
    var bw = Math.sqrt(3) * (1.5 * N - 0.5);
    var bh = 1.5 * N + 0.5;
    var margin = 1.0; // 预留边界高亮与坐标标签的空间
    var size = Math.min(W / (bw + 2 * margin), H / (bh + 2 * margin));

    var fieldW = bw * size;
    var fieldH = bh * size;
    // 原点：使整个棋盘在画布中居中
    var originX = (W - fieldW) / 2 + (Math.sqrt(3) / 2) * size;
    var originY = (H - fieldH) / 2 + size;
    return { size: size, originX: originX, originY: originY };
  }

  /** 重设画布物理尺寸（适配高清屏）并重新绘制。 */
  function resize() {
    cssW = boardWrap.clientWidth;
    cssH = boardWrap.clientHeight;
    if (!cssH) cssH = Math.round(cssW * 0.72);

    canvas.style.width = cssW + 'px';
    canvas.style.height = cssH + 'px';
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    if (state) {
      layout = computeLayout(state.N, cssW, cssH);
    }
    draw();
  }

  /** 格子 (r,c) 的像素中心坐标 [x,y]。 */
  function centerOfCell(r, c) {
    var s = layout.size;
    return [
      layout.originX + s * Math.sqrt(3) * (c + r / 2),
      layout.originY + s * 1.5 * r
    ];
  }

  /** 描画一个正六边形路径（点顶式：一个顶点朝上）。 */
  function hexPath(cx, cy, size) {
    ctx.beginPath();
    for (var i = 0; i < 6; i++) {
      var a = Math.PI / 180 * (-90 + 60 * i);
      var px = cx + size * Math.cos(a);
      var py = cy + size * Math.sin(a);
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
  }

  /** 返回六边形第 e 条边的两个端点坐标（e: 0~5）。 */
  function edgePoints(cx, cy, size, e) {
    var a1 = Math.PI / 180 * (-90 + 60 * e);
    var a2 = Math.PI / 180 * (-90 + 60 * ((e + 1) % 6));
    return [
      cx + size * Math.cos(a1), cy + size * Math.sin(a1),
      cx + size * Math.cos(a2), cy + size * Math.sin(a2)
    ];
  }

  /** 描画一条边（用于边界高亮）。 */
  function strokeEdge(cx, cy, size, e, color, width) {
    var p = edgePoints(cx, cy, size, e);
    ctx.beginPath();
    ctx.moveTo(p[0], p[1]);
    ctx.lineTo(p[2], p[3]);
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.stroke();
  }

  /** 主绘制函数：棋盘、棋子、高亮、标签。 */
  function draw() {
    if (!state || !layout) return;

    var N = state.N;
    var s = layout.size;

    ctx.clearRect(0, 0, cssW, cssH);
    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(0, 0, cssW, cssH);

    // —— 1. 画所有六边形格 ——
    for (var r = 0; r < N; r++) {
      for (var c = 0; c < N; c++) {
        var p = centerOfCell(r, c);
        hexPath(p[0], p[1], s * 0.96);
        ctx.fillStyle = COLORS.hexFill;
        ctx.fill();
        ctx.strokeStyle = COLORS.hexStroke;
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }

    // —— 2. 边界高亮（提示各色连通目标）——
    // 点顶式六边形的 6 条边编号：
    //   0 上右、1 右、2 下右、3 下左、4 上左、5 左
    for (var r2 = 0; r2 < N; r2++) {
      for (var c2 = 0; c2 < N; c2++) {
        var pc = centerOfCell(r2, c2);
        if (r2 === 0) { // 上边界：红
          strokeEdge(pc[0], pc[1], s, 0, COLORS.redEdge, s * 0.16);
          strokeEdge(pc[0], pc[1], s, 4, COLORS.redEdge, s * 0.16);
        }
        if (r2 === N - 1) { // 下边界：红
          strokeEdge(pc[0], pc[1], s, 2, COLORS.redEdge, s * 0.16);
          strokeEdge(pc[0], pc[1], s, 3, COLORS.redEdge, s * 0.16);
        }
        if (c2 === 0) { // 左边界：蓝
          strokeEdge(pc[0], pc[1], s, 5, COLORS.blueEdge, s * 0.16);
        }
        if (c2 === N - 1) { // 右边界：蓝
          strokeEdge(pc[0], pc[1], s, 1, COLORS.blueEdge, s * 0.16);
        }
      }
    }

    // —— 3. 提示 / 悬停 / 最后一步高亮 ——
    if (state.hintCell) {
      var hp = centerOfCell(state.hintCell.r, state.hintCell.c);
      hexPath(hp[0], hp[1], s * 0.9);
      ctx.fillStyle = COLORS.hint;
      ctx.fill();
    }
    if (state.hoverCell && isCellEmpty(state.hoverCell.r, state.hoverCell.c)) {
      var hvp = centerOfCell(state.hoverCell.r, state.hoverCell.c);
      hexPath(hvp[0], hvp[1], s * 0.9);
      ctx.strokeStyle = COLORS.hover;
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    if (state.lastMove) {
      var lp = centerOfCell(state.lastMove.r, state.lastMove.c);
      ctx.beginPath();
      ctx.arc(lp[0], lp[1], s * 0.9, 0, Math.PI * 2);
      ctx.strokeStyle = COLORS.lastMove;
      ctx.lineWidth = 2.5;
      ctx.stroke();
    }

    // —— 4. 画棋子 ——
    for (var r3 = 0; r3 < N; r3++) {
      for (var c3 = 0; c3 < N; c3++) {
        var v = state.board[window.HexGame.idx(r3, c3, N)];
        if (v !== EMPTY) {
          drawPiece(r3, c3, v);
        }
      }
    }

    // —— 5. 坐标标签（列：字母；行：数字）——
    drawLabels(N);
  }

  /** 在 (r,c) 画一枚圆形棋子（略小于六边形）。 */
  function drawPiece(r, c, color) {
    var p = centerOfCell(r, c);
    var s = layout.size;
    var rad = s * 0.78;

    // 阴影
    ctx.beginPath();
    ctx.arc(p[0], p[1] + s * 0.06, rad, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0,0,0,0.22)';
    ctx.fill();

    // 立体渐变球体
    var g = ctx.createRadialGradient(p[0] - rad * 0.35, p[1] - rad * 0.35, rad * 0.1, p[0], p[1], rad);
    if (color === R) {
      g.addColorStop(0, '#fda4af');
      g.addColorStop(1, COLORS.redPiece);
    } else {
      g.addColorStop(0, '#93c5fd');
      g.addColorStop(1, COLORS.bluePiece);
    }
    ctx.beginPath();
    ctx.arc(p[0], p[1], rad, 0, Math.PI * 2);
    ctx.fillStyle = g;
    ctx.fill();

    // 描边
    ctx.strokeStyle = color === R ? '#9f1239' : '#1e40af';
    ctx.lineWidth = 1.2;
    ctx.stroke();
  }

  /** 绘制列字母（上）与行数字（左）坐标标签。 */
  function drawLabels(N) {
    ctx.fillStyle = COLORS.label;
    ctx.font = Math.max(11, Math.round(layout.size * 0.5)) + 'px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    // 列字母 A、B、C…
    for (var c = 0; c < N; c++) {
      var p = centerOfCell(0, c);
      var letter = String.fromCharCode(65 + c);
      ctx.fillText(letter, p[0], layout.originY - layout.size * 1.45);
    }
    // 行数字 1、2、3…
    for (var r = 0; r < N; r++) {
      var q = centerOfCell(r, 0);
      ctx.fillText(String(r + 1), q[0] - layout.size * Math.sqrt(3) / 2 - layout.size * 0.55, q[1]);
    }
  }

  /* ============================ 坐标换算 ============================ */

  /** 像素坐标 -> 最近六边形格子的轴向坐标 [r,c]（用立方坐标取整）。 */
  function pixelToCell(px, py) {
    var s = layout.size;
    var x = (px - layout.originX) / s;
    var y = (py - layout.originY) / s;

    // 轴向(pointy-top) -> 立方坐标：q = √3/3·x - 1/3·y，r = 2/3·y
    var q = (Math.sqrt(3) / 3) * x - (1 / 3) * y;
    var rr = (2 / 3) * y;

    // 立方坐标取整（保证结果仍在网格上）
    var rx = Math.round(q);
    var ry = Math.round(-q - rr);
    var rz = Math.round(rr);
    var dx = Math.abs(rx - q);
    var dy = Math.abs(ry - (-q - rr));
    var dz = Math.abs(rz - rr);
    if (dx > dy && dx > dz) rx = -ry - rz;
    else if (dy > dz) ry = -rx - rz;
    else rz = -rx - ry;

    return [rz, rx]; // 返回 [r, c]
  }

  function isCellEmpty(r, c) {
    if (!state) return false;
    if (r < 0 || r >= state.N || c < 0 || c >= state.N) return false;
    return state.board[window.HexGame.idx(r, c, state.N)] === EMPTY;
  }

  /* ============================ 落子与流程 ============================ */

  /** 人类/程序在 (r,c) 落 color 一子，并推进对局流程。 */
  function makeMove(r, c, color) {
    if (state.gameOver) return;
    if (r < 0 || r >= state.N || c < 0 || c >= state.N) return;
    if (state.board[window.HexGame.idx(r, c, state.N)] !== EMPTY) return;

    state.board[window.HexGame.idx(r, c, state.N)] = color;
    state.history.push({ r: r, c: c, color: color });
    state.lastMove = { r: r, c: c };
    state.hintCell = null;
    state.hoverCell = null;

    var win = window.HexGame.isWinAfterMove(state.board, state.N, color, r, c);
    if (win) {
      state.gameOver = true;
      state.winner = color;
      stopAI();
    } else {
      state.turn = window.HexGame.opponent(color);
    }

    updateStatus();
    draw();

    if (!state.gameOver) {
      scheduleIfAI();
    }
  }

  /** 根据当前局面判断是否需要 AI 走棋。 */
  function scheduleIfAI() {
    if (state.gameOver) return;
    if (state.mode === 'ai-ai') {
      if (state.aiRunning) startAIThinking();
    } else if (state.mode === 'human-red' || state.mode === 'human-blue') {
      if (state.turn === state.aiColor) startAIThinking();
    }
    // pvp：无需 AI
  }

  /** 安排 AI 在短暂延时后走棋（先让界面刷新出“思考中”）。 */
  function scheduleAI() {
    startAIThinking();
  }

  function startAIThinking() {
    if (state.aiThinking || state.gameOver) return;
    state.aiThinking = true;
    updateStatus();
    state.aiTimer = setTimeout(function () {
      state.aiTimer = null;
      runAIMove(state.turn);
    }, 60);
  }

  /** 执行一次 AI 决策并落子。 */
  function runAIMove(color) {
    var cfg = DIFFICULTY[state.difficulty] || DIFFICULTY.medium;
    var res = window.HexAI.findBestMove(state.board, state.N, color, cfg);

    state.aiThinking = false;
    if (state.gameOver) {
      updateStatus();
      return;
    }
    if (!res) {
      updateStatus();
      return;
    }

    state.lastAIInfo = { depth: res.depth, nodes: res.nodes, score: res.score };
    makeMove(res.r, res.c, color);
  }

  /** 停止 AI（包括自动对战与正在排队的计时器）。 */
  function stopAI() {
    state.aiRunning = false;
    state.aiThinking = false;
    if (state.aiTimer) {
      clearTimeout(state.aiTimer);
      state.aiTimer = null;
    }
  }

  /* ============================ 悔棋 / 提示 ============================ */

  function undo() {
    if (!state || state.aiThinking) return;

    // AI 自动对战时先暂停
    if (state.mode === 'ai-ai' && state.aiRunning) {
      state.aiRunning = false;
      state.aiThinking = false;
      if (state.aiTimer) { clearTimeout(state.aiTimer); state.aiTimer = null; }
      updateStatus();
    }

    if (state.history.length === 0) return;

    // 双人：只回退一步；人机：回退到“轮到人类”为止（通常回退一整轮）
    while (state.history.length > 0) {
      var last = state.history.pop();
      state.board[window.HexGame.idx(last.r, last.c, state.N)] = EMPTY;
      state.turn = last.color; // 被撤销的那一步由该色重新走

      if (state.mode === 'pvp') break;
      if (state.mode === 'human-red' || state.mode === 'human-blue') {
        if (state.turn === state.humanColor) break;
      } else {
        break;
      }
    }

    state.gameOver = false;
    state.winner = null;
    state.hintCell = null;
    state.lastMove = state.history.length ? state.history[state.history.length - 1] : null;
    state.lastAIInfo = null;

    updateStatus();
    draw();

    // 若悔棋后轮到 AI（例如“我方执蓝”时撤销了 AI 的开局），让 AI 继续走棋
    scheduleIfAI();
  }

  function hint() {
    if (!state || state.gameOver || state.aiThinking) return;
    var cfg = { maxDepth: 3, timeLimitMs: 300 };
    var res = window.HexAI.findBestMove(state.board, state.N, state.turn, cfg);
    if (res) {
      state.hintCell = { r: res.r, c: res.c };
      draw();
    }
  }

  /** “AI 落子”按钮：让 AI 替当前行棋方走一步。 */
  function aiMoveNow() {
    if (!state || state.gameOver || state.aiThinking) return;
    startAIThinking(); // 用当前 turn 走棋
  }

  /** “暂停/继续”按钮：控制 AI 自动对战。 */
  function togglePause() {
    if (!state) return;
    if (state.mode !== 'ai-ai') return;

    if (state.aiRunning) {
      state.aiRunning = false;
      state.aiThinking = false;
      if (state.aiTimer) { clearTimeout(state.aiTimer); state.aiTimer = null; }
      updateStatus();
      messageEl.textContent = '已暂停（AI 对战）';
    } else {
      state.aiRunning = true;
      if (!state.gameOver) scheduleIfAI();
      updateStatus();
    }
  }

  /* ============================ 状态显示 ============================ */

  function updateStatus() {
    if (!state) return;

    var colorName = function (c) { return c === R ? '红方' : '蓝方'; };
    var goal = function (c) { return c === R ? '连通上下' : '连通左右'; };

    // 回合指示
    var dot = state.turn === R ? '🔴' : '🔵';
    turnIndicator.innerHTML =
      '<span class="dot ' + (state.turn === R ? 'red' : 'blue') + '"></span>' +
      ' 轮到 ' + colorName(state.turn) + '（' + goal(state.turn) + '）';

    if (state.aiThinking) {
      messageEl.textContent = 'AI 正在思考…';
    } else if (state.gameOver) {
      messageEl.textContent = '🎉 ' + colorName(state.winner) + '获胜！';
    } else {
      messageEl.textContent = '';
    }

    // 信息栏
    var modeName = {
      'human-red': '人机 · 我方执红',
      'human-blue': '人机 · 我方执蓝',
      'pvp': '双人对战',
      'ai-ai': 'AI 对战'
    }[state.mode];
    var diffName = { easy: '简单', medium: '中等', hard: '困难' }[state.difficulty];

    var info = '棋盘 ' + state.N + '×' + state.N + ' · 已落子 ' + state.history.length +
      ' · ' + modeName + ' · 难度 ' + diffName;
    if (state.lastAIInfo) {
      info += ' · AI 搜索深度 ' + state.lastAIInfo.depth + ' · 节点 ' + state.lastAIInfo.nodes;
    }
    infoEl.textContent = info;

    // 按钮可用性
    pauseBtn.disabled = state.mode !== 'ai-ai';
  }

  /* ============================ 事件绑定 ============================ */

  function canvasPos(evt) {
    var rect = canvas.getBoundingClientRect();
    return [evt.clientX - rect.left, evt.clientY - rect.top];
  }

  canvas.addEventListener('click', function (evt) {
    if (!state || state.gameOver || state.aiThinking) return;

    // 人机模式下只允许人类落子
    if (state.mode === 'human-red' || state.mode === 'human-blue') {
      if (state.turn !== state.humanColor) return;
    }
    // AI 对战模式下不允许点击落子
    if (state.mode === 'ai-ai') return;

    var pos = canvasPos(evt);
    var cell = pixelToCell(pos[0], pos[1]);
    var r = cell[0], c = cell[1];
    if (isCellEmpty(r, c)) {
      makeMove(r, c, state.turn);
    }
  });

  canvas.addEventListener('mousemove', function (evt) {
    if (!state) return;
    var pos = canvasPos(evt);
    var cell = pixelToCell(pos[0], pos[1]);
    var r = cell[0], c = cell[1];
    var next = isCellEmpty(r, c) ? { r: r, c: c } : null;
    if ((state.hoverCell && next && state.hoverCell.r === next.r && state.hoverCell.c === next.c) ||
        (!state.hoverCell && !next)) {
      return; // 未变化，不重绘
    }
    state.hoverCell = next;
    draw();
  });

  canvas.addEventListener('mouseleave', function () {
    if (state && state.hoverCell) {
      state.hoverCell = null;
      draw();
    }
  });

  newGameBtn.addEventListener('click', function () { newGame(); });
  undoBtn.addEventListener('click', undo);
  hintBtn.addEventListener('click', hint);
  aiMoveBtn.addEventListener('click', aiMoveNow);
  pauseBtn.addEventListener('click', togglePause);

  sizeSel.addEventListener('change', function () { newGame(); });
  modeSel.addEventListener('change', function () { newGame(); });
  diffSel.addEventListener('change', function () {
    if (state) { state.difficulty = diffSel.value; updateStatus(); }
  });

  window.addEventListener('resize', function () { resize(); });

  /* ============================ 启动 ============================ */

  newGame();
})();
