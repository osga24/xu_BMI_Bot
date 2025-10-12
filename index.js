import 'dotenv/config';
import { Telegraf } from 'telegraf';
import cron from 'node-cron';
import fs from 'fs/promises';
import path from 'path';

// ---------------------- 時區/日期/週工具（Asia/Taipei） ----------------------
function tzDate(d = new Date()) {
	return new Date(d.toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
}
function ymd(d = new Date()) {
	const dt = tzDate(d);
	const y = dt.getFullYear();
	const m = String(dt.getMonth() + 1).padStart(2, '0');
	const day = String(dt.getDate()).padStart(2, '0');
	return `${y}-${m}-${day}`;
}
// ISO 週（週一為第一天）
function getIsoWeekInfo(d = new Date()) {
	const dt = tzDate(d);
	dt.setHours(0, 0, 0, 0);
	const day = (dt.getDay() + 6) % 7; // 0=週一, 6=週日
	const thursday = new Date(dt);
	thursday.setDate(dt.getDate() + (3 - day));

	const firstThursday = new Date(thursday.getFullYear(), 0, 4);
	const firstThursdayDay = (firstThursday.getDay() + 6) % 7;
	firstThursday.setDate(firstThursday.getDate() - firstThursdayDay + 3);

	const week = 1 + Math.round((thursday - firstThursday) / 604800000);

	const monday = new Date(dt);
	monday.setDate(dt.getDate() - day);
	const sunday = new Date(monday);
	sunday.setDate(monday.getDate() + 6);

	return {
		isoYear: thursday.getFullYear(),
		isoWeek: week,
		weekStart: ymd(monday),
		weekEnd: ymd(sunday),
	};
}

const LOG_DIR_WEEK = process.env.LOG_DIR_WEEK || 'logs_weekly';
function weekFilePath(d = new Date()) {
	const { isoYear, isoWeek } = getIsoWeekInfo(d);
	const W = String(isoWeek).padStart(2, '0');
	return path.join(LOG_DIR_WEEK, `${isoYear}-W${W}.json`);
}
async function ensureDirWeek() {
	await fs.mkdir(LOG_DIR_WEEK, { recursive: true });
}
async function writeJsonAtomic(filePath, dataObj) {
	const tmp = `${filePath}.tmp`;
	await fs.writeFile(tmp, JSON.stringify(dataObj, null, 2), 'utf8');
	await fs.rename(tmp, filePath);
}
async function readWeekJson(filePath) {
	try {
		const text = await fs.readFile(filePath, 'utf8');
		return JSON.parse(text);
	} catch (e) {
		if (e.code === 'ENOENT') return null;
		throw e;
	}
}
async function appendWeeklyLog(record, now = new Date()) {
	await ensureDirWeek();
	const f = weekFilePath(now);
	const { isoYear, isoWeek, weekStart, weekEnd } = getIsoWeekInfo(now);
	const existing = await readWeekJson(f);
	const base = existing ?? {
		meta: { isoYear, isoWeek, weekStart, weekEnd, tz: 'Asia/Taipei' },
		items: [],
	};
	base.items.push(record);
	await writeJsonAtomic(f, base);
}
async function countTodayFromWeekly(chatId, now = new Date()) {
	const f = weekFilePath(now);
	const data = await readWeekJson(f);
	if (!data) return 0;
	const today = ymd(now);
	let c = 0;
	for (const it of data.items) {
		const d = it.created_at?.slice(0, 10); // YYYY-MM-DD
		if (it.chat_id === chatId && d === today) c++;
	}
	return c;
}

// ---------------------- Telegram mention 工具（MarkdownV2） ----------------------
function escapeMd(s) {
	return s.replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
}
function mentionUserMd(userId, name = '你') {
	return `[${escapeMd(name)}](tg://user?id=${userId})`;
}

// ---------------------- 兵役體位判定（以常見門檻實作） ----------------------
// 注意：體位標準可能調整；此為常見版本：
// - 身高 < 155 → 免役
// - BMI < 15 或 BMI > 35 → 免役
// - 15 ≤ BMI < 16.5 或 32 < BMI ≤ 35 → 替代役
// - 16.5 ≤ BMI ≤ 32 → 常備役
function classifyMilitary(heightCm, bmiVal) {
	if (heightCm < 155) return { rank: '免役', reason: '身高未達 155 公分' };
	if (bmiVal < 15) return { rank: '免役', reason: 'BMI < 15' };
	if (bmiVal > 35) return { rank: '免役', reason: 'BMI > 35' };
	if ((bmiVal >= 15 && bmiVal < 16.5) || (bmiVal > 32 && bmiVal <= 35)) {
		return { rank: '替代役', reason: null };
	}
	if (bmiVal >= 16.5 && bmiVal <= 32) {
		return { rank: '常備役', reason: null };
	}
	return { rank: '未定', reason: null };
}
// 計算距離「免役 BMI 門檻」最近還差多少
function distanceToExemptionBMI(bmiVal) {
	if (bmiVal < 15) return { reached: true, side: 'low', diff: +(15 - bmiVal).toFixed(1) };
	if (bmiVal > 35) return { reached: true, side: 'high', diff: +(bmiVal - 35).toFixed(1) };
	const toLower = +(bmiVal - 15).toFixed(1);   // 高出 15 多少
	const toUpper = +(35 - bmiVal).toFixed(1);   // 低於 35 多少
	if (toLower <= toUpper) return { reached: false, side: 'low', diff: toLower }; // 再降 toLower 就到 <15
	return { reached: false, side: 'high', diff: toUpper };                         // 再增 toUpper 就到 >35
}

// ---------------------- Bot 主程式 ----------------------
const bot = new Telegraf(process.env.TG_TOKEN);
if (!process.env.TG_TOKEN) {
	console.error('❌ 未設定 TG_TOKEN');
	process.exit(1);
}

const userState = new Map();

bot.command('id', (ctx) => {
	ctx.reply(`你的 user ID: ${ctx.from.id}\n這個聊天室 ID: ${ctx.chat.id}`);
});


// Main BMI

bot.start((ctx) =>
	ctx.reply('嗨！輸入 /bmi 開始計算 BMI；/today 看今天筆數；/cancel 取消流程。')
);

bot.command('bmi', (ctx) => {
	ctx.reply('請"回覆"身高與體重（例如：182 52 或 182,52）');
	userState.set(ctx.chat.id, { step: 'bmiInput' });
});

bot.command('cancel', (ctx) => {
	userState.delete(ctx.chat.id);
	ctx.reply('流程已取消。');
});

bot.command('today', async (ctx) => {
	const n = await countTodayFromWeekly(ctx.chat.id);
	ctx.reply(`本聊天室今天共有 ${n} 筆記錄。`);
});

// 只在流程中處理輸入
// === 2) 在流程訊息處理最前面先攔截 stop/取消 ===  // NEW
bot.on('message', async (ctx) => {
	const state = userState.get(ctx.chat.id);
	if (!state) return;

	const text = ctx.message.text?.trim();
	if (!text) return ctx.reply('請輸入身高與體重');

	// 可輸入 stop 或 取消 結束
	if (/^stop$/i.test(text) || text === '取消') {
		userState.delete(ctx.chat.id);
		return ctx.reply('流程已停止。');
	}

	if (state.step === 'bmiInput') {
		// 擷取兩個數字
		const match = text.match(/([\d.]+)[, ]+([\d.]+)/);
		if (!match) return ctx.reply('格式錯誤，請輸入例如：170 65');
		const height = parseFloat(match[1]);
		const weight = parseFloat(match[2]);
		if (isNaN(height) || isNaN(weight) || height <= 0 || weight <= 0)
			return ctx.reply('請輸入正確的數字');

		// 計算 BMI
		const bmi = weight / ((height / 100) ** 2);
		const v = +bmi.toFixed(1);

		// 體重分類
		let status = '';
		if (v < 18.5) status = '過輕';
		else if (v < 24) status = '正常';
		else status = '過重';

		// 兵役體位 + 距離免役
		const military = classifyMilitary(height, v);
		const dist = distanceToExemptionBMI(v);
		let distText = '';
		if (dist.reached) {
			distText = dist.side === 'low'
				? `你的 BMI 低於 15（低了 ${dist.diff}），已達免役門檻。`
				: `你的 BMI 高於 35（高了 ${dist.diff}），已達免役門檻。`;
		} else {
			distText = dist.side === 'low'
				? `若要達到免役（BMI < 15），BMI 需再降低 ${dist.diff}。`
				: `若要達到免役（BMI > 35），BMI 需再提高 ${dist.diff}。`;
		}

		const replyText =
			`你的 BMI 是 ${v}，屬於 ${status}。
兵役體位：${military.rank}${military.reason ? `（${military.reason}）` : ''}。
${distText}`;
		await ctx.reply(replyText);

		// 寫入週 JSON
		await appendWeeklyLog({
			chat_id: ctx.chat.id,
			user_id: ctx.from.id,
			username: ctx.from.username || `${ctx.from.first_name || ''} ${ctx.from.last_name || ''}`.trim(),
			height,
			weight,
			bmi: v,
			military_rank: military.rank,
			created_at: new Date().toISOString(),
		});

		userState.delete(ctx.chat.id);
	}
});

// ---------------------- 每日提醒（固定時間，Asia/Taipei） ----------------------
const REMIND_CHAT_ID = Number(process.env.REMIND_CHAT_ID);
const REMIND_USER_ID = Number(process.env.REMIND_USER_ID);
const REMIND_TIME = process.env.REMIND_TIME || '09:30';
const [HH, MM] = REMIND_TIME.split(':').map(n => parseInt(n, 10));
const cronExpr = `${MM} ${HH} * * *`;

cron.schedule(cronExpr, async () => {
	try {
		const count = await countTodayFromWeekly(REMIND_CHAT_ID);
		const mention = mentionUserMd(REMIND_USER_ID, '小徐');
		const msg = `${mention} 每日提醒：記得回報 BMI 或健康紀錄！\n（本聊天室今天已有 ${count} 筆）`;
		await bot.telegram.sendMessage(REMIND_CHAT_ID, msg, { parse_mode: 'MarkdownV2' });
		console.log(`[reminder] sent at ${REMIND_TIME} Asia/Taipei`);
	} catch (e) {
		console.error('reminder error:', e);
	}
}, { timezone: 'Asia/Taipei' });

// ---------------------- 啟動 ----------------------
bot.launch().then(() => console.log('✅ Bot running…'));
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
