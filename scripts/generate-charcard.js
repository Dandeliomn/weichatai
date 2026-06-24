#!/usr/bin/env node
/**
 * generate-charcard.js — hersona 人格 → SillyTavern 角色卡自动生成
 * =============================================================================
 *
 * 用法:
 *   node scripts/generate-charcard.js                    # 从 active_persona.json 生成
 *   node scripts/generate-charcard.js --name "小雯"      # 指定角色名
 *   node scripts/generate-charcard.js --output ./data/   # 指定输出目录
 *   node scripts/generate-charcard.js --openai           # 用 DeepSeek 生成示例对话
 *
 * 输出: <角色名>.png (SillyTavern 标准角色卡，可导入 ST)
 *
 * =============================================================================
 */

'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

const ACTIVE_PERSONA = process.env.ACTIVE_PERSONA_FILE
  || path.join(require('os').homedir(), '.hermes', 'active_persona.json');
const ATTR_DIR = process.env.HERSONA_ATTR_DIR
  || path.join(__dirname, '..', 'vendor', 'hersona', 'attributes');
const ST_CHARS_DIR = process.env.ST_CHARS_DIR
  || path.join(__dirname, '..', 'st-data', '24926e2e3aa4-im-bot', 'data', 'default-user', 'characters');

// ---------------------------------------------------------------------------
// 1. 读取活跃人格
// ---------------------------------------------------------------------------

function loadActiveAttributes() {
  if (!fs.existsSync(ACTIVE_PERSONA)) {
    console.error(`❌ 未找到活跃人格: ${ACTIVE_PERSONA}`);
    console.error('   请先运行: node scripts/set-persona.js personality/tsundere');
    process.exit(1);
  }
  const data = JSON.parse(fs.readFileSync(ACTIVE_PERSONA, 'utf-8'));
  return data.attributes || [];
}

// ---------------------------------------------------------------------------
// 2. 读取属性 YAML
// ---------------------------------------------------------------------------

function loadAttributeYAML(attr) {
  const yamlPath = path.join(ATTR_DIR, attr.category, attr.name + '.yaml');
  if (!fs.existsSync(yamlPath)) {
    console.warn(`⚠️ 跳过不存在的属性: ${attr.category}/${attr.name}`);
    return null;
  }
  const raw = fs.readFileSync(yamlPath, 'utf-8');
  return parseSimpleYAML(raw);
}

function parseSimpleYAML(raw) {
  const data = {};
  let currentKey = null;
  let currentMode = null; // null | 'array' | 'multiline'
  let multilineBuf = '';

  for (const line of raw.split('\n')) {
    const trimmed = line.trimEnd();
    const indent = line.length - line.trimStart().length;
    const content = line.trim();

    // 跳过空行和注释
    if (content === '' || content.startsWith('#')) {
      if (currentMode === 'multiline' && content === '') {
        multilineBuf += '\n';
      }
      continue;
    }

    // 多行模式续行
    if (currentMode === 'multiline') {
      if (indent >= 2) {
        multilineBuf += (multilineBuf ? '\n' : '') + content;
        continue;
      } else {
        // 多行结束
        data[currentKey] = multilineBuf;
        currentMode = null;
        multilineBuf = '';
        // 继续处理当前行
      }
    }

    // 顶层 key: |-, key: >, key: value
    const topMatch = content.match(/^(\w[\w_]*):\s*(.*)/);
    if (topMatch && indent === 0) {
      currentKey = topMatch[1];
      const val = topMatch[2].trim();

      if (val === '|-' || val === '>') {
        currentMode = 'multiline';
        multilineBuf = '';
        continue;
      }

      if (val === '' || val === '[]') {
        data[currentKey] = [];
        currentMode = 'array';
        continue;
      }

      data[currentKey] = parseYamlValue(val);
      currentMode = null;
      continue;
    }

    // 数组元素: - value 或 - |-
    const arrMatch = content.match(/^-\s+(.*)/);
    if (arrMatch && currentMode === 'array') {
      const arrVal = arrMatch[1].trim();
      if (arrVal === '|-') {
        currentMode = 'multiline';
        multilineBuf = '';
        // Start collecting multiline for array item
        // We'll append to the array when multiline ends
        continue;
      }
      if (!Array.isArray(data[currentKey])) data[currentKey] = [];
      data[currentKey].push(parseYamlValue(arrVal));
      continue;
    }

    // 缩进子键: key: value
    const subMatch = content.match(/^\s{2,}(\w[\w_]*):\s*(.*)/);
    if (subMatch && currentKey && currentMode !== 'multiline') {
      const subKey = currentKey + '.' + subMatch[1];
      data[subKey] = parseYamlValue(subMatch[2].trim());
      continue;
    }
  }

  // 清理末尾多行
  if (currentMode === 'multiline' && multilineBuf) {
    data[currentKey] = multilineBuf;
  }

  return data;
}

