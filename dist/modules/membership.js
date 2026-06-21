"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TIERS = void 0;
exports.getTier = getTier;
exports.autoUpgrade = autoUpgrade;
exports.buyMembership = buyMembership;
exports.TIERS = {
    1: { name: '体验会员', icon: '🌱', dailyCredits: 10, charSlots: 1, inviteNeed: 0, price: 0 },
    2: { name: '普通会员', icon: '⭐', dailyCredits: 50, charSlots: 3, inviteNeed: 5, price: 500 },
    3: { name: '高级会员', icon: '💎', dailyCredits: 200, charSlots: 10, inviteNeed: 20, price: 2000 },
    4: { name: '至尊会员', icon: '👑', dailyCredits: 99999, charSlots: 999, inviteNeed: 50, price: 5000 },
};
function getTier(tier) { return exports.TIERS[tier] || exports.TIERS[1]; }
/**
 * 根据邀请人数自动升级
 */
async function autoUpgrade(pool, userId) {
    const invCount = await pool.query('SELECT COUNT(*) as cnt FROM invite_codes WHERE created_by=$1', [userId]);
    const usedCount = await pool.query('SELECT COALESCE(SUM(use_count),0) as cnt FROM invite_codes WHERE created_by=$1', [userId]);
    const totalInvites = parseInt(usedCount.rows[0].cnt);
    const user = await pool.query('SELECT membership FROM user_accounts WHERE id=$1', [userId]);
    const currentTier = user.rows[0]?.membership || 1;
    let newTier = currentTier;
    if (totalInvites >= 50)
        newTier = 4;
    else if (totalInvites >= 20)
        newTier = 3;
    else if (totalInvites >= 5)
        newTier = 2;
    if (newTier > currentTier) {
        await pool.query('UPDATE user_accounts SET membership=$1 WHERE id=$2', [newTier, userId]);
        return newTier;
    }
    return currentTier;
}
/**
 * 积分购买会员
 */
async function buyMembership(pool, userId, tier) {
    const t = exports.TIERS[tier];
    if (!t || tier <= 1)
        return '无效的等级';
    const user = await pool.query('SELECT membership, credits FROM user_accounts WHERE id=$1', [userId]);
    if (user.rows[0].membership >= tier)
        return '你已是该等级或更高';
    if (user.rows[0].credits < t.price)
        return `积分不足，需要 ${t.price} 积分`;
    await pool.query('UPDATE user_accounts SET credits = credits - $1, membership = $2 WHERE id = $3', [t.price, tier, userId]);
    return null; // success
}
//# sourceMappingURL=membership.js.map