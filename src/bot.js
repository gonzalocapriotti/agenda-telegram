import { Telegraf } from 'telegraf';
import { GoogleGenerativeAI } from '@google/generative-ai';
import sqlite3 from 'sqlite3';

// === 1. CONFIGURACIÓN Y BASE DE DATOS LOCAL ===
const token = process.env.TELEGRAM_TOKEN;
const apiKey = process.env.GEMINI_API_KEY;
const WEBHOOK_URL = process.env.WEBHOOK_AUDIOVISUAL_URL;

const bot = new Telegraf(token);
const genAI = new GoogleGenerativeAI(apiKey);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

// Inicialización de SQLite para Recordatorios Personales
const db = new sqlite3.Database('./recordatorios.db', (err) => {
  if (err) console.error("Error al conectar SQLite:", err);
  else console.log("💾 Base de datos SQLite conectada.");
});

db.run(`CREATE TABLE IF NOT EXISTS recordatorios (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  texto TEXT,
  fecha TEXT
)`);

// === 2. FUNCIONES DE CONEXIÓN A GOOGLE SHEETS ===

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

async function transcribirAudio(ctx, fileId) {
  try {
    const fileLink = await ctx.telegram.getFileLink(fileId);
    const response = await fetch(fileLink);
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    const audioPart = {
      inlineData: {
        data: buffer.toString("base64"),
        mimeType: "audio/ogg"
      }
    };

    const prompt = "Transcribí exactamente lo que se dice en este audio en español.";
    const result = await model.generateContent([prompt, audioPart]);
    return result.response.text().trim();
  } catch (error) {
    console.error("Error al transcribir audio:", error);
    return null;
  }
}

// === 3. COMANDOS PARA RECORDATORIOS LOCALES ===

bot.command('start', (ctx) => {
  ctx.reply("👋 ¡Hola! Soy tu asistente. Podés pedirme que guarde recordatorios, te muestre /tareas, o consultar y agendar reservas en la planilla de Audiovisuales.");
});

bot.command('tareas', (ctx) => {
  const userId = ctx.from.id;
  db.all("SELECT id, texto, fecha FROM recordatorios WHERE user_id = ?", [userId], (err, rows) => {
    if (err || !rows || rows.length === 0) {
      return ctx.reply("📋 No tenés recordatorios pendientes.");
    }
    let msg = "📋 *Tus Recordatorios Pendientes:*\n\n";
    rows.forEach(r => {
      msg += `id ${r.id}: ${r.texto}${r.fecha ? ' (' + r.fecha + ')' : ''}\n`;
    });
    msg += "\nUsá `/borrar [id]` para eliminar uno.";
    ctx.reply(msg, { parse_mode: 'Markdown' });
  });
});

bot.command('borrar', (ctx) => {
  const partes = ctx.message.text.split(" ");
  const id = partes[1];
  if (!id) return ctx.reply("⚠️ Debes indicar el id. Ejemplo: `/borrar 2`", { parse_mode: 'Markdown' });

  db.run("DELETE FROM recordatorios WHERE id = ? AND user_id = ?", [id, ctx.from.id], function(err) {
    if (err || this.changes === 0) {
      return ctx.reply("❌ No se encontró un recordatorio con ese ID.");
    }
    ctx.reply(`🗑️ Recordatorio ID ${id} eliminado con éxito.`);
  });
});

bot.command('ayuda', (ctx) => {
  ctx.reply("🤖 *Comandos disponibles:*\n/tareas - Ver tus recordatorios guardados\n/borrar [id] - Borrar un recordatorio\n/ayuda - Esta ayuda\n\nTambién podés mandarme notas de voz o texto libre para agendar tareas o gestionar Audiovisuales.", { parse_mode: 'Markdown' });
});

// === 4. PROCESADOR DE MENSAJES (TEXTO Y AUDIO) ===

