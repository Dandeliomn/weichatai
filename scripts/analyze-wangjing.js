#!/usr/bin/env node
/**
 * 从 PostgreSQL imported_messages 提取王静的真实人格和记忆
 * 输出: ST 角色卡 + Lorebook + 对话历史
 */
const { execSync } = require('child_process');

const PG_CMD = `docker exec weclaw-postgres psql -U weclaw -d weclaw_companion -t -A -F '|||'`;

function query(sql) {
  const result = execSync(`${PG_CMD} -c "${sql.replace(/"/g, '\\"')}" 2>/dev/null`, { encoding: 'utf-8', maxBuffer: 50 * 1024 * 1024 });
  return result.trim().split('\n').filter(Boolean).map(row => row.split('|||'));
}

console.log('═══════════════════════════════════════');
console.log('  王静 — 数据驱动角色生成');
console.log('═══════════════════════════════════════\n');

// 1. 基础统计
const [stats] = query(`
  SELECT COUNT(*), ROUND(AVG(LENGTH(content))::numeric,1),
    COUNT(*) FILTER (WHERE EXTRACT(HOUR FROM timestamp) BETWEEN 0 AND 5)
  FROM imported_messages WHERE sender = '静静'
`);
console.log(`📊 基础数据:`);
console.log(`   总消息: ${stats[0]} 条`);
console.log(`   平均长度: ${stats[1]} 字`);
console.log(`   深夜消息: ${stats[2]} 条\n`);

// 2. 高频词分析
console.log(`🔤 高频短词:`);
const words = ['我去', '昂', '彳亍', '行', '对', '哈哈哈', '晚安', '嗯嗯', '咋了', '为啥', '啥'];
for (const w of words) {
  const [[r]] = query(`SELECT COUNT(*) FROM imported_messages WHERE sender = '静静' AND content ~ '${w}'`);
  if (parseInt(r) > 20) console.log(`   "${w}": ${r} 次`);
}

// 3. 情感消息采样
console.log(`\n💬 情感消息样本:`);
const emotional = query(`
  SELECT content, timestamp FROM imported_messages
  WHERE sender = '静静' AND LENGTH(content) > 6
    AND (content ~ '想你' OR content ~ '喜欢' OR content ~ '爱' OR content ~ '晚安宝宝'
         OR content ~ '开心' OR content ~ '难过' OR content ~ '在乎' OR content ~ '记得')
  ORDER BY timestamp LIMIT 20
`);
for (const [content, ts] of emotional) {
  console.log(`   [${ts?.substring(0,16) || '?'}] ${content}`);
}

// 4. 关键日期/事件
console.log(`\n📅 关系时间线:`);
const timeline = query(`
  SELECT to_char(timestamp, 'YYYY-MM'),
    COUNT(*),
    ROUND(AVG(LENGTH(content))::numeric, 1)
  FROM imported_messages WHERE sender = '静静'
  GROUP BY 1 ORDER BY 1
`);
for (const [month, cnt, avg] of timeline) {
  const bar = '█'.repeat(Math.round(parseInt(cnt) / 100));
  console.log(`   ${month}: ${cnt} 条 ${bar} (均长${avg}字)`);
}

// 5. 长消息（可能是重要对话）
console.log(`\n📝 重要长消息 (>30字):`);
const long = query(`
  SELECT content, timestamp FROM imported_messages
  WHERE sender = '静静' AND LENGTH(content) > 30
  ORDER BY timestamp LIMIT 15
`);
for (const [content, ts] of long) {
  console.log(`   [${ts?.substring(0,16) || '?'}] ${content?.substring(0,80)}...`);
}

console.log(`\n✅ 分析完成`);
