import TelegramBot from 'node-telegram-bot-api';
import { GoogleGenerativeAI } from '@google/generative-ai';

// === 1. CONFIGURACIÓN Y CLIENTES ===
const token = process.env.TELEGRAM_TOKEN;
const apiKey = process.env.GEMINI_API_KEY;
const WEBHOOK_URL = process.env.WEBHOOK_AUDIOVISUAL_URL;

const bot = new TelegramBot(token, { polling: true });
const genAI = new GoogleGenerativeAI(apiKey);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

// === 2. FUNCIONES DE CONEXIÓN CON GOOGLE SHEETS ===

// Consulta reservas por fecha
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

// Agrega una nueva reserva
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

// Función para procesar notas de voz con Gemini
async function transcribirAudio(fileId) {
  try {
    const fileLink = await bot.getFileLink(fileId);
    const response = await fetch(fileLink);
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    const audioPart = {
      inlineData: {
        data: buffer.toString("base64"),
        mimeType: "audio/ogg"
      }
    };

    const prompt = "Transcribí exactamente lo que dice este mensaje de audio en español.";
    const result = await model.generateContent([prompt, audioPart]);
    return result.response.text().trim();
  } catch (error) {
    console.error("Error al transcribir audio:", error);
    return null;
  }
}

// === 3. MANEJADOR PRINCIPAL DE MENSAJES (TEXTO Y AUDIO) ===

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  let textoUsuario = "";

  try {
    // A. Si es un mensaje de VOZ
    if (msg.voice) {
      await bot.sendMessage(chatId, "🎙️ Escuchando audio...");
      textoUsuario = await transcribirAudio(msg.voice.file_id);
      if (!textoUsuario) {
        await bot.sendMessage(chatId, "⚠️ No pude entender el audio.");
        return;
      }
    } 
    // B. Si es un mensaje de TEXTO
    else if (msg.text) {
      textoUsuario = msg.text;
    } 
    else {
      return; // Ignorar fotos, stickers, etc.
    }

    // C. Analizar la intención del mensaje con Gemini
    const fechaActual = new Date().toLocaleString("es-AR", { timeZone: "America/Argentina/Buenos_Aires" });

    const promptAI = `
    La fecha y hora actual en Argentina es ${fechaActual}.
    El usuario dijo: "${textoUsuario}".

    Analizá el pedido. Si el usuario quiere interactuar con la planilla de Audiovisuales, respondé ÚNICAMENTE un objeto JSON estricto (sin bloques \`\`\`json, solo el texto del JSON):

    1. Si quiere CONSULTAR la planilla (ej: "¿Qué hay en audiovisuales el 5/9?"):
    {"accion": "consultar_audiovisual", "fecha": "5/9"}

    2. Si quiere AGREGAR/AGENDAR en la planilla (ej: "Agendá proyector para 4to A el 10/9 a las 09:00 en el Hall"):
    {"accion": "agregar_audiovisual", "fecha": "10/09/2026", "unidad": "SECUNDARIA", "horaInicio": "09:00", "lugar": "Hall", "actividad": "Proyector para 4to A", "responsable": ""}

    3. Si es una consulta general o charla que NO requiere modificar o leer la planilla:
    {"accion": "charla", "respuesta": "Escribí acá tu respuesta amable como asistente virtual."}
    `;

    const result = await model.generateContent(promptAI);
    let respuestaTexto = result.response.text().trim();
    
    // Limpiar posibles etiquetas de Markdown JSON
    if (respuestaTexto.startsWith("```json")) {
      respuestaTexto = respuestaTexto.replace(/^```json/, "").replace(/```$/, "").trim();
    } else if (respuestaTexto.startsWith("```")) {
      respuestaTexto = respuestaTexto.replace(/^```/, "").replace(/```$/, "").trim();
    }

    const respuestaIA = JSON.parse(respuestaTexto);

    // D. Ejecutar la acción según la decisión de la IA

    // CASO 1: Consultar la planilla
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
    // CASO 2: Agregar a la planilla
    else if (respuestaIA.accion === "agregar_audiovisual") {
      await bot.sendMessage(chatId, `⏳ Guardando reserva en la planilla...`);
      const resultado = await agregarAudiovisual(respuestaIA);

      if (resultado.status === "success") {
        await bot.sendMessage(chatId, `✅ *¡Reserva guardada con éxito!*\n\n📅 Fecha: ${respuestaIA.fecha}\n📌 Actividad: ${respuestaIA.actividad}\n📍 Lugar: ${respuestaIA.lugar}\n⏰ Hora: ${respuestaIA.horaInicio}`, { parse_mode: "Markdown" });
      } else {
        await bot.sendMessage(chatId, `⚠️ Hubo un error al guardar en la planilla: ${resultado.message}`);
      }
    } 
    // CASO 3: Charla general
    else {
      await bot.sendMessage(chatId, respuestaIA.respuesta || "No pude procesar la consulta.");
    }

  } catch (error) {
    console.error("Error procesando mensaje:", error);
    await bot.sendMessage(chatId, "⚠️ Ocurrió un error al procesar tu solicitud.");
  }
});
