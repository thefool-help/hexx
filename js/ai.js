/**
 * ai.js —— 海克斯棋（Hex）行棋策略（AI 决策引擎）
 * ============================================================================
 * 本文件实现“走哪一步棋”的搜索算法，对应实验分工中的“行棋策略”。
 *
 * 采用的技术：
 *   1. 迭代加深（Iterative Deepening）          —— 由浅入深逐层搜索，便于限时；
 *   2. Alpha-Beta 剪枝（fail-soft）              —— 减少无效搜索分支；
 *   3. 置换表（Transposition Table，Zobrist）    —— 精确值 + 上/下界标记，
 *                                                  跨深度复用搜索结果；
 *   4. 走法排序（Move Ordering）                 —— 置换表最佳着 → 杀手着法 →
 *                                                  根节点静态评估排序，提升剪枝效率；
 *   5. 战术先手处理                             —— 能立即获胜就立刻走，能立即封堵就立刻封堵；
 *   6. 限时搜索                                 —— 搜索过程中周期性检查时间，超时安全返回。
 *
 * 评估函数（evaluate / computeDistance）定义在 game.js 中：
 *   用“两色连通距离差”衡量局面，红方为极大方、蓝方为极小方做 minimax。
 *   在叶子节点额外加入“行棋方节奏”微小修正，打破对称局面的平手盲点。
 *
 * 依赖：本文件假定全局已存在 HexGame（由 game.js 提供）。
 * 本文件同样采用 UMD 风格导出，便于 Node.js 单元测试。
 */
