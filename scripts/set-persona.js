#!/usr/bin/env node
/**
 * set-persona.js — 管理当前活跃人格（供 relay 富协议读取）
 *
 * 用法:
 *   node scripts/set-persona.js personality/tsundere          # 设置傲娇
 *   node scripts/set-persona.js personality/tsundere,speech/keigo  # 多重人格
 *   node scripts/set-persona.js --clear                        # 清除人格
 *   node scripts/set-persona.js --status                       # 查看当前
 *
 * 输出: ~/.hermes/active_persona.json (relay 读取此文件)
 */

const fs = require('fs');
const path = require('path');

const FILE = process.env.ACTIVE_PERSONA_FILE || path.join(require('os').homedir(), '.hermes', 'active_persona.json');
const ATTR_DIR = process.env.HERSONA_ATTR_DIR || path.join(__dirname, '..', 'vendor', 'hersona', 'attributes');

function listAvailable() {
  const cats = fs.readdirSync(ATTR_DIR, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name);
  console.log('可用的角色属性:\n');
  for (const cat of cats) {
    console.log(`  [${cat}]`);
    const files = fs.readdirSync(path.join(ATTR_DIR, cat)).filter(f => f.endsWith('.yaml'));
    for (const f of files) {
      const name = f.replace('.yaml', '');
      // Try to get display name from YAML
      const yaml = fs.readFileSync(path.join(ATTR_DIR, cat, f), 'utf-8');
      const m = yaml.match(/^display_name:\s*(.+)$/m);
      const display = m ? m[1].trim().replace(/['"]/g, '') : name;
      console.log(`    - ${cat}/${name} (${display})`);
    }
  }
}

function parseAttr(str) {
  const parts = str.split('/');
  if (parts.length !== 2) throw new Error(`格式错误: ${str}，正确格式 personality/tsundere`);
  return { category: parts[0], name: parts[1] };
}

function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === '--help') {
    console.log(`用法:
  node scripts/set-persona.js <category/name>[,<category/name>...]
  node scripts/set-persona.js --list
  node scripts/set-persona.js --clear
  node scripts/set-persona.js --status

示例:
  node scripts/set-persona.js personality/tsundere
  node scripts/set-persona.js personality/tsundere,speech/keigo,archetype/heroine
  node scripts/set-persona.js --clear`);
    return;
  }

  if (args[0] === '--list') {
    listAvailable();
    return;
  }

  if (args[0] === '--clear') {
    fs.writeFileSync(FILE, JSON.stringify({ attributes: [], updated_at: new Date().toISOString() }, null, 2), 'utf-8');
    console.log('✅ 人格已清除');
    return;
  }

  if (args[0] === '--status') {
    if (fs.existsSync(FILE)) {
      const raw = fs.readFileSync(FILE, 'utf-8');
      console.log('当前活跃人格:');
      console.log(raw);
    } else {
      console.log('未设置活跃人格');
    }
    return;
  }

  // Set persona
  const parts = args[0].split(',');
  const attributes = parts.map(parseAttr);

  // Validate files exist
  for (const attr of attributes) {
    const yamlPath = path.join(ATTR_DIR, attr.category, attr.name + '.yaml');
    if (!fs.existsSync(yamlPath)) {
      console.error(`❌ 未找到: ${yamlPath}`);
      console.log('运行 --list 查看所有可用属性');
      process.exit(1);
    }
  }

  const data = { attributes, updated_at: new Date().toISOString() };
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(data, null, 2), 'utf-8');

  console.log(`✅ 人格已设置: ${attributes.map(a => `${a.category}/${a.name}`).join(', ')}`);
  console.log(`   文件: ${FILE}`);
}

main();
