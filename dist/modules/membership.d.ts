/**
 * 会员等级系统
 * T1 体验会员: 默认，10积分/天
 * T2 普通会员: 邀请5人或500积分购买，50积分/天
 * T3 高级会员: 邀请20人或2000积分购买，200积分/天
 * T4 至尊会员: 邀请50人或5000积分购买，不限量
 */
import { Pool } from 'pg';
export declare const TIERS: {
    1: {
        name: string;
        icon: string;
        dailyCredits: number;
        charSlots: number;
        inviteNeed: number;
        price: number;
    };
    2: {
        name: string;
        icon: string;
        dailyCredits: number;
        charSlots: number;
        inviteNeed: number;
        price: number;
    };
    3: {
        name: string;
        icon: string;
        dailyCredits: number;
        charSlots: number;
        inviteNeed: number;
        price: number;
    };
    4: {
        name: string;
        icon: string;
        dailyCredits: number;
        charSlots: number;
        inviteNeed: number;
        price: number;
    };
};
export declare function getTier(tier: number): any;
/**
 * 根据邀请人数自动升级
 */
export declare function autoUpgrade(pool: Pool, userId: number): Promise<any>;
/**
 * 积分购买会员
 */
export declare function buyMembership(pool: Pool, userId: number, tier: number): Promise<string | null>;
//# sourceMappingURL=membership.d.ts.map