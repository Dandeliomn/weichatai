#!/usr/bin/env node
/**
 * generate-charcard.js — hersona 人格 → SillyTavern 角色卡自动生成
 * =============================================================================
 *
 * 从 active_persona.json (由 set-persona.js 产出) 读取属性列表，
 * 解析 hersona YAML，生成 ST 兼容的角色卡 PNG。
 *
 * 用法:
 *   node scripts/generate-charcard.js                    # 从 active_persona.json 生成
 *   node scripts/generate-charcard.js --name "小雯"      # 指定角色名
 *   node scripts/generate-charcard.js --output ./data/   # 指定输出目录
 *
 * 输出: <角色名>.png (SillyTavern 标准角色卡，可导入 ST)
 *
 * 依赖: js-yaml (npm install js-yaml)
 * =============================================================================
 */

'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// ---------------------------------------------------------------------------
// 配置 (与 relay 共用 PERSONA_PATH / HERSONA_ATTR_DIR 命名一致)
// ---------------------------------------------------------------------------

const PERSONA_PATH = process.env.PERSONA_PATH
  || path.join(require('os').homedir(), '.hermes', 'active_persona.json');
const ATTR_DIR = process.env.HERSONA_ATTR_DIR
  || path.join(__dirname, '..', 'vendor', 'hersona', 'attributes');
const ST_CHARS_DIR = process.env.ST_CHARS_DIR
  || path.join(__dirname, '..', 'st-data', '24926e2e3aa4-im-bot', 'data', 'default-user', 'characters');

// ---------------------------------------------------------------------------
// 1. 读取活跃人格 (与 set-persona.js 产出的 { attributes, updated_at } 兼容)
// ---------------------------------------------------------------------------