bot.on(['text', 'voice'], async (ctx) => {
  let textoUsuario = "";

  try {
    if (ctx.message.voice) {
      await ctx.reply("🎙️ Escuchando tu audio...");
      textoUsuario = await transcribirAudio(ctx, ctx.message.voice.file_id);
      if (!textoUsuario) return ctx.reply("⚠️ No pude interpretar el audio.");
    } else if (ctx.message.text) {
      if (ctx.message.text.startsWith('/')) return;
      textoUsuario = ctx.message.text;
    }

    if (!textoUsuario) return;

    const fechaActual = new Date().toLocaleString("es-AR", { timeZone: "America/Argentina/Buenos_Aires" });

    const promptAI = `
    La fecha y hora actual en Argentina es ${fechaActual}.
    El usuario dijo: "${textoUsuario}".

    Analizá el pedido del usuario. Respondé ÚNICAMENTE con un objeto JSON estricto (sin etiquetas \`\`\`json):

    1. Si quiere CONSULTAR la planilla de Audiovisuales:
    {"accion": "consultar_audiovisual", "fecha": "5/9"}

    2. Si quiere AGREGAR/AGENDAR en la planilla de Audiovisuales:
    {"accion": "agregar_audiovisual", "fecha": "10/09/2026", "unidad": "SECUNDARIA", "horaInicio": "09:00", "lugar": "Hall", "actividad": "Proyector para 4to A", "responsable": ""}

    3. Si el usuario pide GUARDAR UN RECORDATORIO PERSONAL O TAREA LOCAL (ej: "Recordame comprar café mañana", "Anotá llamar al técnico"):
    {"accion": "guardar_recordatorio", "texto": "comprar café", "fecha": "mañana"}

    4. Si es una conversación o consulta general:
    {"accion": "charla", "respuesta": "Escribí tu respuesta conversacional habitual aquí."}
    `;

    const result = await model.generateContent(promptAI);
    let respuestaTexto = result.response.text().trim();

    if (respuestaTexto.startsWith("```json")) {
      respuestaTexto = respuestaTexto.replace(/^```json/, "").replace(/```$/, "").trim();
    } else if (respuestaTexto.startsWith("```")) {
      respuestaTexto = respuestaTexto.replace(/^```/, "").replace(/```$/, "").trim();
    }

    const respuestaIA = JSON.parse(respuestaTexto);

    // --- MANEJO DE ACCIONES ---

    // A. Consultar Audiovisuales
    if (respuestaIA.accion === "consultar_audiovisual") {
      await ctx.reply(`🔍 Consultando agenda para el ${respuestaIA.fecha}...`);
      const resultado = await consultarAudiovisuales(respuestaIA.fecha);

      if (resultado.status === "success" && resultado.resultados.length > 0) {
        let msgRespuesta = `🎬 *Reservas encontradas para el ${respuestaIA.fecha}:*\n\n`;
        resultado.resultados.forEach(item => {
          msgRespuesta += `• *${item.actividad}*\n  📍 Lugar: ${item.lugar}\n  ⏰ Hora: ${item.horaInicio}\n  🏫 Unidad: ${item.unidad}\n\n`;
        });
        await ctx.reply(msgRespuesta, { parse_mode: "Markdown" });
      } else {
        await ctx.reply(`❌ No hay reservas registradas en Audiovisuales para el ${respuestaIA.fecha}.`);
      }
    } 
    // B. Agregar a Audiovisuales
    else if (respuestaIA.accion === "agregar_audiovisual") {
      await ctx.reply(`⏳ Guardando registro en la planilla...`);
      const resultado = await agregarAudiovisual(respuestaIA);

      if (resultado.status === "success") {
        await ctx.reply(
          `✅ *¡Reserva guardada con éxito en la planilla!*\n\n📅 *Fecha:* ${respuestaIA.fecha}\n📌 *Actividad:* ${respuestaIA.actividad}\n📍 *Lugar:* ${respuestaIA.lugar}\n⏰ *Hora:* ${respuestaIA.horaInicio}`,
          { parse_mode: "Markdown" }
        );
      } else {
        await ctx.reply(`⚠️ No se pudo guardar el registro: ${resultado.message}`);
      }
    }
    // C. Guardar Recordatorio Local (SQLite)
    else if (respuestaIA.accion === "guardar_recordatorio") {
      const stmt = db.prepare("INSERT INTO recordatorios (user_id, texto, fecha) VALUES (?, ?, ?)");
      stmt.run(ctx.from.id, respuestaIA.texto, respuestaIA.fecha || "Sin fecha");
      stmt.finalize();
      await ctx.reply(`📌 *Recordatorio guardado:* "${respuestaIA.texto}"\n\nPodés verlo cuando quieras enviando /tareas`, { parse_mode: "Markdown" });
    }
    // D. Charla Conversacional
    else {
      await ctx.reply(respuestaIA.respuesta || "No pude interpretar tu solicitud.");
    }

  } catch (error) {
    console.error("Error en el procesador:", error);
    await ctx.reply("⚠️ Ocurrió un error al procesar tu solicitud.");
  }
});

bot.launch();
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
