#!/usr/bin/env node
/**
 * she-love-me PG适配器
 * 从PostgreSQL imported_messages提取数据 → 生成分析prompt → 调用AI分析
 *
 * 用法:
 *   node scripts/love-analysis.js -c 静静 [-o report.md]
 *   curl -X POST /api/memory/analyze-relationship -d '{"character":"静静"}'
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const PG_CMD = `docker exec weclaw-postgres psql -U weclaw -d weclaw_companion -t -A -F '|||'`;

function query(sql) {
  try {
    const result = execSync(`${PG_CMD} -c "${sql.replace(/"/g, '\\"').replace(/\n/g, ' ')}" 2>/dev/null`,
      { encoding: 'utf-8', maxBuffer: 50 * 1024 * 1024, timeout: 15000 });
    return result.trim().split('\n').filter(Boolean).map(row => row.split('|||'));
  } catch { return []; }
}

// ============================================================
// Extract structured stats for she-love-me framework
// ============================================================

function extractStats(sender, otherSender) {
  const [[total,]] = query(`SELECT COUNT(*) FROM imported_messages`);
  const [[herTotal,]] = query(`SELECT COUNT(*) FROM imported_messages WHERE sender='${sender}'`);
  const [[himTotal,]] = query(`SELECT COUNT(*) FROM imported_messages WHERE sender='${otherSender}'`);
  const [[herAvg,]] = query(`SELECT ROUND(AVG(LENGTH(content))::numeric,1) FROM imported_messages WHERE sender='${sender}'`);
  const [[himAvg,]] = query(`SELECT ROUND(AVG(LENGTH(content))::numeric,1) FROM imported_messages WHERE sender='${otherSender}'`);
  const [[dateRange,]] = query(`SELECT MIN(timestamp)::text || ' ~ ' || MAX(timestamp)::text FROM imported_messages`);
  const [[days,]] = query(`SELECT COUNT(DISTINCT timestamp::date)::text FROM imported_messages`);
  const [[herShort, herShortPct]] = query(`
    SELECT COUNT(*), ROUND(100.0*COUNT(*)/NULLIF((SELECT COUNT(*) FROM imported_messages WHERE sender='${sender}'),0),1)
    FROM imported_messages WHERE sender='${sender}' AND LENGTH(TRIM(content))<=2
  `);
  const [[himShort, himShortPct]] = query(`
    SELECT COUNT(*), ROUND(100.0*COUNT(*)/NULLIF((SELECT COUNT(*) FROM imported_messages WHERE sender='${otherSender}'),0),1)
    FROM imported_messages WHERE sender='${otherSender}' AND LENGTH(TRIM(content))<=2
  `);

  // Emotional word counts
  const emotions = {};
  const terms = [
    ['哈哈', 'laugh'], ['晚安', 'goodnight'], ['想你', 'miss_you'],
    ['爱你', 'love_you'], ['喜欢你', 'like_you'], ['撤回', 'retract'],
    ['宝宝', 'baby'], ['开心', 'happy'], ['生气', 'angry'], ['烦', 'annoyed']
  ];
  for (const [term, key] of terms) {
    const [[herCount,]] = query(`SELECT COUNT(*) FROM imported_messages WHERE sender='${sender}' AND content LIKE '%${term}%'`);
    const [[himCount,]] = query(`SELECT COUNT(*) FROM imported_messages WHERE sender='${otherSender}' AND content LIKE '%${term}%'`);
    emotions[key] = { her: parseInt(herCount)||0, him: parseInt(himCount)||0 };
  }

  // Monthly trend
  const monthly = query(`
    SELECT to_char(timestamp,'YYYY-MM'),
      COUNT(*) FILTER(WHERE sender='${sender}'),
      COUNT(*) FILTER(WHERE sender='${otherSender}'),
      ROUND(AVG(LENGTH(content)) FILTER(WHERE sender='${sender}')::numeric,1),
      ROUND(AVG(LENGTH(content)) FILTER(WHERE sender='${otherSender}')::numeric,1)
    FROM imported_messages GROUP BY 1 ORDER BY 1
  `);

  // Who initiates (first message each day)
  const [[herInit,]] = query(`
    SELECT COUNT(*) FROM (
      SELECT DISTINCT ON (timestamp::date) sender, timestamp::date
      FROM imported_messages ORDER BY timestamp::date, timestamp
    ) t WHERE sender='${sender}'
  `);
  const [[himInit,]] = query(`
    SELECT COUNT(*) FROM (
      SELECT DISTINCT ON (timestamp::date) sender, timestamp::date
      FROM imported_messages ORDER BY timestamp::date, timestamp
    ) t WHERE sender='${otherSender}'
  `);

  // Time-of-day pattern
  const hourly = query(`
    SELECT EXTRACT(HOUR FROM timestamp)::int, COUNT(*)
    FROM imported_messages WHERE sender='${sender}'
    GROUP BY 1 ORDER BY 1
  `);

  // Key conversations (>30 char messages from her)
  const keyMsgs = query(`
    SELECT content, to_char(timestamp,'YYYY-MM-DD HH24:MI') as ts
    FROM imported_messages WHERE sender='${sender}' AND LENGTH(content) > 25
    ORDER BY timestamp LIMIT 30
  `);

  // Breakup day messages
  const breakupMsgs = query(`
    SELECT sender, content, to_char(timestamp,'HH24:MI') as ts
    FROM imported_messages WHERE timestamp::date = '2026-02-02'
    ORDER BY timestamp LIMIT 30
  `);

  // Final messages
  const finalMsgs = query(`
    SELECT sender, content, to_char(timestamp,'YYYY-MM-DD HH24:MI') as ts
    FROM imported_messages WHERE timestamp >= '2026-03-01'
    ORDER BY timestamp
  `);

  return {
    overview: { total: parseInt(total), herTotal: parseInt(herTotal), himTotal: parseInt(himTotal),
                herAvg, himAvg, dateRange, days: parseInt(days),
                herShortPct: parseFloat(herShortPct), himShortPct: parseFloat(himShortPct) },
    emotions,
    monthly,
    initiative: { her: parseInt(herInit)||0, him: parseInt(himInit)||0 },
    hourly,
    keyMsgs,
    breakupMsgs,
    finalMsgs
  };
}

// ============================================================
// Build analysis prompt for AI
// ============================================================

function buildPrompt(stats, sender, otherSender) {
  const { overview, emotions, monthly, initiative, keyMsgs, breakupMsgs, finalMsgs } = stats;

  const monthlyTable = monthly.map(([m, h1, h2, hl, h2l]) =>
    `| ${m} | 她${h1}/你${h2} | 她均${hl}字/你均${h2l}字 |`
  ).join('\n');

  const breakupDialog = breakupMsgs.map(([s, c, t]) => `[${t}] ${s}: ${c}`).join('\n');
  const finalDialog = finalMsgs.map(([s, c, t]) => `[${t}] ${s}: ${c}`).join('\n');
  const keyMsgsText = keyMsgs.map(([c, t]) => `[${t}] ${sender}: ${c}`).join('\n');

  const herPeak = parseInt(monthly[1]?.[1] || 0);
  const herLast = parseInt(monthly[monthly.length-1]?.[1] || 0);
  const trend = herLast < herPeak * 0.1 ? '断崖式结束' : herLast < herPeak * 0.5 ? '明显降温' : '平稳';

  // Gottman ratio
  const herPos = (emotions.happy?.her||0) + (emotions.laugh?.her||0) + (emotions.like_you?.her||0);
  const herNeg = (emotions.angry?.her||0) + (emotions.annoyed?.her||0);
  const gottmanRatio = herNeg > 0 ? Math.round(herPos / herNeg) : herPos;

  return `你是一名关系心理学家。请使用以下框架分析这段关系：

## 分析框架：模块 F → A → B → C → D → E → G

### 模块 F：人格深度画像
- F1: 核心特质与核心恐惧（被抛弃/被吞噬/被贬低）
- F2: 防御机制识别（防御性撤退/理性化/投射性怀疑/情感否认）
- F3: 底层需求→表面行为解码
- F4: 信任架构

### 模块 A：关系诊断
- A1: 关系类型判断（7种）
- A2: Sternberg爱情三角（激情/亲密/承诺）
- A3: 关系趋势
- A4: 关系阶段定位
- A5: 不对称分析

### 模块 B：人格深度
- B1: 依恋类型（安全/焦虑/回避/恐惧）
- B2: 沟通风格
- B3: 爱的语言

### 模块 C：危险信号（7类）
### 模块 D：军师建议（3停止+3开始+止损红线）

---

## 数据

**概览**: ${overview.total}条消息，${overview.days}天。她${overview.herTotal}条(均${overview.herAvg}字)/你${overview.himTotal}条(均${overview.himAvg}字)。${overview.dateRange}

**谁更主动**: 她发起${initiative.her}天/你${initiative.him}天。她短消息占比${overview.herShortPct}%/你${overview.himShortPct}%。

**月度趋势**:
${monthlyTable}

**趋势判断**: ${trend}

**情感词统计**:
- 哈哈: 她${emotions.laugh?.her||0}/你${emotions.laugh?.him||0}
- 想你: 她${emotions.miss_you?.her||0}/你${emotions.miss_you?.him||0}
- 爱你: 她${emotions.love_you?.her||0}/你${emotions.love_you?.him||0}
- 宝宝: 她${emotions.baby?.her||0}/你${emotions.baby?.him||0}
- 撤回: 她${emotions.retract?.her||0}/你${emotions.retract?.him||0}
- Gottman正向/负向比: 约${gottmanRatio}:1

**关键对话（她的长消息）**:
${keyMsgsText.substring(0, 2000)}

**分手日对话（2026-02-02）**:
${breakupDialog.substring(0, 2000)}

**最后的消息**:
${finalDialog}

---

请输出中文Markdown格式的分析报告。`;
}

// ============================================================
// Main
// ============================================================

function main() {
  const args = {};
  for (let i = 2; i < process.argv.length; i++) {
    if (process.argv[i] === '-c' || process.argv[i] === '--character') args.character = process.argv[++i];
    if (process.argv[i] === '-o' || process.argv[i] === '--output') args.output = process.argv[++i];
  }

  const character = args.character || '静静';
  const sender = character;
  const otherSender = 'Dandelionᝰ';

  console.log(`🔍 she-love-me 分析: ${sender} ↔ ${otherSender}\n`);

  const stats = extractStats(sender, otherSender);
  const prompt = buildPrompt(stats, sender, otherSender);

  if (args.output) {
    fs.writeFileSync(args.output, prompt, 'utf-8');
    console.log(`✅ Analysis prompt saved to ${args.output}`);
  } else {
    // Output the prompt for piping to AI
    process.stdout.write(prompt);
  }
}

main();