function loadActiveAttributes() {
  if (!fs.existsSync(PERSONA_PATH)) {
    console.error(`❌ 未找到活跃人格: ${PERSONA_PATH}`);
    console.error('   请先运行: node scripts/set-persona.js personality/tsundere');
    process.exit(1);
  }

  try {
    const raw = fs.readFileSync(PERSONA_PATH, 'utf-8');
    const data = JSON.parse(raw);

    // 兼容 `{ attributes: [...] }` (set-persona.js 格式)
    if (Array.isArray(data.attributes)) return data.attributes;

    // 降级: 兼容旧格式 `{ current, path }` 单文件
    if (data.path || data.file) {
      console.warn('⚠️ 检测到旧格式 active_persona.json (单文件)，将直接使用');
      return [{ category: 'old', name: 'custom', file: data.path || data.file }];
    }

    return [];
  } catch (e) {
    console.error(`❌ 读取人格文件失败: ${e.message}`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// 2. 读取属性 YAML (使用 js-yaml)
// ---------------------------------------------------------------------------

let jsyaml;
try {
  jsyaml = require('js-yaml');
} catch (e) {
  console.error('❌ 缺少 js-yaml 依赖，运行: npm install js-yaml');
  process.exit(1);
}

/**
 * 安全路径：防止 ../ 穿越
 */
function safeAttrPath(category, attrName) {
  const sanitized = path.basename(String(category) + '_' + String(attrName));
  const [catPart, namePart] = sanitized.split('_', 2);
  if (!catPart || !namePart) return null;
  return path.join(ATTR_DIR, catPart, namePart + '.yaml');
}

function loadAttributeYAML(attr) {
  // 兼容自定义单文件路径
  if (attr.file) {
    if (!fs.existsSync(attr.file)) {
      console.warn(`⚠️ 文件不存在: ${attr.file}`);
      return null;
    }
    try {
      const raw = fs.readFileSync(attr.file, 'utf-8');
      return jsyaml.load(raw) || {};
    } catch (e) {
      console.warn(`⚠️ 解析失败: ${attr.file} — ${e.message}`);
      return null;
    }
  }

  const yamlPath = safeAttrPath(attr.category, attr.name);
  if (!yamlPath || !fs.existsSync(yamlPath)) {
    console.warn(`⚠️ 跳过不存在的属性: ${attr.category || '?'}/${attr.name || '?'}`);
    return null;
  }

  try {
    const raw = fs.readFileSync(yamlPath, 'utf-8');
    return jsyaml.load(raw) || {};
  } catch (e) {
    console.warn(`⚠️ 解析失败: ${attr.category}/${attr.name} — ${e.message}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// 3. 构造 SillyTavern 角色卡 JSON (ccv3)
// ---------------------------------------------------------------------------

function buildCharacterCard(attrs, options) {
  const name = sanitizeName(options.name || deriveName(attrs));
  const yamls = attrs.map(loadAttributeYAML).filter(Boolean);

  // 收集描述
  const descriptions = yamls.map(y => y.description || '').filter(Boolean);
  const description = descriptions.join('\n\n');

  // 收集核心特质
  const allTraits = [];
  for (const y of yamls) {
    if (Array.isArray(y.core_traits)) {
      allTraits.push(...y.core_traits.map(String));
    }
  }

  // 收集人格描述
  const personality = yamls
    .map(y => {
      const cat = y.attribute_category || '';
      const disp = y.display_name || y.attribute_name || '';
      const desc = (y.description || '').replace(/\n/g, ' ');
      return `[${cat}] ${disp}: ${desc}`;
    })
    .join('\n');

  // 收集口头禅
  const catchphrases = [];
  for (const y of yamls) {
    if (Array.isArray(y.catchphrases)) {
      catchphrases.push(...y.catchphrases.map(p =>
        typeof p === 'string' ? p : (p.phrase || '')
      ).filter(Boolean));
    }
  }

  // 收集语气
  const tones = yamls.map(y => y.tone || '').filter(Boolean);
  const tone = tones.join('; ');

  // 首条消息
  const firstMsg = catchphrases.length > 0
    ? catchphrases[0]
    : `你好呀，我是${name}~`;

  // 示例对话 — 从 YAML examples 提取
  const exampleDialogue = extractExamples(yamls);

  // 场景设定
  const archetypes = attrs.filter(a => a.category === 'archetype');
  const scenario = archetypes.length > 0
    ? `你与${name}的关系: ${archetypes.map(a => a.name).join(', ')}`
    : '你们刚开始认识';

  // 标签
  const allTags = new Set();
  for (const y of yamls) {
    if (Array.isArray(y.tags)) {
      y.tags.forEach(t => allTags.add(String(t)));
    }
    if (y.attribute_category) allTags.add(y.attribute_category);
    if (y.attribute_name) allTags.add(y.attribute_name);
  }

  // System prompt
  const systemPrompt = buildSystemPrompt(name, allTraits, tone, catchphrases);

  return {
    spec: 'chara_card_v3',
    spec_version: '3.0',
    data: {
      name,
      description: description || `${name}是一个由hersona属性生成的AI角色。`,
      personality: personality || `${name}具有独特的性格特征。`,
      scenario,
      first_mes: firstMsg,
      mes_example: exampleDialogue,
      system_prompt: systemPrompt,
      creator_notes: `Generated by hersona charcard generator\nAttributes: ${attrs.map(a => `${a.category || '?'}/${a.name || 'unknown'}`).join(', ')}`,
      character_version: '1.0.0',
      tags: Array.from(allTags),
      extensions: {},
    },
  };
}

/**
 * 清理名称 — 防止路径穿越
 */
function sanitizeName(raw) {
  return String(raw || '').replace(/[\/\\:*?"<>|]/g, '_').trim() || '助手';
}

function deriveName(attrs) {
  const nameMap = {
    tsundere: '傲娇酱', deredere: '小甜心', kuudere: '冷面侠', yandere: '病娇妹',
    genki: '元气少女', dandere: '害羞鬼', himedere: '小公主', laid_back: '悠然君',
    childhood_friend: '青梅', heroine: '女主角', mentor: '导师', rival: '对手桑',
    gamer_otaku: '宅宅', idol: '偶像酱', playful: '调皮鬼', serious: '认真君',
    protective: '守护者', intellectual: '智慧型', optimist: '乐观派', pessimist: '悲观君',
    mysterious: '神秘人', stoic: '淡定理', crybaby: '小哭包',
  };

  for (const attr of attrs) {
    if (nameMap[attr.name]) return nameMap[attr.name];
  }
  return '助手';
}

function extractExamples(yamls) {
  const lines = [];
  for (const y of yamls) {
    if (Array.isArray(y.examples)) {
      for (const ex of y.examples) {
        lines.push(String(ex));
      }
    }
  }
  if (lines.length === 0) {
    return `<START>\n{{user}}: 你好呀\n{{char}}: 你好~`;
  }
  return '<START>\n' + lines.slice(0, 5).join('\n');
}

function buildSystemPrompt(name, traits, tone, catchphrases) {
  const parts = [
    `你是 ${name}。`,
    '',
    '【核心性格】',
    traits.length > 0 ? traits.map(t => `- ${t}`).join('\n') : '- 友善、温暖',
    '',
    '【语气风格】',
    tone || '自然、流畅、有温度',
    '',
    '【规则】',
    '- 始终以角色的第一人称回复，不要加说理解释或旁白。',
    '- 回复要简短自然，像真人聊天，不要长篇大论。',
    '- 用中文回复。',
  ];

  if (catchphrases.length > 0) {
    parts.push('\n【常用口头禅】');
    parts.push(catchphrases.slice(0, 5).map(p => `- ${p}`).join('\n'));
  }

  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// 4. PNG + JSON 嵌入式角色卡 (SillyTavern 标准格式)
// ---------------------------------------------------------------------------

function createCharCardPNG(cardData) {
  const avatarPixels = generateAvatarPNG(cardData.data.tags);
  const jsonStr = JSON.stringify(cardData, null, 2);
  const jsonBuf = Buffer.from(jsonStr, 'utf-8');
  return Buffer.concat([avatarPixels, jsonBuf]);
}

function generateAvatarPNG(tags) {
  const colorMap = {
    tsundere: '#FF6B6B', yandere: '#8B0000', deredere: '#FFB6C1',
    kuudere: '#87CEEB', genki: '#FFD700', himedere: '#DDA0DD',
    laid_back: '#90EE90', serious: '#708090', playful: '#FFA500',
    protective: '#4682B4', intellectual: '#4B0082', mysterious: '#2F4F4F',
    childhood_friend: '#98FB98', rival: '#FF6347', idol: '#FF69B4',
  };

  let bgColor = '#5B9BD5';
  for (const tag of (Array.isArray(tags) ? tags : [])) {
    if (colorMap[String(tag)]) { bgColor = colorMap[String(tag)]; break; }
  }

  const r = parseInt(bgColor.slice(1, 3), 16);
  const g = parseInt(bgColor.slice(3, 5), 16);
  const b = parseInt(bgColor.slice(5, 7), 16);
  const width = 80, height = 80;

  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8; ihdrData[9] = 2;
  ihdrData[10] = 0; ihdrData[11] = 0; ihdrData[12] = 0;
  const ihdr = createChunk('IHDR', ihdrData);

  const rawScanlines = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    const offset = y * (1 + width * 3);
    rawScanlines[offset] = 0;
    for (let x = 0; x < width; x++) {
      rawScanlines[offset + 1 + x * 3] = r;
      rawScanlines[offset + 2 + x * 3] = g;
      rawScanlines[offset + 3 + x * 3] = b;
    }
  }
  const idat = createChunk('IDAT', zlib.deflateSync(rawScanlines));
  const iend = createChunk('IEND', Buffer.alloc(0));

  return Buffer.concat([signature, ihdr, idat, iend]);
}

function createChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = crc32(Buffer.concat([typeBuf, data]));
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc, 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function crc32(buf) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

// ---------------------------------------------------------------------------
// 5. 主流程
// ---------------------------------------------------------------------------

function main() {
  const args = process.argv.slice(2);
  const options = { name: null, output: null };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--name' && args[i + 1]) {
      options.name = args[++i];
    } else if (args[i] === '--output' && args[i + 1]) {
      options.output = args[++i];
    } else if (args[i] === '--help') {
      console.log(`
用法:
  node scripts/generate-charcard.js [选项]

选项:
  --name <名字>     角色名称 (默认从属性自动推导)
  --output <目录>   输出目录 (默认: st-data 角色目录)
  --help            显示此帮助

示例:
  node scripts/generate-charcard.js
  node scripts/generate-charcard.js --name "小雯"
`);
      return;
    }
  }

  // 1. 读取活跃人格
  console.log('📖 读取活跃人格...');
  const attrs = loadActiveAttributes();

  if (attrs.length === 0) {
    console.error('❌ 没有活跃属性。请先设置人格: node scripts/set-persona.js personality/tsundere');
    process.exit(1);
  }

  console.log(`  已选择属性: ${attrs.map(a => `${a.category || '?'}/${a.name || 'unknown'}`).join(', ')}`);

  // 2. 构建角色卡
  console.log('🔧 生成角色卡...');
  const card = buildCharacterCard(attrs, options);
  console.log(`  角色名: ${card.data.name}`);
  console.log(`  标签: ${Array.isArray(card.data.tags) ? card.data.tags.join(', ') : '无'}`);

  // 3. 生成 PNG
  console.log('🖼️ 生成头像...');
  const png = createCharCardPNG(card);

  // 4. 保存
  const outDir = options.output || ST_CHARS_DIR;
  try {
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  } catch (e) {
    console.error(`❌ 无法创建输出目录: ${outDir} — ${e.message}`);
    process.exit(1);
  }

  const fileName = sanitizeName(card.data.name) + '.png';
  const filePath = path.join(outDir, fileName);
  try {
    fs.writeFileSync(filePath, png);
  } catch (e) {
    console.error(`❌ 无法写入文件: ${filePath} — ${e.message}`);
    process.exit(1);
  }

  console.log(`\n✅ 角色卡已生成: ${filePath}`);
  console.log(`  大小: ${(png.length / 1024).toFixed(1)}KB`);
  console.log(`\n💡 下一步: 在 SillyTavern UI 中点击 "+" 导入此角色卡`);
  console.log(`   或重启 ST 容器，角色会自动出现在列表中。`);
}

main();
