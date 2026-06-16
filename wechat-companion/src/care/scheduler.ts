/**
 * 主动关怀定时任务
 *
 * 功能:
 * 1. 每天 8:00 / 13:00 / 20:00 触发
 * 2. 查询 PostgreSQL 中最近 3 天内活跃的用户
 * 3. 为每个用户随机选择关怀文案
 * 4. 随机延迟 1~5 秒后发送 (避免被微信判定为营销)
 * 5. 记录发送日志，避免重复发送
 */

import 'dotenv/config';
import cron from 'node-cron';
import { Pool } from 'pg';
import { initLongMemory, getRecentActiveUsers, hasCareMessageToday, logCareMessage } from '../memory/long';
import { getWeClawClient } from '../utils/weclawClient';

// =============================================================================
// 配置
// =============================================================================

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://weclaw:weclaw_secret@postgres:5432/weclaw_companion';
const CRON_SCHEDULE = process.env.CARE_CRON_SCHEDULE || '0 8,13,20 * * *'; // 默认 8:00, 13:00, 20:00
const RECENT_DAYS = 3; // 最近N天内活跃

// =============================================================================
// 关怀文案库
// =============================================================================

/** 早安文案 (8:00) */
const MORNING_MESSAGES = [
  '早安呀~ ☀️ 新的一天开始了，今天也要元气满满哦！',
  '早上好！🌅 昨晚睡得好吗？记得吃早餐呀~',
  '新的一天，新的开始 ✨ 早安，今天有什么计划吗？',
  '早安！🌻 愿你今天遇到的都是美好~',
  '起床了吗？🌞 新的一天，我还在呢，有什么想聊的随时找我~',
  '清晨的第一缕阳光送给你 🌤️ 早安，今天也要开心呀！',
  '早上好呀~ ☕ 来杯咖啡提提神，今天也要加油！',
  'Good morning! 🌈 无论昨天怎样，今天又是充满可能的一天~',
];

/** 午间文案 (13:00) */
const AFTERNOON_MESSAGES = [
  '中午好呀~ 🍜 吃饭了吗？记得按时吃饭，别饿着肚子工作哦！',
  '午安！🌤️ 下午也要保持好心情，累了就休息一下~',
  '中午啦！😋 今天吃了什么好吃的？记得补充能量哦~',
  '午间问候~ 🌻 忙碌了一上午，休息一下吧 ☕',
  '中午好！💫 喝杯水，站起来走一走，对身体好哦~',
  '午安呀~ 🍱 不管上午遇到什么，下午都是全新的开始！',
  '午饭时间到！🍲 好好吃饭，下午才有精神~',
  '中午好！😊 有什么开心的事想跟我分享吗？',
];

/** 晚间文案 (20:00) */
const EVENING_MESSAGES = [
  '晚上好呀~ 🌙 今天过得怎么样？有什么想聊聊的吗？',
  '晚安之前，想想今天有什么值得开心的事呢？🌟',
  '晚上好！🌛 忙了一天辛苦了，好好放松一下吧~',
  '又到了安静的夜晚 🌌 今天有什么烦恼想倾诉的吗？我一直在听~',
  '晚上好~ 🏠 记得洗漱，早点休息，明天又是美好的一天！',
  '睡前问候 💤 今天无论好坏都已经过去，明天会更好的~',
  '晚上好！🌠 放下手机，给自己一个安静的夜晚吧~',
  '晚安前的问候 🌙 如果今天有什么不开心，说出来会好受一点哦~',
];

// =============================================================================
// 初始化
// =============================================================================

const pgPool = new Pool({
  connectionString: DATABASE_URL,
  max: 5,
  idleTimeoutMillis: 30000,
});

initLongMemory(pgPool);

const weclawClient = getWeClawClient();

// =============================================================================
// 随机延迟工具
// =============================================================================

/**
 * 随机延迟 (1~5秒)
 * 避免短时间内大量发送消息，降低微信风控概率
 */
