/**
 * ai.js —— 海克斯棋（Hex）行棋策略（AI 决策引擎）
 * ============================================================================
 * 本文件实现“走哪一步棋”的搜索算法，对应实验分工中的“行棋策略”。
 *
 * 采用的技术：
 *   1. 迭代加深（Iterative Deepening）       —— 由浅入深逐层搜索，便于限时；
 *   2. Alpha-Beta 剪枝                        —— 减少无效搜索分支；
 *   3. 置换表（Transposition Table，Zobrist） —— 记住已搜索局面，避免重复计算；
 *   4. 走法排序（Move Ordering）              —— 优先搜索更可能好的着法，提升剪枝效率；
 *   5. 战术先手处理                           —— 能立即获胜就立刻走，能立即封堵就立刻封堵；
 *   6. 限时搜索                               —— 到时间立刻返回当前最优解。
 *
 * 评估函数（evaluate / computeDistance）定义在 game.js 中：
 *   用“两色连通距离差”衡量局面，红方为极大方、蓝方为极小方做 minimax。
 *
 * 依赖：本文件假定全局已存在 HexGame（由 game.js 提供）。
 * 本文件同样采用 UMD 风格导出，便于 Node.js 单元测试。
 */
(function (global) {
  'use strict';

  var HexGame = global.HexGame;

  /** 局面胜负常量（远大于任何评估值） */
  var WIN_SCORE = 100000;

  /** 置换表条目类型（本实现只存储“精确值”，避免上下界标记带来的边界错误） */
  var TT_EXACT = 0;

  /** 当前时间预算（毫秒，基于 performance.now） */
  var deadline = 0;
  /** 是否因超时而中止搜索 */
  var aborted = false;
  /** 已访问节点数（用于统计/展示） */
  var nodes = 0;

  /** 置换表：key -> { key, depth, value, bestR, bestC } */
  var TT = new Map();

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

  /**
   * 把某个“优先着法”移到列表最前，其余保持原有（热度）顺序。
   * 优先着法通常来自：上一轮迭代深化的最优解（PV），或置换表记录的最佳着。
   */
  function orderMoves(moves, preferred) {
    if (!preferred) return;
    for (var i = 0; i < moves.length; i++) {
      if (moves[i][0] === preferred.r && moves[i][1] === preferred.c) {
        var tmp = moves[0];
        moves[0] = moves[i];
        moves[i] = tmp;
        return;
      }
    }
  }

  /* ============================ Alpha-Beta 搜索 ============================ */

  /**
   * 核心搜索：返回从“红方视角”的局面价值（红极大、蓝极小）。
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
    // 限时中止：一旦超时，立即返回一个“无效值”，由上层丢弃结果。
    if (aborted) return 0;
    nodes++;

    if (depth === 0) {
      // 到达叶子节点：直接用“连通距离差”评估（红方视角）
      return HexGame.evaluate(board, N, HexGame.RED);
    }

    // —— 置换表查询 ——
    var key = zobristHash(board, N, turn);
    var entry = TT.get(key);
    var ttMove = null;
    if (entry && entry.depth >= depth && entry.flag === TT_EXACT) {
      return entry.value; // 已搜索过且深度足够，直接复用精确值
    }
    if (entry && entry.bestR != null) {
      ttMove = { r: entry.bestR, c: entry.bestC };
    }

    // —— 生成并排序候选着法 ——
    var moves = HexGame.candidateMoves(board, N);
    if (moves.length === 0) {
      return 0; // 棋盘已满（理论上不会发生：Hex 无平局）
    }
    orderMoves(moves, ttMove);

    var best;
    var bestMove = moves[0];
    var cutoff = false; // 是否发生 Alpha-Beta 剪枝（剪枝则不存精确值）

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
          cutoff = true;
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
          cutoff = true;
          break;
        }
      }
    }

    // 仅在“完整搜索完毕、未发生剪枝”时写入精确值，
    // 这样置换表查询逻辑简单可靠，不会引入上下界判断错误。
    if (!cutoff && !aborted) {
      TT.set(key, {
        key: key,
        depth: depth,
        flag: TT_EXACT,
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
   * 并支持把上一轮迭代的最优解作为本轮的优先排序（PV 排序）。
   */
  function searchRoot(board, N, turn, depth, preferred) {
    var moves = HexGame.candidateMoves(board, N);
    if (moves.length === 0) return null;
    orderMoves(moves, preferred);

    var alpha = -Infinity;
    var beta = Infinity;
    var bestMove = moves[0];
    var best;

    if (turn === HexGame.RED) {
      best = -Infinity;
      for (var i = 0; i < moves.length; i++) {
        var r = moves[i][0];
        var c = moves[i][1];
        board[HexGame.idx(r, c, N)] = HexGame.RED;

        var v;
        if (HexGame.isWinAfterMove(board, N, HexGame.RED, r, c)) {
          v = WIN_SCORE;
        } else {
          v = alphaBeta(board, N, HexGame.BLUE, depth - 1, alpha, beta);
        }

        board[HexGame.idx(r, c, N)] = HexGame.EMPTY;

        if (v > best) {
          best = v;
          bestMove = moves[i];
        }
        if (best > alpha) alpha = best;
        if (alpha >= beta) break;
      }
    } else {
      best = Infinity;
      for (var j = 0; j < moves.length; j++) {
        var br = moves[j][0];
        var bc = moves[j][1];
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
          bestMove = moves[j];
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
    var nowFn = (typeof performance !== 'undefined' && performance.now)
      ? function () { return performance.now(); }
      : function () { return Date.now(); };

    deadline = nowFn() + timeLimitMs;
    aborted = false;
    nodes = 0;
    TT = new Map(); // 每轮决策清空置换表，避免残留旧局面

    var moves = HexGame.candidateMoves(board, N);
    if (moves.length === 0) return null;
    if (moves.length === 1) {
      return { r: moves[0][0], c: moves[0][1], score: 0, depth: 1, nodes: 1 };
    }

    // —— 战术 1：一步获胜 ——
    // 若我方存在某个空格，落下即可连通，直接走它。
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
    // 若对手存在某个空格，落下即可连通，则我方必须先抢占该点。
    // 海克斯棋中这样的“必堵点”通常是唯一且强制的。
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
