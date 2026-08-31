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

// Inicialización de SQLite
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

// Procesador de voz mejorado
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

    const prompt = "Transcribí de forma exacta y literal el contenido de este mensaje de voz en español.";
    const result = await model.generateContent([prompt, audioPart]);
    return result.response.text().trim();
  } catch (error) {
    console.error("Error al transcribir audio:", error);
    return null;
  }
}

// === 3. COMANDOS DEL BOT ===

bot.command('start', (ctx) => {
  ctx.reply("👋 ¡Hola! Soy tu asistente personal.\n\n• Podés pedirme recordatorios: *'recordame en 10 minutos apagar el horno'*\n• Ver tus tareas: /tareas\n• Consultar o agendar en Audiovisuales mediante texto o notas de voz.", { parse_mode: 'Markdown' });
});

bot.command('tareas', (ctx) => {
  const userId = ctx.from.id;
  db.all("SELECT id, texto, fecha FROM recordatorios WHERE user_id = ?", [userId], (err, rows) => {
    if (err || !rows || rows.length === 0) {
      return ctx.reply("📋 No tenés recordatorios pendientes.");
    }
    let msg = "📋 *Tus Recordatorios Pendientes:*\n\n";
    rows.forEach(r => {
      msg += `• *[ID ${r.id}]* ${r.texto} (${r.fecha})\n`;
    });
    msg += "\nUsá `/borrar [id]` para eliminar uno.";
    ctx.reply(msg, { parse_mode: 'Markdown' });
  });
});

bot.command('borrar', (ctx) => {
  const partes = ctx.message.text.split(" ");
  const id = partes[1];
  if (!id) return ctx.reply("⚠️ Debés indicar el ID. Ejemplo: `/borrar 2`", { parse_mode: 'Markdown' });

  db.run("DELETE FROM recordatorios WHERE id = ? AND user_id = ?", [id, ctx.from.id], function(err) {
    if (err || this.changes === 0) {
      return ctx.reply("❌ No se encontró un recordatorio con ese ID.");
    }
    ctx.reply(`🗑️ Recordatorio ID ${id} eliminado correctamente.`);
  });
});

bot.command('ayuda', (ctx) => {
  ctx.reply("🤖 *Comandos:*\n/tareas - Ver pendientes\n/borrar [id] - Borrar pendiente\n/ayuda - Esta ayuda", { parse_mode: 'Markdown' });
});

// === 4. ESCUCHA PRINCIPAL (TEXTO Y AUDIO) ===

bot.on(['text', 'voice'], async (ctx) => {
  let textoUsuario = "";

  try {
    if (ctx.message.voice) {
      await ctx.reply("🎙️ Escuchando audio...");
      textoUsuario = await transcribirAudio(ctx, ctx.message.voice.file_id);
      if (!textoUsuario) {
        return ctx.reply("⚠️ No pude entender el audio. Por favor intentá hablar más claro o enviar un mensaje de texto.");
      }
    } else if (ctx.message.text) {
      if (ctx.message.text.startsWith('/')) return; // Ignorar comandos
      textoUsuario = ctx.message.text;
    }

    if (!textoUsuario) return;

    const fechaActual = new Date().toLocaleString("es-AR", { timeZone: "America/Argentina/Buenos_Aires" });

    const promptAI = `
    La fecha y hora actual en Argentina es ${fechaActual}.
    El usuario dijo: "${textoUsuario}".

    Analizá la intención del usuario. Respondé ÚNICAMENTE un objeto JSON estricto (sin etiquetas \`\`\`json):

    1. Si quiere CONSULTAR la planilla de Audiovisuales (ej: "¿Qué hay en audiovisuales el 5/9?"):
    {"accion": "consultar_audiovisual", "fecha": "5/9"}

    2. Si quiere AGREGAR/AGENDAR en la planilla de Audiovisuales:
    {"accion": "agregar_audiovisual", "fecha": "10/09/2026", "unidad": "SECUNDARIA", "horaInicio": "09:00", "lugar": "Hall", "actividad": "Proyector para 4to A", "responsable": ""}

    3. Si pide UN RECORDATORIO TEMPORIZADO O TAREA (ej: "Recordame en 10 minutos apagar el horno", "Anotá comprar café", "Recordame mañana a las 15 hs llamar a Juan"):
    {"accion": "guardar_recordatorio", "texto": "detalle de la tarea", "minutos": 10, "fechaTexto": "en 10 minutos"}
    (Nota: si el usuario dice "en X minutos", poné el número de minutos en la clave "minutos". Si es una tarea sin tiempo exacto, poné "minutos": 0).

    4. Si es una conversación libre o pregunta general:
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

    // --- PROCESAMIENTO DE ACCIONES ---

    // CASO A: Consultar Audiovisuales
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
    // CASO B: Agregar a Audiovisuales
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
    // CASO C: Guardar Recordatorio (con temporizador activo si se indicaron minutos)
    else if (respuestaIA.accion === "guardar_recordatorio") {
      const stmt = db.prepare("INSERT INTO recordatorios (user_id, texto, fecha) VALUES (?, ?, ?)");
      const fechaInfo = respuestaIA.fechaTexto || (respuestaIA.minutos > 0 ? `en ${respuestaIA.minutos} min` : "Sin tiempo exacto");
      
      stmt.run(ctx.from.id, respuestaIA.texto, fechaInfo);
      stmt.finalize();

      // Si el usuario especificó minutos (ej: "en 10 minutos"), programamos la alarma en segundo plano
      if (respuestaIA.minutos && respuestaIA.minutos > 0) {
        const milisegundos = respuestaIA.minutos * 60 * 1000;
        
        await ctx.reply(`⏰ *Recordatorio programado:* "${respuestaIA.texto}"\n\nTe voy a avisar automáticamente en ${respuestaIA.minutos} minuto(s).`, { parse_mode: "Markdown" });

        setTimeout(async () => {
          try {
            await ctx.telegram.sendMessage(ctx.chat.id, `🔔 *¡ALARMA / RECORDATORIO!*\n\n📌 *Tarea:* ${respuestaIA.texto}`, { parse_mode: "Markdown" });
          } catch (e) {
            console.error("Error al enviar alarma programada:", e);
          }
        }, milisegundos);

      } else {
        await ctx.reply(`📌 *Recordatorio guardado:* "${respuestaIA.texto}"\n\nPodés revisarlo con /tareas`, { parse_mode: "Markdown" });
      }
    }
    // CASO D: Conversación General
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
