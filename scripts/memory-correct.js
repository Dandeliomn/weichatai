#!/usr/bin/env node
/**
 * 记忆自进化工具
 * 用户纠正 → 查PG聊天记录验证 → 自动更正ST Lorebook
 *
 * 用法:
 *   node scripts/memory-correct.js -c 王静 -m "哈密瓜那段不对"
 *   node scripts/memory-correct.js -c 王静 -m "..." --dry-run
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// ============================================================
// Config
// ============================================================

const PG_CMD = `docker exec weclaw-postgres psql -U weclaw -d weclaw_companion -t -A -F '|||'`;
const ST_CONTAINER = 'weclaw-st-24926e2e3aa4-im-bot';
const ST_DATA_HOST = '/app/st-data/24926e2e3aa4-im-bot/data/default-user';
const EXES_DIR = path.resolve(__dirname, '..', 'exes');

function query(sql) {
  try {
    const result = execSync(`${PG_CMD} -c "${sql.replace(/"/g, '\\"').replace(/\n/g, ' ')}" 2>/dev/null`,
      { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024, timeout: 10000 });
    return result.trim().split('\n').filter(Boolean).map(row => row.split('|||'));
  } catch { return []; }
}

// ============================================================
// CLI
// ============================================================

function parseArgs() {
  const args = { character: '', claim: '', dryRun: false };
  for (let i = 2; i < process.argv.length; i++) {
    switch (process.argv[i]) {
      case '-c': case '--character': args.character = process.argv[++i]; break;
      case '-m': case '--claim': args.claim = process.argv[++i]; break;
      case '--dry-run': args.dryRun = true; break;
    }
  }
  if (!args.character || !args.claim) {
    console.error('Usage: node memory-correct.js -c <角色名> -m "<纠正声明>" [--dry-run]');
    process.exit(1);
  }
  return args;
}

// ============================================================
// Step 1: Extract keywords from claim
// ============================================================

function extractKeywords(claim) {
  // Remove correction trigger words to isolate the subject
  let cleaned = claim
    .replace(/不对|不是|错了|记错|其实|应该是|没有|你说/g, '')
    .replace(/这段|那个|这个|那里|这里|那段|了|的/g, '')
    .trim();

  if (!cleaned || cleaned.length < 2) cleaned = claim;

  // Extract the core subject: split by common separators
  const parts = cleaned.split(/[，,。\.\s、]+/).filter(p => p.length >= 2);

  // Generate keywords from parts
  const keywords = [];
  for (const part of parts) {
    keywords.push(part); // full part
    for (let i = 0; i < part.length - 1; i++) {
      keywords.push(part.substring(i, Math.min(i + 3, part.length))); // 2-3 char ngrams
    }
  }

  return [...new Set(keywords.filter(k => k.length >= 2))].slice(0, 15);
}

// ============================================================
// Step 2: Search PG for evidence
// ============================================================

function searchEvidence(keywords, claim) {
  const results = [];
  const seen = new Set();

  // Primary: ILIKE search for each keyword
  for (const kw of keywords.slice(0, 8)) {
    if (kw.length < 2) continue;
    const escaped = kw.replace(/'/g, "''");
    const rows = query(`
      SELECT sender, content, to_char(timestamp, 'YYYY-MM-DD HH24:MI') as ts
      FROM imported_messages
      WHERE content ILIKE '%${escaped}%'
      LIMIT 10
    `);
    for (const [sender, content, ts] of rows) {
      const key = `${sender}::${content?.substring(0, 40)}`;
      if (content && !seen.has(key)) {
        seen.add(key);
        results.push({ sender, content, ts, matched_keyword: kw });
      }
    }
  }

  // Fallback: broader search with claim subject words (2-char splits)
  if (results.length === 0) {
    const chars = claim.replace(/不对|不是|错了|记错|其实|应该是|没有|你说|这段|那个|这个|那里|这里|了/g, '').trim();
    for (let i = 0; i < chars.length - 1; i++) {
      const bigram = chars.substring(i, i + 2);
      const rows = query(`
        SELECT sender, content, to_char(timestamp, 'YYYY-MM-DD HH24:MI') as ts
        FROM imported_messages WHERE content ILIKE '%${bigram}%' LIMIT 5
      `);
      for (const [sender, content, ts] of rows) {
        const key = `${sender}::${content?.substring(0, 40)}`;
        if (content && !seen.has(key)) {
          seen.add(key);
          results.push({ sender, content, ts, matched_keyword: bigram });
        }
      }
    }
  }

  return results.slice(0, 40);
}

// ============================================================
// Step 3: Analyze evidence
// ============================================================

function analyzeEvidence(claim, evidence) {
  if (evidence.length === 0) {
    return { supported: false, confidence: 'low', corrected_text: '聊天记录中未找到相关信息', quotes: [] };
  }

  // Simple heuristic: count how many messages contain keywords from the claim
  const claimWords = claim.replace(/不对|不是|错了|记错/g, '').trim().split('');
  let matchCount = 0;

  for (const { content } of evidence) {
    for (const ch of claimWords) {
      if (content.includes(ch)) { matchCount++; break; }
    }
  }

  const matchRatio = matchCount / evidence.length;

  return {
    supported: matchRatio > 0.3,
    confidence: matchRatio > 0.6 ? 'high' : matchRatio > 0.3 ? 'medium' : 'low',
    evidence_count: evidence.length,
    match_ratio: matchRatio,
    quotes: evidence.slice(0, 5).map(e => `[${e.ts}] ${e.sender}: ${e.content}`),
    sample: evidence.slice(0, 10)
  };
}

// ============================================================
// Step 4: Update ST Lorebook
// ============================================================

function readLorebook(character) {
  const hostPath = path.join(ST_DATA_HOST, 'worlds', `${character}.json`);
  try {
    return JSON.parse(fs.readFileSync(hostPath, 'utf-8'));
  } catch {
    return { entries: {} };
  }
}

function findMatchingEntries(lorebook, keywords) {
  const matches = [];
  for (const [uid, entry] of Object.entries(lorebook.entries || {})) {
    // Match against COMMENT (title) first, then content
    // Comment is more specific — avoids false matches like "家乡" when correcting "哈密瓜"
    const commentText = (entry.comment || '').toLowerCase();
    const keyText = (entry.key || []).join(' ').toLowerCase();

    let score = 0;
    for (const kw of keywords) {
      if (kw.length < 2) continue;
      // Comment match = high weight
      if (commentText.includes(kw)) score += 5;
      // Key match = medium weight
      if (keyText.includes(kw)) score += 3;
    }

    // Minimum score threshold to avoid false matches
    if (score >= 3) {
      matches.push({ uid, entry, score });
    }
  }
  return matches.sort((a, b) => b.score - a.score);
}

function updateLorebook(character, matches, analysis, claim) {
  const hostPath = path.join(ST_DATA_HOST, 'worlds', `${character}.json`);
  const lorebook = readLorebook(character);

  // When user says something is WRONG, evidence existing = confirmation user is right
  // → delete the incorrect entries regardless of match_ratio
  const isCorrection = /不对|不是|错了|记错|没有/g.test(claim);

  for (const { uid, entry } of matches) {
    if (isCorrection && analysis.evidence_count > 0) {
      // User says wrong + evidence found = user is right → delete
      delete lorebook.entries[uid];
      console.log(`  🗑️  Deleted entry #${uid}: "${entry.comment}" (用户纠正+证据支持)`);
    } else if (analysis.confidence === 'medium') {
      entry.content = `[⚠️ 待验证] ${entry.content}`;
      entry.comment = `${entry.comment} [待验证 ${new Date().toISOString().slice(0,10)}]`;
      console.log(`  ⚠️  Flagged entry #${uid}: "${entry.comment}"`);
    }
  }

  fs.writeFileSync(hostPath, JSON.stringify(lorebook, null, 2), 'utf-8');

  // Deploy to ST container
  try {
    execSync(`docker cp "${hostPath}" ${ST_CONTAINER}:/home/node/app/data/default-user/worlds/${character}.json 2>/dev/null`);
    console.log('  📤 Deployed to ST container');
  } catch { /* container might be down */ }

  return lorebook;
}

