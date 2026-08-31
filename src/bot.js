import { Telegraf } from 'telegraf';
import dotenv from 'dotenv';
import path from 'path';
import os from 'os';
import { AudioConverter } from './services/audioConverter.js';
import { GeminiService } from './services/geminiService.js';
import { DbService } from './services/dbService.js';
import { initScheduler } from './services/scheduler.js';

import http from 'http';

// Servidor web de mentira para engañar a Render
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Bot funcionando OK\n');
}).listen(PORT, '0.0.0.0', () => {
  console.log(`🌐 Servidor web fantasma escuchando en el puerto ${PORT}`);
});

// Carga la URL que configuraste en Render
const WEBHOOK_URL = process.env.WEBHOOK_AUDIOVISUAL_URL;

// Función para consultar la planilla por fecha
async function consultarAudiovisuales(fecha) {
  try {
    const url = `${WEBHOOK_URL}?accion=consultar&fecha=${encodeURIComponent(fecha)}`;
    const response = await fetch(url);
    return await response.json();
  } catch (error) {
    console.error("Error al consultar la planilla:", error);
    return { status: "error", message: error.message };
  }
}

// Función para agregar un nuevo registro a la planilla
async function agregarAudiovisual(datos) {
  try {
    const params = new URLSearchParams({
      accion: "agregar",
      fecha: datos.fecha || "",
      unidad: datos.unidad || "SECUNDARIA",
      horaInicio: datos.horaInicio || "",
      lugar: datos.lugar || "",
      actividad: datos.actividad || "",
      responsable: datos.responsable || ""
    });

    const url = `${WEBHOOK_URL}?${params.toString()}`;
    const response = await fetch(url);
    return await response.json();
  } catch (error) {
    console.error("Error al agregar a la planilla:", error);
    return { status: "error", message: error.message };
  }
}

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
// Importante: Asegurate de tener estas dos funciones definidas arriba en tu src/bot.js:
// async function consultarAudiovisuales(fecha) { ... }
// async function agregarAudiovisual(datos) { ... }

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  let textoUsuario = "";

  try {
    // 1. Si el mensaje es VOZ, lo transcribimos primero
    if (msg.voice) {
      await bot.sendMessage(chatId, "🎙️ Escuchando tu audio...");
      // Aca usas la lógica que ya tenías para descargar el audio y transcribirlo con Gemini
      textoUsuario = await transcribirAudio(msg.voice.file_id); 
    } 
    // 2. Si el mensaje es TEXTO
    else if (msg.text) {
      textoUsuario = msg.text;
    } 
    else {
      return; // Si es un sticker, foto, etc., lo ignoramos
    }

    if (!textoUsuario) return;

    // 3. Enviamos el texto (o la transcripción) a Gemini para analizar la intención
    const fechaActual = new Date().toLocaleString("es-AR", { timeZone: "America/Argentina/Buenos_Aires" });
    
    const promptAI = `
    La fecha y hora actual es ${fechaActual}.
    El usuario dijo: "${textoUsuario}".

    Analizá el pedido. Si el usuario quiere hacer algo relacionado con la planilla de Audiovisuales, respondé ÚNICAMENTE con un objeto JSON sin formato Markdown (sin \`\`\`json):

    1. Si quiere CONSULTAR (ej: "¿Qué hay en audiovisuales el 5/9?"):
    {"accion": "consultar_audiovisual", "fecha": "5/9"}

    2. Si quiere AGREGAR/AGENDAR (ej: "Agendá proyector para 4to A el 10/9 a las 09:00 en el Hall"):
    {"accion": "agregar_audiovisual", "fecha": "10/09/2026", "unidad": "SECUNDARIA", "horaInicio": "09:00", "lugar": "Hall", "actividad": "Proyector para 4to A", "responsable": ""}

    3. Si es una charla normal o consulta que NO es de la planilla:
    {"accion": "charla", "respuesta": "Tu respuesta como asistente de IA aquí..."}
    `;

    const result = await model.generateContent(promptAI);
    const respuestaTexto = result.response.text();
    const respuestaIA = JSON.parse(respuestaTexto.trim());

    // --- OPCIONES DE RESPUESTA ---

    if (respuestaIA.accion === "consultar_audiovisual") {
      await bot.sendMessage(chatId, `🔍 Buscando reservas para el ${respuestaIA.fecha}...`);
      const resultado = await consultarAudiovisuales(respuestaIA.fecha);
      
      if (resultado.status === "success" && resultado.resultados.length > 0) {
        let msgRespuesta = `🎬 *Reservas encontradas para el ${respuestaIA.fecha}:*\n\n`;
        resultado.resultados.forEach(item => {
          msgRespuesta += `• *${item.actividad}*\n  📍 Lugar: ${item.lugar}\n  ⏰ Hora: ${item.horaInicio}\n  🏫 Unidad: ${item.unidad}\n\n`;
        });
        await bot.sendMessage(chatId, msgRespuesta, { parse_mode: "Markdown" });
      } else {
        await bot.sendMessage(chatId, `❌ No hay reservas registradas en Audiovisuales para el ${respuestaIA.fecha}.`);
      }
    } 
    else if (respuestaIA.accion === "agregar_audiovisual") {
      await bot.sendMessage(chatId, `⏳ Guardando reserva en la planilla...`);
      const resultado = await agregarAudiovisual(respuestaIA);
      
      if (resultado.status === "success") {
        await bot.sendMessage(chatId, `✅ *¡Reserva guardada con éxito!*\n\n📅 Fecha: ${respuestaIA.fecha}\n📌 Actividad: ${respuestaIA.actividad}\n📍 Lugar: ${respuestaIA.lugar}`, { parse_mode: "Markdown" });
      } else {
        await bot.sendMessage(chatId, `⚠️ Hubo un error al guardar en la planilla: ${resultado.message}`);
      }
    } 
    else {
      await bot.sendMessage(chatId, respuestaIA.respuesta || "No entendí la consulta.");
    }

  } catch (error) {
    console.error("Error al procesar el mensaje:", error);
    await bot.sendMessage(chatId, "⚠️ Ocurrió un error al procesar tu solicitud.");
  }
});

bot.launch(() => {
  console.log('🤖 [Bot]: El Bot de Telegram de Agenda Inteligente está ONLINE');
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
