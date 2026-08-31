import { Telegraf } from 'telegraf';
import { GoogleGenerativeAI } from '@google/generative-ai';

// === 1. CONFIGURACIÓN ===
const token = process.env.TELEGRAM_TOKEN;
const apiKey = process.env.GEMINI_API_KEY;
const WEBHOOK_URL = process.env.WEBHOOK_AUDIOVISUAL_URL;

const bot = new Telegraf(token);
const genAI = new GoogleGenerativeAI(apiKey);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

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

// === 3. COMANDOS EXISTENTES ===

bot.command('ayuda', (ctx) => {
  ctx.reply("🤖 *Comandos disponibles:*\n/tareas - Ver lista\n/borrar - Eliminar elemento\n/ayuda - Esta ayuda\n\nTambién podés mandarme notas de voz o texto libre para agendar o consultar en Audiovisuales.", { parse_mode: 'Markdown' });
});

bot.command('tareas', (ctx) => {
  ctx.reply("📋 Lista de tareas activa.");
});

bot.command('borrar', (ctx) => {
  ctx.reply("🗑️ Modo borrado activado.");
});

// === 4. ESCUCHA GENERAL DE TEXTO Y VOZ PARA GEMINI Y SHEETS ===

bot.on(['text', 'voice'], async (ctx) => {
  let textoUsuario = "";

  try {
    if (ctx.message.voice) {
      await ctx.reply("🎙️ Escuchando tu audio...");
      textoUsuario = await transcribirAudio(ctx, ctx.message.voice.file_id);
      if (!textoUsuario) {
        await ctx.reply("⚠️ No pude interpretar el audio.");
        return;
      }
    } else if (ctx.message.text) {
      // Ignorar si es un comando con /
      if (ctx.message.text.startsWith('/')) return;
      textoUsuario = ctx.message.text;
    }

    if (!textoUsuario) return;

    const fechaActual = new Date().toLocaleString("es-AR", { timeZone: "America/Argentina/Buenos_Aires" });

    const promptAI = `
    La fecha y hora actual en Argentina es ${fechaActual}.
    El usuario dijo: "${textoUsuario}".

    Analizá el pedido. Si el usuario quiere interactuar con la planilla de Audiovisuales, respondé ÚNICAMENTE un objeto JSON estricto (sin bloques \`\`\`json):

    1. Si quiere CONSULTAR la planilla (ej: "¿Qué hay en audiovisuales el 5/9?"):
    {"accion": "consultar_audiovisual", "fecha": "5/9"}

    2. Si quiere AGREGAR/AGENDAR en la planilla (ej: "Agendá proyector para 4to A el 10/9 a las 09:00 en el Hall"):
    {"accion": "agregar_audiovisual", "fecha": "10/09/2026", "unidad": "SECUNDARIA", "horaInicio": "09:00", "lugar": "Hall", "actividad": "Proyector para 4to A", "responsable": ""}

    3. Si es una conversación o consulta libre:
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
    else if (respuestaIA.accion === "agregar_audiovisual") {
      await ctx.reply(`⏳ Guardando registro en la planilla...`);
      const resultado = await agregarAudiovisual(respuestaIA);

      if (resultado.status === "success") {
        await ctx.reply(
          `✅ *¡Reserva guardada con éxito!*\n\n📅 *Fecha:* ${respuestaIA.fecha}\n📌 *Actividad:* ${respuestaIA.actividad}\n📍 *Lugar:* ${respuestaIA.lugar}\n⏰ *Hora:* ${respuestaIA.horaInicio}`,
          { parse_mode: "Markdown" }
        );
      } else {
        await ctx.reply(`⚠️ No se pudo guardar el registro: ${resultado.message}`);
      }
    } 
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