function parseYamlValue(val) {
  if (!val) return '';
  return val.replace(/^['"](.*)['"]$/, '$1');
}

// ---------------------------------------------------------------------------
// 3. 构造 SillyTavern 角色卡 JSON (ccv3)
// ---------------------------------------------------------------------------

function buildCharacterCard(attrs, options) {
  const name = options.name || deriveName(attrs);
  const yamls = attrs.map(loadAttributeYAML).filter(Boolean);

  // 收集描述
  const descriptions = yamls.map(y => y.description).filter(Boolean);
  const description = descriptions.join('\n\n');

  // 收集核心特质
  const allTraits = [];
  const coreTraitsKeys = yamls.filter(y => y.core_traits);
  for (const y of coreTraitsKeys) {
    const traits = Array.isArray(y.core_traits)
      ? y.core_traits
      : y.core_traits.split('\n').map(s => s.trim()).filter(Boolean);
    allTraits.push(...traits);
  }

  // 收集人格描述
  const personality = yamls
    .map(y => {
      const cat = y.attribute_category || '';
      const disp = y.display_name || y.attribute_name || '';
      const desc = y.description || '';
      return `[${cat}] ${disp}: ${desc}`;
    })
    .join('\n');

  // 收集口头禅
  const catchphrases = [];
  for (const y of yamls) {
    if (Array.isArray(y.catchphrases)) {
      catchphrases.push(...y.catchphrases);
    }
  }

  // 收集语气
  const tones = yamls.map(y => y.tone).filter(Boolean);
  const tone = tones.join('; ');

  // 首条消息
  const firstMes = catchphrases.length > 0
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
    if (Array.isArray(y.tags)) y.tags.forEach(t => allTags.add(t));
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
      description,
      personality,
      scenario,
      first_mes: firstMes,
      mes_example: exampleDialogue,
      system_prompt: systemPrompt,
      creator_notes: `Generated by hersona charcard generator\nAttributes: ${attrs.map(a => `${a.category}/${a.name}`).join(', ')}`,
      character_version: '1.0.0',
      tags: Array.from(allTags),
      extensions: {},
    },
  };
}

function deriveName(attrs) {
  // 从属性名组合一个中文名
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
        lines.push(ex);
      }
    }
  }
  if (lines.length === 0) {
    return `<START>\n{{user}}: 你好呀\n{{char}}: 你好~`;
  }
  // 取前5条示例
  return '<START>\n' + lines.slice(0, 5).join('\n');
}

