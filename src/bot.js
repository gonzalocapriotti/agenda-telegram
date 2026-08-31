import { Telegraf } from 'telegraf';
import dotenv from 'dotenv';
import path from 'path';
import os from 'os';
import { AudioConverter } from './services/audioConverter.js';
import { GeminiService } from './services/geminiService.js';
import { DbService } from './services/dbService.js';
import { initScheduler } from './services/scheduler.js';

dotenv.config();

if (!process.env.TELEGRAM_BOT_TOKEN) {
  console.error('❌ Error: TELEGRAM_BOT_TOKEN no está definido en el archivo .env');
  process.exit(1);
}

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

// Inicializar el programador de recordatorios
initScheduler(bot);

bot.start((ctx) => {
  ctx.reply(
    '👋 ¡Hola! Soy tu Agenda Inteligente.\n\nEnvíame un mensaje de texto o una nota de voz y te enviaré un recordatorio automático en el momento exacto.'
  );
});

// Manejo de Texto
bot.on('text', async (ctx) => {
  const userMessage = ctx.message.text;
  if (userMessage.startsWith('/')) return;

  const statusMsg = await ctx.reply('🧠 Procesando instrucción con Gemini...');

  try {
    const taskData = await GeminiService.processText(userMessage);

    // Guardar en la Base de Datos SQLite
    await DbService.saveTask(ctx.chat.id, taskData);

    const responseText =
      `✅ *¡Tarea Agendada y Programada!*\n\n` +
      `📌 *Título:* ${taskData.titulo}\n` +
      `📝 *Descripción:* ${taskData.descripcion}\n` +
      `📅 *Recordatorio:* ${new Date(taskData.fecha_recordatorio).toLocaleString('es-AR')}\n` +
      `📍 *Lugar:* ${taskData.lugar_mencionado || 'No especificado'}\n\n` +
      `🔔 *Te enviaré una notificación en Telegram a la hora acordada.*`;

    await ctx.telegram.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      null,
      responseText,
      { parse_mode: 'Markdown' }
    );
  } catch (error) {
    console.error('Error en texto:', error);
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      null,
      '❌ Hubo un error al interpretar la tarea. Inténtalo de nuevo.'
    );
  }
});

// Manejo de Audio
bot.on('voice', async (ctx) => {
  const statusMsg = await ctx.reply('🎙️ Transcribiendo y procesando audio...');

  const timestamp = Date.now();
  const tempDir = os.tmpdir();
  const oggPath = path.join(tempDir, `voice_${timestamp}.ogg`);
  const mp3Path = path.join(tempDir, `voice_${timestamp}.mp3`);

  try {
    const fileId = ctx.message.voice.file_id;
    const fileLink = await ctx.telegram.getFileLink(fileId);

    await AudioConverter.downloadFile(fileLink.href, oggPath);
    await AudioConverter.convertOggToMp3(oggPath, mp3Path);

    const taskData = await GeminiService.processAudio(mp3Path);

    // Guardar en la Base de Datos SQLite
    await DbService.saveTask(ctx.chat.id, taskData);

    const responseText =
      `✅ *¡Nota de Voz Agendada y Programada!*\n\n` +
      `📌 *Título:* ${taskData.titulo}\n` +
      `📝 *Transcripción:* ${taskData.descripcion}\n` +
      `📅 *Recordatorio:* ${new Date(taskData.fecha_recordatorio).toLocaleString('es-AR')}\n` +
      `📍 *Lugar:* ${taskData.lugar_mencionado || 'No especificado'}\n\n` +
      `🔔 *Te enviaré una notificación en Telegram a la hora acordada.*`;

    await ctx.telegram.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      null,
      responseText,
      { parse_mode: 'Markdown' }
    );
  } catch (error) {
    console.error('Error en voz:', error);
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      null,
      '❌ Error al procesar el audio. Inténtalo de nuevo.'
    );
  } finally {
    AudioConverter.cleanupFiles(oggPath, mp3Path);
  }
});

bot.launch(() => {
  console.log('🤖 [Bot]: El Bot de Telegram de Agenda Inteligente está ONLINE');
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));