// ============================================================
// Step 5: Log correction
// ============================================================

function logCorrection(character, claim, analysis, matches) {
  const evidence_json = JSON.stringify(analysis.sample || []).replace(/'/g, "''");
  const previous = matches.length > 0 ? JSON.stringify(matches[0].entry).replace(/'/g, "''") : '{}';

  query(`
    INSERT INTO correction_logs (character_name, claim, verified_text, confidence, evidence, previous_entry, source, status)
    VALUES ('${character}', '${claim.replace(/'/g, "''")}', '${(analysis.corrected_text || '').replace(/'/g, "''")}',
            '${analysis.confidence}', '${evidence_json}', '${previous}', 'cli', 'applied')
  `);

  // Increment counter
  query(`UPDATE system_config SET value = (COALESCE(value::int,0)+1)::text WHERE key = 'correction_count_${character}'`);
}

// ============================================================
// Step 6: Update exes memory.md
// ============================================================

function updateExMemory(character, claim, analysis, matches) {
  const slugMap = { '王静': '静静', '静静': '静静' };
  const slug = slugMap[character] || character;
  const memoryPath = path.join(EXES_DIR, slug, 'memory.md');

  if (!fs.existsSync(memoryPath)) return;

  let content = fs.readFileSync(memoryPath, 'utf-8');
  const date = new Date().toISOString().slice(0, 10);

  // Replace placeholder or append
  const correctionEntry = `\n### Correction — ${date}\n- 用户声明: "${claim}"\n- 置信度: ${analysis.confidence}\n- 匹配条目: ${matches.map(m => `#${m.uid} ${m.entry.comment}`).join(', ') || '无'}\n- 证据数: ${analysis.evidence_count || 0}\n`;

  if (content.includes('_（待进化模式追加）_')) {
    content = content.replace('_（待进化模式追加）_', correctionEntry);
  } else if (content.includes('## Correction 记录')) {
    content = content.replace('## Correction 记录', `## Correction 记录${correctionEntry}`);
  }

  fs.writeFileSync(memoryPath, content, 'utf-8');
  console.log(`  📝 Updated exes/${slug}/memory.md`);
}

// ============================================================
// Main
// ============================================================

async function main() {
  const args = parseArgs();

  console.log(`\n🔍 记忆自进化 — 验证纠正`);
  console.log(`   角色: ${args.character}`);
  console.log(`   声明: "${args.claim}"`);
  if (args.dryRun) console.log(`   模式: DRY RUN (不写入)\n`);

  // 1. Extract keywords
  const keywords = extractKeywords(args.claim);
  console.log(`\n📝 关键词: ${keywords.join(', ')}`);

  // 2. Search evidence
  const evidence = searchEvidence(keywords, args.claim);
  console.log(`📊 找到 ${evidence.length} 条相关消息`);

  // 3. Analyze
  const analysis = analyzeEvidence(args.claim, evidence);
  console.log(`\n📋 分析结果:`);
  console.log(`   置信度: ${analysis.confidence}`);
  console.log(`   证据数: ${analysis.evidence_count}`);
  console.log(`   匹配率: ${(analysis.match_ratio * 100).toFixed(0)}%`);

  if (analysis.quotes.length > 0) {
    console.log(`\n📄 相关聊天记录:`);
    for (const q of analysis.quotes.slice(0, 8)) {
      console.log(`   ${q}`);
    }
  }

  // 4. Find matching lorebook entries
  const lorebook = readLorebook(args.character);
  const matches = findMatchingEntries(lorebook, keywords);
  console.log(`\n📖 匹配的Lorebook条目: ${matches.length}`);
  for (const m of matches.slice(0, 5)) {
    console.log(`   #${m.uid} [${m.entry.group}] ${m.entry.comment} (score:${m.score})`);
  }

  // 5. Update if not dry-run
  if (!args.dryRun && matches.length > 0) {
    console.log(`\n✏️  执行更正...`);
    updateLorebook(args.character, matches, analysis, args.claim);
    logCorrection(args.character, args.claim, analysis, matches);
    updateExMemory(args.character, args.claim, analysis, matches);
    console.log(`\n✅ 更正完成`);
  } else if (args.dryRun) {
    console.log(`\n🔒 DRY RUN — 未写入任何更改`);
  } else {
    console.log(`\n⚠️  未找到匹配的Lorebook条目`);
  }

  return { keywords, evidence, analysis, matches };
}

main().catch(err => {
  console.error('❌', err.message);
  process.exit(1);
});