(function (global) {
  'use strict';

  var HexGame = global.HexGame;

  /** 局面胜负常量（远大于任何评估值） */
  var WIN_SCORE = 100000;

  /** 置换表条目类型 */
  var TT_EXACT = 0;  // 精确值
  var TT_LOWER = 1;  // fail-high：value 是真实值的下界
  var TT_UPPER = 2;  // fail-low ：value 是真实值的上界

  /** 叶子节点“行棋方节奏”修正量（远小于一格距离，仅用于打破平手） */
  var TEMPO = 1;

  /** 内部节点最多考察的候选着法数（按热度排序截断，降低分支、加深搜索） */
  var MAX_CANDIDATES = 20;
  /** 根节点最多考察的候选着法数（保留更多，避免漏掉全局最佳） */
  var ROOT_CANDIDATES = 36;

  /** 当前时间预算（毫秒，基于 performance.now） */
  var deadline = 0;
  /** 是否因超时而中止搜索 */
  var aborted = false;
  /** 已访问节点数（用于统计/展示） */
  var nodes = 0;

  /** 计时函数（在 findBestMove 中按环境赋值） */
  var nowFn = function () { return Date.now(); };

  /** 置换表：key -> { key, depth, flag, value, bestR, bestC } */
  var TT = new Map();

  /** 杀手着法表：killerMoves[depth] = [{r,c}, {r,c}]（最近一次先） */
  var killerMoves = [];

  /* ============================ Zobrist 哈希 ============================ */

  // 不同棋盘尺寸使用不同的随机表（避免不同尺寸串味），按 N 缓存。
  var zobristCache = new Map();

  /**
   * 生成一个确定性的 32 位随机数序列，作为 Zobrist 表。
   * 用 xorshift 生成器（固定种子），保证每次运行哈希一致、可复现。
   */
  function makeZobrist(N) {
    var table = new Uint32Array(N * N * 3);
    var s = 0x12345678;
    for (var i = 0; i < table.length; i++) {
      s ^= s << 13;
      s ^= s >>> 17;
      s ^= s << 5;
      s >>>= 0;
      table[i] = s;
    }
    return table;
  }

  function getZobrist(N) {
    var t = zobristCache.get(N);
    if (!t) {
      t = makeZobrist(N);
      zobristCache.set(N, t);
    }
    return t;
  }

  /**
   * 计算“棋盘 + 轮到谁走”的 Zobrist 哈希值（32 位无符号整数）。
   * 每个格子有 3 种状态（空/红/蓝），对应 3 个随机数；再异或上行棋方。
   */
  function zobristHash(board, N, turn) {
    var t = getZobrist(N);
    var h = 0;
    for (var i = 0; i < N * N; i++) {
      h ^= t[i * 3 + board[i]];
    }
    // 把“轮到谁走”折入哈希，避免不同行棋方被当成同一局面
    h ^= (turn * 0x9E3779B1) >>> 0;
    return h >>> 0;
  }

  /* ============================ 走法排序辅助 ============================ */

  /** 把坐标 (r,c) 对应的着法移到列表最前（若存在）。 */
  function moveToFront(moves, r, c) {
    for (var i = 0; i < moves.length; i++) {
      if (moves[i][0] === r && moves[i][1] === c) {
        var tmp = moves[0];
        moves[0] = moves[i];
        moves[i] = tmp;
        return;
      }
    }
  }

  /** 记录一个在 depth 层触发剪枝的杀手着法（每层保留最近两个）。 */
  function storeKiller(depth, r, c) {
    var slot = killerMoves[depth];
    if (!slot) {
      slot = [null, null];
      killerMoves[depth] = slot;
    }
    if (slot[0] && slot[0].r === r && slot[0].c === c) return;
    slot[1] = slot[0];
    slot[0] = { r: r, c: c };
  }

  /* ============================ Alpha-Beta 搜索 ============================ */

  /**
   * 核心搜索：返回从“红方视角”的局面价值（红极大、蓝极小），采用 fail-soft。
   *
   * @param {Int8Array} board 当前棋盘
   * @param {number}    N     棋盘边长
   * @param {number}    turn  轮到谁走（RED 或 BLUE）
   * @param {number}    depth 剩余搜索深度（>0）
   * @param {number}    alpha Alpha 下界
   * @param {number}    beta  Beta 上界
   * @returns {number} 局面价值（红方视角）
   */
  function alphaBeta(board, N, turn, depth, alpha, beta) {
    // 一旦超时中止，所有递归调用立即快速回退（每节点一次廉价判断）
    if (aborted) return 0;
    nodes++;
    // 周期性检查时间预算（每 1024 个节点查一次），超时置位中止
    if ((nodes & 1023) === 0 && nowFn() >= deadline) {
      aborted = true;
      return 0;
    }

    if (depth === 0) {
      // 叶子节点：连通距离差评估 + 行棋方节奏微调
      var leaf = HexGame.evaluate(board, N, HexGame.RED);
      return turn === HexGame.RED ? leaf + TEMPO : leaf - TEMPO;
    }

    // —— 置换表查询 ——
    var key = zobristHash(board, N, turn);
    var entry = TT.get(key);
    var ttMove = null;
    if (entry && entry.depth >= depth) {
      if (entry.flag === TT_EXACT) return entry.value;
      if (entry.flag === TT_LOWER && entry.value >= beta) return entry.value; // 下界已超过 beta，剪枝
      if (entry.flag === TT_UPPER && entry.value <= alpha) return entry.value; // 上界已低于 alpha，剪枝
    }
    if (entry && entry.bestR != null) {
      ttMove = { r: entry.bestR, c: entry.bestC };
    }

    // —— 生成候选着法并排序 ——
    var moves = HexGame.candidateMoves(board, N);
    if (moves.length === 0) {
      return 0; // 棋盘已满（理论上不会发生：Hex 无平局）
    }

    // 杀手着法先上前（次近的在前、最近的最后上前，最终“最近”排第一）
    var killers = killerMoves[depth];
    if (killers) {
      for (var ki = 1; ki >= 0; ki--) {
        var km = killers[ki];
        if (km) moveToFront(moves, km.r, km.c);
      }
    }
    // 置换表最佳着最后上前，保证它排在最前
    if (ttMove) moveToFront(moves, ttMove.r, ttMove.c);

    // 内部节点截断候选数（置换表最佳着/杀手着法已排在前，不会被截掉）
    if (moves.length > MAX_CANDIDATES) moves.length = MAX_CANDIDATES;

    var best;
    var bestMove = moves[0];
    var origAlpha = alpha;
    var origBeta = beta;

    if (turn === HexGame.RED) {
      /* ===== 极大方：红方 ===== */
      best = -Infinity;
      for (var i = 0; i < moves.length; i++) {
        var r = moves[i][0];
        var c = moves[i][1];
        board[HexGame.idx(r, c, N)] = HexGame.RED;

        var v;
        if (HexGame.isWinAfterMove(board, N, HexGame.RED, r, c)) {
          v = WIN_SCORE; // 红方此步直接获胜
        } else {
          v = alphaBeta(board, N, HexGame.BLUE, depth - 1, alpha, beta);
        }

        board[HexGame.idx(r, c, N)] = HexGame.EMPTY; // 撤销，恢复棋盘

        if (v > best) {
          best = v;
          bestMove = moves[i];
        }
        if (best > alpha) alpha = best;
        if (alpha >= beta) {
          storeKiller(depth, bestMove[0], bestMove[1]);
          break;
        }
      }
    } else {
      /* ===== 极小方：蓝方 ===== */
      best = Infinity;
      for (var j = 0; j < moves.length; j++) {
        var br = moves[j][0];
        var bc = moves[j][1];
        board[HexGame.idx(br, bc, N)] = HexGame.BLUE;

        var bv;
        if (HexGame.isWinAfterMove(board, N, HexGame.BLUE, br, bc)) {
          bv = -WIN_SCORE; // 蓝方获胜，对红方而言是必败
        } else {
          bv = alphaBeta(board, N, HexGame.RED, depth - 1, alpha, beta);
        }

        board[HexGame.idx(br, bc, N)] = HexGame.EMPTY; // 撤销

        if (bv < best) {
          best = bv;
          bestMove = moves[j];
        }
        if (best < beta) beta = best;
        if (alpha >= beta) {
          storeKiller(depth, bestMove[0], bestMove[1]);
          break;
        }
      }
    }

    // —— 写回置换表（含上下界标记；超时中止则放弃本次结果）——
    if (!aborted) {
      var flag;
      if (best <= origAlpha) {
        flag = TT_UPPER;         // 未超过原下界：best 是上界
      } else if (best >= origBeta) {
        flag = TT_LOWER;         // 已达到/超过原上界：best 是下界
      } else {
        flag = TT_EXACT;
      }
      TT.set(key, {
        key: key,
        depth: depth,
        flag: flag,
        value: best,
        bestR: bestMove[0],
        bestC: bestMove[1]
      });
    }

    return best;
  }

  /**
   * 在根节点单独做一次搜索，并返回“最优着法 + 价值”。
   * 与内部 alphaBeta 的区别：根节点需要记录具体走哪一步，
   * 并用“静态评估”对所有候选着法做一次排序（利于 Alpha-Beta 剪枝）。
   */
  function searchRoot(board, N, turn, depth, preferred) {
    var moves = HexGame.candidateMoves(board, N);
    if (moves.length === 0) return null;

    // —— 根节点静态评估排序：按“落子后己方局面评估”从高到低 ——
    if (moves.length > 1) {
      var scored = new Array(moves.length);
      for (var i = 0; i < moves.length; i++) {
        var sr = moves[i][0];
        var sc = moves[i][1];
        board[HexGame.idx(sr, sc, N)] = turn;
        scored[i] = { move: moves[i], score: HexGame.evaluate(board, N, turn) };
        board[HexGame.idx(sr, sc, N)] = HexGame.EMPTY;
      }
      scored.sort(function (a, b) { return b.score - a.score; });
      for (var j = 0; j < scored.length; j++) {
        moves[j] = scored[j].move;
      }
    }
    // 上一轮迭代的最佳着法（PV）提到最前
    if (preferred) moveToFront(moves, preferred[0], preferred[1]);

    // 根节点截断候选数（保留更多候选，静态排序后按评估截断）
    if (moves.length > ROOT_CANDIDATES) moves.length = ROOT_CANDIDATES;

    var alpha = -Infinity;
    var beta = Infinity;
    var bestMove = moves[0];
    var best;

    if (turn === HexGame.RED) {
      best = -Infinity;
      for (var i2 = 0; i2 < moves.length; i2++) {
        var rr = moves[i2][0];
        var cc = moves[i2][1];
        board[HexGame.idx(rr, cc, N)] = HexGame.RED;

        var v;
        if (HexGame.isWinAfterMove(board, N, HexGame.RED, rr, cc)) {
          v = WIN_SCORE;
        } else {
          v = alphaBeta(board, N, HexGame.BLUE, depth - 1, alpha, beta);
        }

        board[HexGame.idx(rr, cc, N)] = HexGame.EMPTY;

        if (v > best) {
          best = v;
          bestMove = moves[i2];
        }
        if (best > alpha) alpha = best;
        if (alpha >= beta) break;
      }
    } else {
      best = Infinity;
      for (var j2 = 0; j2 < moves.length; j2++) {
        var br = moves[j2][0];
        var bc = moves[j2][1];
        board[HexGame.idx(br, bc, N)] = HexGame.BLUE;

        var bv;
        if (HexGame.isWinAfterMove(board, N, HexGame.BLUE, br, bc)) {
          bv = -WIN_SCORE;
        } else {
          bv = alphaBeta(board, N, HexGame.RED, depth - 1, alpha, beta);
        }

        board[HexGame.idx(br, bc, N)] = HexGame.EMPTY;

        if (bv < best) {
          best = bv;
          bestMove = moves[j2];
        }
        if (best < beta) beta = best;
        if (alpha >= beta) break;
      }
    }

    return { value: best, move: bestMove };
  }

  /* ============================ 对外主接口 ============================ */

  /**
   * 求当前局面下 color 的最佳落子。
   *
   * 流程：
   *   1. 若只有唯一空位，直接返回；
   *   2. 若能“一步获胜”，立即返回该点（先手必胜，无需再搜）；
   *   3. 若对手存在“一步获胜”的威胁，立即抢占该点（封堵）；
   *   4. 否则迭代加深 + Alpha-Beta 搜索，限时返回最优解。
   *
   * @param {Int8Array} board 棋盘
   * @param {number}    N     棋盘边长
   * @param {number}    color 我方颜色（RED/BLUE）
   * @param {object}    opts  { timeLimitMs, maxDepth }
   * @returns {{r:number,c:number,score:number,depth:number,nodes:number}|null}
   */
  function findBestMove(board, N, color, opts) {
    opts = opts || {};
    var timeLimitMs = opts.timeLimitMs || 1500;
    var maxDepth = opts.maxDepth || 6;

    // 统一使用 performance.now（Node 16+ 与浏览器都提供）；兜底 Date.now。
    nowFn = (typeof performance !== 'undefined' && performance.now)
      ? function () { return performance.now(); }
      : function () { return Date.now(); };

    deadline = nowFn() + timeLimitMs;
    aborted = false;
    nodes = 0;
    TT = new Map();       // 每轮决策清空置换表，避免残留旧局面
    killerMoves = [];     // 每轮决策重置杀手着法表

    var moves = HexGame.candidateMoves(board, N);
    if (moves.length === 0) return null;
    if (moves.length === 1) {
      return { r: moves[0][0], c: moves[0][1], score: 0, depth: 1, nodes: 1 };
    }

    // —— 战术 1：一步获胜 ——
    for (var i = 0; i < moves.length; i++) {
      var r = moves[i][0];
      var c = moves[i][1];
      board[HexGame.idx(r, c, N)] = color;
      var win = HexGame.isWinAfterMove(board, N, color, r, c);
      board[HexGame.idx(r, c, N)] = HexGame.EMPTY;
      if (win) {
        return { r: r, c: c, score: WIN_SCORE, depth: 1, nodes: 1 };
      }
    }

    // —— 战术 2：封堵对手的一步获胜 ——
    var opp = HexGame.opponent(color);
    for (var k = 0; k < moves.length; k++) {
      var br = moves[k][0];
      var bc = moves[k][1];
      board[HexGame.idx(br, bc, N)] = opp;
      var oppWin = HexGame.isWinAfterMove(board, N, opp, br, bc);
      board[HexGame.idx(br, bc, N)] = HexGame.EMPTY;
      if (oppWin) {
        return { r: br, c: bc, score: 0, depth: 1, nodes: 1 };
      }
    }

    // —— 迭代加深 + Alpha-Beta ——
    var bestMove = moves[0];
    var bestScore = -Infinity;
    var completedDepth = 0;

    for (var depth = 1; depth <= maxDepth; depth++) {
      if (nowFn() >= deadline) break; // 开始新一层前先看时间

      var res = searchRoot(board, N, color, depth, bestMove);
      if (aborted) break; // 层内超时：丢弃这一层结果，返回上一层的可靠解

      bestScore = res.value;
      bestMove = res.move;
      completedDepth = depth;

      // 已找到必胜解，继续加深没有意义
      if (bestScore >= WIN_SCORE - 1) break;
    }

    return {
      r: bestMove[0],
      c: bestMove[1],
      score: bestScore,
      depth: completedDepth,
      nodes: nodes
    };
  }

  /* ============================ 导出 ============================ */

  var HexAI = {
    WIN_SCORE: WIN_SCORE,
    findBestMove: findBestMove,
    // 额外导出内部函数，便于测试
    _alphaBeta: alphaBeta,
    _zobristHash: zobristHash,
    _searchRoot: searchRoot
  };

  global.HexAI = HexAI;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = HexAI;
  }
})(typeof window !== 'undefined' ? window : globalThis);
