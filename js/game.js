/**
 * game.js —— 海克斯棋（Hex）核心规则、落子判定与棋局评估
 * ============================================================================
 * 本文件实现与“界面/搜索”无关的纯逻辑部分，对应实验分工中的：
 *   · 界面设计与判定  —— 落子合法性、胜负判定（isWin / isWinAfterMove）
 *   · 棋局评估        —— 用两色“连通距离差”衡量局面优劣（evaluate / computeDistance）
 *
 * 棋盘说明（菱形棋盘，N×N 个正六边形格子）：
 *   - 采用“轴向坐标”(axial coordinates)，点顶式六边形。
 *   - 记格子为 (r, c)，其中 r 为行号、c 为列号，范围均为 [0, N-1]。
 *   - 六个邻居方向（见下方 DIRS）。
 *   - 红方（RED  = 1）：连通 上边界 <-> 下边界 即获胜。
 *   - 蓝方（BLUE = 2）：连通 左边界 <-> 右边界 即获胜。
 *   - 红方先行。海克斯棋不存在平局（Hex 定理保证总有一方连通）。
 *
 * 本文件采用 UMD 风格导出，既可在浏览器中通过 <script> 引入（挂到 window），
 * 也可在 Node.js 中 require 用于单元测试。
 */
(function (global) {
  'use strict';

  /* ============================ 常量定义 ============================ */

  /** 空位 */
  var EMPTY = 0;
  /** 红方：连接上、下边界 */
  var RED = 1;
  /** 蓝方：连接左、右边界 */
  var BLUE = 2;
  /** 用于 0-1 BFS / 评估里的“无穷大” */
  var INF = 1 << 20;

  /** 六个邻接方向（点顶式六边形，轴向坐标）。数组元素为 [行偏移, 列偏移]。 */
  var DIRS = [
    [-1, 0], // 上
    [-1, 1], // 右上
    [0, -1], // 左
    [0, 1],  // 右
    [1, -1], // 左下
    [1, 0]   // 下
  ];

  /* ============================ 基础工具 ============================ */

  /**
   * 创建一个 N×N 的空棋盘。
   * 用 Int8Array 存储，下标为 r*N+c，值为 EMPTY/RED/BLUE。
   */
  function createBoard(N) {
    return new Int8Array(N * N);
  }

  /** 二维坐标 (r,c) 转一维下标 */
  function idx(r, c, N) {
    return r * N + c;
  }

  /** 判断 (r,c) 是否在棋盘内 */
  function inBounds(r, c, N) {
    return r >= 0 && r < N && c >= 0 && c < N;
  }

  /** 返回对手颜色（1<->2 互转） */
  function opponent(color) {
    return 3 - color;
  }

  /**
   * 返回 (r,c) 的六个合法邻居坐标 [r,c] 列表（已过滤越界）。
   */
  function neighbors(r, c, N) {
    var out = [];
    for (var i = 0; i < DIRS.length; i++) {
      var nr = r + DIRS[i][0];
      var nc = c + DIRS[i][1];
      if (inBounds(nr, nc, N)) {
        out.push([nr, nc]);
      }
    }
    return out;
  }

  /* ============================ 胜负判定 ============================ */

  /**
   * 判断“在 (r0,c0) 刚落下 color 一子”后，color 是否立刻连通获胜。
   * 原理：从该子出发做广度优先搜索（BFS），只走同色格子，
   *       同时记录是否触及四条边界；若 color 对应的两条对边都被触及则获胜。
   *
   * 相比每次都全盘扫描，本函数只从新落子处出发，搜索开销更小，
   * 适合在 AI 搜索树中反复调用。
   *
   * @param {Int8Array} board 棋盘
   * @param {number}    N     棋盘边长
   * @param {number}    color 落子颜色（RED/BLUE）
   * @param {number}    r0    落子行
   * @param {number}    c0    落子列
   * @returns {boolean} 是否获胜
   */
  function isWinAfterMove(board, N, color, r0, c0) {
    var seen = new Uint8Array(N * N);
    var stack = [idx(r0, c0, N)];
    seen[stack[0]] = 1;

    var top = false;    // 是否触及第 0 行（上边界）
    var bottom = false; // 是否触及第 N-1 行（下边界）
    var left = false;   // 是否触及第 0 列（左边界）
    var right = false;  // 是否触及第 N-1 列（右边界）

    while (stack.length > 0) {
      var cur = stack.pop();
      var r = Math.floor(cur / N);
      var c = cur % N;

      if (r === 0) top = true;
      if (r === N - 1) bottom = true;
      if (c === 0) left = true;
      if (c === N - 1) right = true;

      var ns = neighbors(r, c, N);
      for (var i = 0; i < ns.length; i++) {
        var ni = idx(ns[i][0], ns[i][1], N);
        if (seen[ni] === 0 && board[ni] === color) {
          seen[ni] = 1;
          stack.push(ni);
        }
      }
    }

    // 红方需同时触及上、下；蓝方需同时触及左、右。
    return color === RED ? (top && bottom) : (left && right);
  }

  /**
   * 全盘判断 color 是否已经连通获胜。
   * 从 color 对应的一侧边界所有同色格子出发做 BFS，看能否到达对侧边界。
   * 用于程序启动校验、复盘或调试。
   */
  function isWin(board, N, color) {
    var seen = new Uint8Array(N * N);
    var stack = [];

    if (color === RED) {
      // 红方：从最上一行（上边界）出发
      for (var c = 0; c < N; c++) {
        if (board[idx(0, c, N)] === RED) {
          seen[idx(0, c, N)] = 1;
          stack.push(idx(0, c, N));
        }
      }
    } else {
      // 蓝方：从最左一列（左边界）出发
      for (var r = 0; r < N; r++) {
        if (board[idx(r, 0, N)] === BLUE) {
          seen[idx(r, 0, N)] = 1;
          stack.push(idx(r, 0, N));
        }
      }
    }

    while (stack.length > 0) {
      var cur = stack.pop();
      var rr = Math.floor(cur / N);
      var cc = cur % N;

      // 到达对侧边界即获胜
      if (color === RED && rr === N - 1) return true;
      if (color === BLUE && cc === N - 1) return true;

      var ns = neighbors(rr, cc, N);
      for (var i = 0; i < ns.length; i++) {
        var ni = idx(ns[i][0], ns[i][1], N);
        if (seen[ni] === 0 && board[ni] === color) {
          seen[ni] = 1;
          stack.push(ni);
        }
      }
    }

    return false;
  }

  /* ============================ 棋局评估 ============================ */

  /**
   * 计算 color 从“起始边”连通到“目标边”最少还需要落多少子。
   *
   * 这是海克斯棋最经典的评估思路之一：把局面看成一张图，
   *   · 己方棋子：可以“免费”经过（代价 0）；
   *   · 空格：     需要花 1 个子才能经过（代价 1）；
   *   · 对方棋子： 视为障碍，不可通过。
   * 那么“起始边到目标边的最短代价”就约等于己方还要几步才能连成。
   *
   * 由于边权只有 0 和 1，这里使用 0-1 BFS（双端队列 BFS），
   * 时间复杂度 O(N^2)，比普通 Dijkstra 的 O(N^2 log N) 更快，
   * 便于在搜索树中被大量调用。
   *
   * @returns {number} 最少还需落子数；若被完全阻断则返回 INF。
   */
  function computeDistanceInfo(board, N, color) {
    var V = N * N;
    var dist = new Int32Array(V);
    for (var i = 0; i < V; i++) dist[i] = INF;

    // 用两个指针模拟双端队列：[head, tail) 区间为队列内容。
    // head 向左移动即“队首插入”，tail 向右移动即“队尾插入”。
    var dq = new Int32Array(2 * V + 16);
    var head = V;
    var tail = V;

    // 判断某个格子是否属于该颜色的“起始边/目标边”
    function isSource(r, c) {
      return color === RED ? r === 0 : c === 0;
    }
    function isTarget(r, c) {
      return color === RED ? r === N - 1 : c === N - 1;
    }

    // 初始化：把起始边上所有非“对方”格子加入队列。
    // 己方格子代价 0（队首），空格代价 1（队尾），对方格子不入队。
    for (var r = 0; r < N; r++) {
      for (var c = 0; c < N; c++) {
        if (!isSource(r, c)) continue;
        var si = idx(r, c, N);
        if (board[si] === opponent(color)) continue;
        var d0 = board[si] === EMPTY ? 1 : 0;
        dist[si] = d0;
        if (d0 === 0) dq[--head] = si;
        else dq[tail++] = si;
      }
    }

    // 0-1 BFS 主循环
    while (head < tail) {
      var cur = dq[head++];
      var cr = Math.floor(cur / N);
      var cc = cur % N;

      var ns = neighbors(cr, cc, N);
      for (var k = 0; k < ns.length; k++) {
        var ni = idx(ns[k][0], ns[k][1], N);
        var cell = board[ni];
        if (cell === opponent(color)) continue; // 对方棋子是障碍
        var w = cell === EMPTY ? 1 : 0;         // 空格需落一子，己方免费
        var nd = dist[cur] + w;
        if (nd < dist[ni]) {
          dist[ni] = nd;
          if (w === 0) dq[--head] = ni; // 0 代价：插入队首
          else dq[tail++] = ni;         // 1 代价：插入队尾
        }
      }
    }

    // 在目标边取最短距离，并统计达到最短距离的目标格数量（宽度）。
    // 宽度 = 该方“一步即可连通”的取胜点数量；宽度 ≥2 即“双杀点”，对手无法同时封堵。
    var best = INF;
    var width = 0;
    for (var r2 = 0; r2 < N; r2++) {
      for (var c2 = 0; c2 < N; c2++) {
        if (!isTarget(r2, c2)) continue;
        var ti = idx(r2, c2, N);
        if (dist[ti] < best) {
          best = dist[ti];
          width = 1;
        } else if (dist[ti] === best) {
          width++;
        }
      }
    }
    return { dist: best, width: width };
  }

  /** 兼容旧接口：只返回最短距离。 */
  function computeDistance(board, N, color) {
    return computeDistanceInfo(board, N, color).dist;
  }

  /**
   * 从 color 的视角评估局面优劣。
   *
   * 思路：令
   *   mine = color 还需几步连通（越小越好）
   *   opp  = 对方还需几步连通（越大越好）
   * 返回 opp - mine，正值表示 color 占优，负值表示对方占优，0 表示均势。
   *
   * 特殊处理：某一方距离为 0 说明该方已经连通（即将获胜/已获胜）。
   *
   * @returns {number} 评估值（整数，量级约在 [-N^2, N^2] 之间）
   */
  function evaluate(board, N, color) {
    var mineInfo = computeDistanceInfo(board, N, color);
    var oppInfo = computeDistanceInfo(board, N, opponent(color));
    var mine = mineInfo.dist;
    var opp = oppInfo.dist;

    if (mine === 0) return 100000;  // 己方已连通（必胜）
    if (opp === 0) return -100000;  // 对方已连通（必败）

    // 双杀检测：某方一步即可连通且存在 ≥2 个取胜点，对手无法同时封堵。
    // 这条弥补了“距离差”评估看不出双杀威胁的盲点，避免地平线效应。
    if (opp === 1 && oppInfo.width >= 2) return -90000;
    if (mine === 1 && mineInfo.width >= 2) return 90000;

    return opp - mine;
  }

  /* ============================ 候选落点生成 ============================ */

  /**
   * 生成“值得考虑”的候选落点，并按优先级排序（供 AI 搜索使用）。
   *
   * 海克斯棋中，远离已有棋子的位置几乎都是废着，因此没必要穷举全部空格。
   * 这里只保留“与任意棋子切比雪夫距离 ≤2”的空格：
   *   - 与棋子相邻（距离 1）的空格加热度 +2；
   *   - 距离 2 的空格加热度 +1；
   * 热度越高越可能影响战局。再以“靠近棋盘中心”作为次要排序键。
   *
   * 空棋盘时返回棋盘中心点（经典开局：占中心价值最大）。
   *
   * @returns {Array<[number, number]>} 候选坐标列表（已按优先级降序）。
   */
  function candidateMoves(board, N) {
    var stones = 0;
    var i;
    for (i = 0; i < N * N; i++) {
      if (board[i] !== EMPTY) stones++;
    }
    var center = Math.floor(N / 2);
    if (stones === 0) {
      return [[center, center]];
    }

    // heat[i]：空格 i 的热度
    var heat = new Int32Array(N * N);

    // 对每个已有棋子，给其周边 ≤2 步内的空格加热
    for (var r = 0; r < N; r++) {
      for (var c = 0; c < N; c++) {
        if (board[idx(r, c, N)] === EMPTY) continue;
        for (var dr = -2; dr <= 2; dr++) {
          for (var dc = -2; dc <= 2; dc++) {
            var nr = r + dr;
            var nc = c + dc;
            if (!inBounds(nr, nc, N)) continue;
            var ni = idx(nr, nc, N);
            if (board[ni] !== EMPTY) continue;
            var d = Math.max(Math.abs(dr), Math.abs(dc)); // 切比雪夫距离
            heat[ni] += 3 - d; // 距离 1 加 2，距离 2 加 1
          }
        }
      }
    }

    var moves = [];
    for (var rr = 0; rr < N; rr++) {
      for (var cc = 0; cc < N; cc++) {
        var mi = idx(rr, cc, N);
        if (board[mi] === EMPTY && heat[mi] > 0) {
          // 中心偏好：越靠近中心值越大（用于热度相同时的稳定排序）
          var centerBias = -Math.abs(2 * rr - (N - 1)) - Math.abs(2 * cc - (N - 1));
          moves.push({ r: rr, c: cc, heat: heat[mi], bias: centerBias });
        }
      }
    }

    moves.sort(function (a, b) {
      if (b.heat !== a.heat) return b.heat - a.heat;
      return b.bias - a.bias;
    });

    var result = [];
    for (var m = 0; m < moves.length; m++) {
      result.push([moves[m].r, moves[m].c]);
    }
    return result;
  }

  /* ============================ 导出 ============================ */

  var HexGame = {
    EMPTY: EMPTY,
    RED: RED,
    BLUE: BLUE,
    INF: INF,
    DIRS: DIRS,
    createBoard: createBoard,
    idx: idx,
    inBounds: inBounds,
    opponent: opponent,
    neighbors: neighbors,
    isWinAfterMove: isWinAfterMove,
    isWin: isWin,
    computeDistance: computeDistance,
    computeDistanceInfo: computeDistanceInfo,
    evaluate: evaluate,
    candidateMoves: candidateMoves
  };

  global.HexGame = HexGame;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = HexGame;
  }
})(typeof window !== 'undefined' ? window : globalThis);