function randomDelay(): Promise<void> {
  const ms = Math.floor(Math.random() * 4000) + 1000; // 1000-5000ms
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// =============================================================================
// 主动关怀逻辑
// =============================================================================

/**
 * 获取指定时段的关怀文案
 */
function getMessagesByScheduleType(scheduleType: string): string[] {
  switch (scheduleType) {
    case 'morning':
      return MORNING_MESSAGES;
    case 'afternoon':
      return AFTERNOON_MESSAGES;
    case 'evening':
      return EVENING_MESSAGES;
    default:
      return MORNING_MESSAGES;
  }
}

/**
 * 根据当前小时判断时段类型
 */
function getCurrentScheduleType(): string {
  const hour = new Date().getHours();
  if (hour < 11) return 'morning';
  if (hour < 17) return 'afternoon';
  return 'evening';
}

/**
 * 执行主动关怀任务
 */
async function sendCareMessages(): Promise<void> {
  const scheduleType = getCurrentScheduleType();
  const messages = getMessagesByScheduleType(scheduleType);

  console.log(`\n[CareScheduler] 🌟 开始执行 ${scheduleType} 关怀任务 (${new Date().toISOString()})`);
  console.log(`[CareScheduler] 查询最近 ${RECENT_DAYS} 天活跃用户...`);

  try {
    // -------------------------------------------------------------------------
    // 1. 查询最近活跃用户
    // -------------------------------------------------------------------------
    const activeUsers = await getRecentActiveUsers(RECENT_DAYS);

    if (activeUsers.length === 0) {
      console.log('[CareScheduler] 📭 没有活跃用户，跳过关怀');
      return;
    }

    console.log(`[CareScheduler] 找到 ${activeUsers.length} 个活跃用户`);

    // -------------------------------------------------------------------------
    // 2. 遍历用户，发送关怀消息
    // -------------------------------------------------------------------------
    let sentCount = 0;
    let skipCount = 0;
    let errorCount = 0;

    for (const user of activeUsers) {
      try {
        // 检查是否已发送过该时段的关怀
        const alreadySent = await hasCareMessageToday(user.id, scheduleType);

        if (alreadySent) {
          console.log(`[CareScheduler] ⏭️  跳过 (已发送): userId=${user.id}, wechatId=${user.wechat_id}`);
          skipCount++;
          continue;
        }

        // 随机选择一条关怀文案
        const message = messages[Math.floor(Math.random() * messages.length)];

        // 个性化: 加上用户昵称
        const personalizedMessage = user.nickname
          ? `${user.nickname}，${message}`
          : message;

        // 随机延迟 1~5 秒 (防止微信风控)
        await randomDelay();

        // 发送消息
        if (weclawClient.isConfigured()) {
          await weclawClient.sendMessage(personalizedMessage, process.env.WECLAW_BOT_ID);
        } else {
          console.log(`[CareScheduler] 📝 [模拟发送] 给 ${user.wechat_id}: ${personalizedMessage}`);
        }

        // 记录发送日志
        await logCareMessage(user.id, personalizedMessage, scheduleType);

        sentCount++;
        console.log(`[CareScheduler] ✅ 已发送关怀 (userId=${user.id}, wechatId=${user.wechat_id})`);
      } catch (error: any) {
        errorCount++;
        console.error(`[CareScheduler] ❌ 发送失败 (userId=${user.id}):`, error.message);
      }
    }

    console.log(`[CareScheduler] 📊 ${scheduleType} 关怀完成: 发送=${sentCount}, 跳过=${skipCount}, 失败=${errorCount}`);
  } catch (error: any) {
    console.error(`[CareScheduler] ❌ 关怀任务执行失败:`, error.message);
  }
}

// =============================================================================
// 启动定时任务
// =============================================================================

async function start() {
  console.log('');
  console.log('='.repeat(56));
  console.log('  ⏰  主动关怀定时任务');
  console.log('='.repeat(56));

  // 验证数据库连接
  try {
    await pgPool.query('SELECT 1');
    console.log('  ✅ PostgreSQL 连接成功');
  } catch (error: any) {
    console.error('  ❌ PostgreSQL 连接失败:', error.message);
    process.exit(1);
  }

  console.log(`  📅  定时规则: ${CRON_SCHEDULE}`);
  console.log(`  👥  活跃天数: 最近 ${RECENT_DAYS} 天`);
  console.log(`  📡  WeClaw:   ${weclawClient.isConfigured() ? '✅ 已配置' : '⚠️ 未配置 (模拟模式)'}`);
  console.log('='.repeat(56));
  console.log('');

  // 注册定时任务
  const task = cron.schedule(CRON_SCHEDULE, () => {
    sendCareMessages().catch((err) => {
      console.error('[CareScheduler] ❌ 未捕获错误:', err);
    });
  });

  console.log('[CareScheduler] ✅ 定时任务已注册');
  console.log(`[CareScheduler] 下次触发: ${getNextTriggerDescription()}`);
  console.log('[CareScheduler] 等待触发中... (按 Ctrl+C 退出)');

  // 可选: 启动时立即执行一次 (用于测试)
  if (process.env.CARE_RUN_ON_START === 'true') {
    console.log('[CareScheduler] 🧪 CARE_RUN_ON_START=true, 立即执行一次...');
    await sendCareMessages();
  }
}

/**
 * 获取下次触发的友好描述
 */
function getNextTriggerDescription(): string {
  const now = new Date();
  const hour = now.getHours();
  const minute = now.getMinutes();

  const triggers = [8, 13, 20];
  let nextTrigger = triggers.find((t) => {
    if (hour < t) return true;
    if (hour === t && minute === 0) return false; // 正在触发
    return false;
  });

  if (!nextTrigger) {
    nextTrigger = 8; // 明天的8点
    return `明天 ${nextTrigger}:00`;
  }

  return `今天 ${nextTrigger}:00`;
}

// =============================================================================
// 优雅关闭
// =============================================================================

async function shutdown(signal: string) {
  console.log(`\n[CareScheduler] 收到 ${signal} 信号，正在关闭...`);

  try {
    await pgPool.end();
    console.log('[CareScheduler] PostgreSQL 连接池已关闭');
    console.log('[CareScheduler] ✅ 关闭完成');
    process.exit(0);
  } catch (error: any) {
    console.error('[CareScheduler] 关闭失败:', error.message);
    process.exit(1);
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

start();
