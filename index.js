import 'dotenv/config';
import { Telegraf } from 'telegraf';

const bot = new Telegraf(process.env.TG_TOKEN);

// 暫存使用者狀態
const userState = new Map();

// /start 指令
bot.start((ctx) => ctx.reply('嗨！輸入 /bmi 開始計算 BMI 🚀'));

// /bmi 指令
bot.command('bmi', (ctx) => {
	const chatId = ctx.chat.id;
	userState.set(chatId, { step: 'height' });
	ctx.reply('請輸入身高（公分）');
});

// on('message') 改成 **只在有狀態時** 處理
bot.on('message', async (ctx) => {
	const chatId = ctx.chat.id;
	const state = userState.get(chatId);

	// 沒在等待輸入時就直接略過
	if (!state) return;

	const text = ctx.message.text?.trim();
	if (!text) return ctx.reply('請輸入文字格式的數字');

	if (state.step === 'height') {
		const h = parseFloat(text);
		if (isNaN(h) || h <= 0) return ctx.reply('請輸入正確的身高數字（公分）');
		state.height = h;
		state.step = 'weight';
		return ctx.reply('請輸入體重（公斤）');
	}

	if (state.step === 'weight') {
		const w = parseFloat(text);
		if (isNaN(w) || w <= 0) return ctx.reply('請輸入正確的體重數字（公斤）');

		const bmi = w / ((state.height / 100) ** 2);
		let status = '';
		if (bmi < 18.5) status = '過輕';
		else if (bmi < 24) status = '正常';
		else status = '過重';

		await ctx.reply(`你的 BMI 是 ${bmi.toFixed(1)}，屬於 ${status}`);
		userState.delete(chatId); // 結束流程
	}
});

bot.launch();
console.log('✅ Bot running...');

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