function buildSystemPrompt(name, traits, tone, catchphrases) {
  const parts = [
    `你是 ${name}。`,
    '',
    `【核心性格】`,
    traits.length > 0 ? traits.map(t => `- ${t}`).join('\n') : '- 友善、温暖',
    '',
    `【语气风格】`,
    tone || '自然、流畅、有温度',
    '',
    `【规则】`,
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

/**
 * 生成最小 PNG (80x80 纯色头像) + 内嵌角色卡 JSON
 * 参考: https://github.com/SillyTavern/SillyTavern/blob/dev/public/scripts/chars/char-data.js
 *
 * ST 格式: 标准 PNG 文件 + JSON 直接追加在 IEND 之后
 */
function createCharCardPNG(cardData) {
  // 1) 生成纯色头像 PNG (根据标签选颜色)
  const avatarPixels = generateAvatarPNG(cardData.data.tags);

  // 2) 将 JSON 附加到 PNG 末尾
  const jsonStr = JSON.stringify(cardData, null, 2);
  const jsonBuf = Buffer.from(jsonStr, 'utf-8');

  return Buffer.concat([avatarPixels, jsonBuf]);
}

function generateAvatarPNG(tags) {
  // 根据属性选底色
  const colorMap = {
    tsundere: '#FF6B6B', yandere: '#8B0000', deredere: '#FFB6C1',
    kuudere: '#87CEEB', genki: '#FFD700', himedere: '#DDA0DD',
    laid_back: '#90EE90', serious: '#708090', playful: '#FFA500',
    protective: '#4682B4', intellectual: '#4B0082', mysterious: '#2F4F4F',
    childhood_friend: '#98FB98', rival: '#FF6347', idol: '#FF69B4',
  };

  let bgColor = '#5B9BD5'; // default blue
  for (const tag of tags) {
    if (colorMap[tag]) { bgColor = colorMap[tag]; break; }
  }

  const r = parseInt(bgColor.slice(1, 3), 16);
  const g = parseInt(bgColor.slice(3, 5), 16);
  const b = parseInt(bgColor.slice(5, 7), 16);

  const width = 80;
  const height = 80;

  // 生成 PNG (最小实现，无外部依赖)
  // PNG 结构: Signature | IHDR | IDAT | IEND
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  // IHDR
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);   // width
  ihdrData.writeUInt32BE(height, 4);  // height
  ihdrData[8] = 8;   // bit depth
  ihdrData[9] = 2;   // color type (RGB)
  ihdrData[10] = 0;  // compression
  ihdrData[11] = 0;  // filter
  ihdrData[12] = 0;  // interlace
  const ihdr = createChunk('IHDR', ihdrData);

  // IDAT — 用 zlib 压缩像素数据
  const rawScanlines = Buffer.alloc(height * (1 + width * 3)); // 1 filter byte + RGB
  for (let y = 0; y < height; y++) {
    const offset = y * (1 + width * 3);
    rawScanlines[offset] = 0; // filter: None
    for (let x = 0; x < width; x++) {
      rawScanlines[offset + 1 + x * 3] = r;
      rawScanlines[offset + 2 + x * 3] = g;
      rawScanlines[offset + 3 + x * 3] = b;
    }
  }
  const compressed = zlib.deflateSync(rawScanlines);
  const idat = createChunk('IDAT', compressed);

  // IEND
  const iend = createChunk('IEND', Buffer.alloc(0));

  return Buffer.concat([signature, ihdr, idat, iend]);
}

function createChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);

  const typeBuf = Buffer.from(type, 'ascii');
  const crc = crc32(Buffer.concat([typeBuf, data]));

  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc, 0);

  return Buffer.concat([length, typeBuf, data, crcBuf]);
}

function crc32(buf) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0);
    }
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

// ---------------------------------------------------------------------------
// 5. 主流程
// ---------------------------------------------------------------------------

function main() {
  const args = process.argv.slice(2);
  const options = { name: null, output: null, openai: false };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--name' && args[i + 1]) {
      options.name = args[++i];
    } else if (args[i] === '--output' && args[i + 1]) {
      options.output = args[++i];
    } else if (args[i] === '--openai') {
      options.openai = true;
    } else if (args[i] === '--help') {
      console.log(`
用法:
  node scripts/generate-charcard.js [选项]

选项:
  --name <名字>     角色名称 (默认从属性自动推导)
  --output <目录>   输出目录 (默认: st-data 角色目录)
  --openai          使用 DeepSeek 生成更丰富的示例对话
  --help            显示此帮助

示例:
  node scripts/generate-charcard.js
  node scripts/generate-charcard.js --name "小雯"
  node scripts/generate-charcard.js --output /tmp/ --name "测试角色"
`);
      return;
    }
  }

  // 1. 读取活跃人格
  console.log('📖 读取活跃人格...');
  const attrs = loadActiveAttributes();

  if (attrs.length === 0) {
    console.error('❌ 没有活跃属性和。请先设置人格: node scripts/set-persona.js personality/tsundere');
    process.exit(1);
  }

  console.log(`  已选择属性: ${attrs.map(a => `${a.category}/${a.name}`).join(', ')}`);

  // 2. 构建角色卡
  console.log('🔧 生成角色卡...');
  const card = buildCharacterCard(attrs, options);
  console.log(`  角色名: ${card.data.name}`);
  console.log(`  标签: ${card.data.tags.join(', ')}`);

  // 3. 生成 PNG
  console.log('🖼️ 生成头像...');
  const png = createCharCardPNG(card);

  // 4. 保存
  const outDir = options.output || ST_CHARS_DIR;
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  const fileName = `${card.data.name}.png`;
  const filePath = path.join(outDir, fileName);
  fs.writeFileSync(filePath, png);
  console.log(`\n✅ 角色卡已生成: ${filePath}`);
  console.log(`  大小: ${(png.length / 1024).toFixed(1)}KB`);
  console.log(`\n💡 下一步: 在 SillyTavern UI 中点击 "+" 导入此角色卡`);
  console.log(`   或重启 ST 容器，角色会自动出现在列表中。`);
}

main();
