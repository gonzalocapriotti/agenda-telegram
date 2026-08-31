import { Telegraf } from 'telegraf';
import dotenv from 'dotenv';
import path from 'path';
import os from 'os';
import { AudioConverter } from './services/audioConverter.js';
import { GeminiService } from './services/geminiService.js';
import { DbService } from './services/dbService.js';
import { initScheduler } from './services/scheduler.js';

const http = require('http'); // Si usás 'import', poné: import http from 'http';

// Servidor web de mentira para engañar a Render y que no apague el bot
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Bot de Agenda funcionando OK\n');
}).listen(PORT, () => {
  console.log(`🌐 Servidor web fantasma escuchando en el puerto ${PORT}`);
});

dotenv.config();

if (!process.env.TELEGRAM_BOT_TOKEN) {
  console.error('❌ Error: TELEGRAM_BOT_TOKEN no está definido en el archivo .env');
  process.exit(1);
}

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

// Inicializar el programador de recordatorios
initScheduler(bot);

// Comando /start y /ayuda
const sendHelp = (ctx) => {
  ctx.reply(
    `👋 *¡Hola! Soy tu Agenda Inteligente.*\n\n` +
      `Puedes enviarme notas de voz o mensajes de texto para agendar recordatorios.\n\n` +
      `📋 *Comandos disponibles:*\n` +
      `• /tareas - Ver la lista de recordatorios pendientes.\n` +
      `• /borrar <ID> - Eliminar una tarea (ejemplo: \`/borrar 3\`)\n` +
      `• /ayuda - Mostrar este mensaje de ayuda.`,
    { parse_mode: 'Markdown' }
  );
};

bot.start(sendHelp);
bot.command('ayuda', sendHelp);

// COMANDO: /tareas (Listar tareas pendientes)
bot.command('tareas', async (ctx) => {
  try {
    const tasks = await DbService.getAllPendingTasks(ctx.chat.id);

    if (tasks.length === 0) {
      return ctx.reply('🎉 *¡No tienes tareas pendientes agendadas!*', {
        parse_mode: 'Markdown',
      });
    }

    let message = `📋 *TUS TAREAS PENDIENTES:* \n\n`;

    tasks.forEach((task) => {
      const fecha = new Date(task.fecha_recordatorio).toLocaleString('es-AR');
      message += `🆔 *ID ${task.id}*: ${task.titulo}\n`;
      message += `📅 *Fecha:* ${fecha}\n`;
      if (task.lugar_mencionado) {
        message += `📍 *Lugar:* ${task.lugar_mencionado}\n`;
      }
      message += `------------------------\n`;
    });

    message += `\n💡 *Para eliminar una tarea usa:* \`/borrar <ID>\``;

    await ctx.reply(message, { parse_mode: 'Markdown' });
  } catch (error) {
    console.error('Error al listar tareas:', error);
    await ctx.reply('❌ Error al obtener la lista de tareas pendientes.');
  }
});

// COMANDO: /borrar <ID> (Eliminar una tarea)
bot.command('borrar', async (ctx) => {
  const input = ctx.message.text.split(' ');
  const taskId = parseInt(input[1], 10);

  if (isNaN(taskId)) {
    return ctx.reply(
      '⚠️ *Uso incorrecto.* Debes indicar el número de ID de la tarea.\nEjemplo: `/borrar 2`',
      { parse_mode: 'Markdown' }
    );
  }

  try {
    const deleted = await DbService.deleteTaskById(taskId, ctx.chat.id);

    if (deleted) {
      await ctx.reply(`✅ *Tarea con ID ${taskId} eliminada con éxito.*`, {
        parse_mode: 'Markdown',
      });
    } else {
      await ctx.reply(
        `❌ No se encontró ninguna tarea pendiente con el ID *${taskId}*.`,
        { parse_mode: 'Markdown' }
      );
    }
  } catch (error) {
    console.error('Error al borrar tarea:', error);
    await ctx.reply('❌ Error interno al intentar eliminar la tarea.');
  }
});

// Manejo de Texto
bot.on('text', async (ctx) => {
  const userMessage = ctx.message.text;
  if (userMessage.startsWith('/')) return;

  const statusMsg = await ctx.reply('🧠 Procesando instrucción con Gemini...');

  try {
    const taskData = await GeminiService.processText(userMessage);
    const taskId = await DbService.saveTask(ctx.chat.id, taskData);

    const responseText =
      `✅ *¡Tarea Agendada y Programada!*\n\n` +
      `🆔 *ID Tarea:* ${taskId}\n` +
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
    const taskId = await DbService.saveTask(ctx.chat.id, taskData);

    const responseText =
      `✅ *¡Nota de Voz Agendada y Programada!*\n\n` +
      `🆔 *ID Tarea:* ${taskId}\n` +
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
