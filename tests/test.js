/**
 * test.js —— 海克斯棋核心逻辑与 AI 决策的 Node.js 单元测试
 * 运行：node tests/test.js
 */
'use strict';

const G = require('../js/game.js');
const AI = require('../js/ai.js');

let passed = 0;
let failed = 0;

function assert(cond, name) {
  if (cond) {
    passed++;
    console.log('  ✓ ' + name);
  } else {
    failed++;
    console.log('  ✗ ' + name);
  }
}

function makeBoard(N, stones) {
  const b = G.createBoard(N);
  for (const [r, c, color] of stones) {
    b[G.idx(r, c, N)] = color;
  }
  return b;
}

console.log('\n[1] 邻居数量');
{
  const N = 5;
  assert(G.neighbors(2, 2, N).length === 6, '中心格 6 个邻居');
  assert(G.neighbors(0, 0, N).length === 2, '角格 (0,0) 2 个邻居');
  assert(G.neighbors(0, 4, N).length === 3, '钝角格 (0,4) 3 个邻居');
  assert(G.neighbors(4, 0, N).length === 3, '钝角格 (4,0) 3 个邻居');
  assert(G.neighbors(4, 4, N).length === 2, '角格 (4,4) 2 个邻居');
}

console.log('\n[2] 胜负判定 isWinAfterMove');
{
  const N = 5;
  // 红方在 c=2 列连通上下
  let b = makeBoard(N, [[0, 2, G.RED], [1, 2, G.RED], [2, 2, G.RED], [3, 2, G.RED]]);
  b[G.idx(4, 2, N)] = G.RED;
  assert(G.isWinAfterMove(b, N, G.RED, 4, 2) === true, '红方竖列连通上下获胜');

  // 蓝方在 r=2 行连通左右
  let b2 = makeBoard(N, [[2, 0, G.BLUE], [2, 1, G.BLUE], [2, 2, G.BLUE], [2, 3, G.BLUE]]);
  b2[G.idx(2, 4, N)] = G.BLUE;
  assert(G.isWinAfterMove(b2, N, G.BLUE, 2, 4) === true, '蓝方横行连通左右获胜');

  // 未连通时不误判
  let b3 = makeBoard(N, [[0, 2, G.RED], [1, 2, G.RED], [2, 2, G.RED]]);
  b3[G.idx(3, 3, N)] = G.RED;
  assert(G.isWinAfterMove(b3, N, G.RED, 3, 3) === false, '未连通时判负正确');
}

console.log('\n[3] 全盘胜负判定 isWin');
{
  const N = 5;
  let b = makeBoard(N, [[0, 2, G.RED], [1, 2, G.RED], [2, 2, G.RED], [3, 2, G.RED], [4, 2, G.RED]]);
  assert(G.isWin(b, N, G.RED) === true, '全盘扫描识别红方获胜');
  assert(G.isWin(b, N, G.BLUE) === false, '全盘扫描识别蓝方未获胜');
}

console.log('\n[4] 连通距离 computeDistance 与评估 evaluate');
{
  const N = 5;
  const empty = G.createBoard(N);
  assert(G.computeDistance(empty, N, G.RED) === N, '空棋盘红方需 N 步连通');
  assert(G.computeDistance(empty, N, G.BLUE) === N, '空棋盘蓝方需 N 步连通');
  assert(G.evaluate(empty, N, G.RED) === 0, '空棋盘均势，评估为 0');

  // 红方已在 c=2 放 3 子：距离应从 5 减小
  const b = makeBoard(N, [[0, 2, G.RED], [1, 2, G.RED], [2, 2, G.RED]]);
  const d = G.computeDistance(b, N, G.RED);
  assert(d === 2, '红方竖列剩 2 步连通（实际=' + d + '）');
}

console.log('\n[5] 候选落点 candidateMoves');
{
  const N = 5;
  const empty = G.createBoard(N);
  const m = G.candidateMoves(empty, N);
  assert(m.length === 1 && m[0][0] === 2 && m[0][1] === 2, '空棋盘只推荐中心点');
}

console.log('\n[6] AI 首步');
{
  const N = 5;
  const empty = G.createBoard(N);
  const res = AI.findBestMove(empty, N, G.RED, { timeLimitMs: 800, maxDepth: 2 });
  assert(res && res.r === 2 && res.c === 2, 'AI 首步走中心（实际=' + (res && (res.r + ',' + res.c)) + '）');
}

console.log('\n[7] AI 一步获胜');
{
  const N = 5;
  const b = makeBoard(N, [[0, 2, G.RED], [1, 2, G.RED], [2, 2, G.RED], [3, 2, G.RED]]);
  const res = AI.findBestMove(b, N, G.RED, { timeLimitMs: 800, maxDepth: 2 });
  assert(res && res.r === 4 && res.c === 2, 'AI 直接走获胜点 (4,2)（实际=' + (res && (res.r + ',' + res.c)) + '）');
}

console.log('\n[8] AI 封堵对手');
{
  const N = 5;
  const b = makeBoard(N, [[2, 0, G.BLUE], [2, 1, G.BLUE], [2, 2, G.BLUE], [2, 3, G.BLUE]]);
  const res = AI.findBestMove(b, N, G.RED, { timeLimitMs: 800, maxDepth: 2 });
  assert(res && res.r === 2 && res.c === 4, 'AI 封堵蓝方获胜点 (2,4)（实际=' + (res && (res.r + ',' + res.c)) + '）');
}

console.log('\n==============================');
console.log('通过 ' + passed + ' 项，失败 ' + failed + ' 项');
process.exit(failed === 0 ? 0 : 1);
