import TelegramBot from 'node-telegram-bot-api';
import { GoogleGenerativeAI } from '@google/generative-ai';

// === 1. CONFIGURACIÓN Y VARIABLES DE ENTORNO ===
const token = process.env.TELEGRAM_TOKEN;
const apiKey = process.env.GEMINI_API_KEY;
const WEBHOOK_URL = process.env.WEBHOOK_AUDIOVISUAL_URL;

if (!token || !apiKey || !WEBHOOK_URL) {
  console.error("⚠️ Faltan variables de entorno requeridas (TELEGRAM_TOKEN, GEMINI_API_KEY, WEBHOOK_AUDIOVISUAL_URL).");
}

const bot = new TelegramBot(token, { polling: true });
const genAI = new GoogleGenerativeAI(apiKey);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

// === 2. FUNCIONES DE CONEXIÓN CON LA API WEB DE GOOGLE SHEETS ===

// Consulta las reservas filtradas por fecha
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

// Agrega una nueva fila de reserva a la pestaña "2026"
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

// === 3. FUNCION DE PROCESAMIENTO MULTIMODAL DE AUDIO ===

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

    const prompt = "Transcribí de forma exacta y literal lo que se dice en este mensaje de audio en español.";
    const result = await model.generateContent([prompt, audioPart]);
    return result.response.text().trim();
  } catch (error) {
    console.error("Error al procesar el archivo de voz:", error);
    return null;
  }
}

// === 4. PROCESADOR UNIFICADO DE MENSAJES (TEXTO Y VOZ) ===

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  let textoUsuario = "";

  try {
    // 1. Detección y extracción de entrada (Voz o Texto)
    if (msg.voice) {
      await bot.sendMessage(chatId, "🎙️ Escuchando y transcribiendo tu audio...");
      textoUsuario = await transcribirAudio(msg.voice.file_id);
      
      if (!textoUsuario) {
        await bot.sendMessage(chatId, "⚠️ No pude procesar o entender el audio enviado.");
        return;
      }
    } else if (msg.text) {
      textoUsuario = msg.text;
    } else {
      return; // Se ignoran stickers, imágenes, archivos o ubicaciones
    }

    // 2. Cálculo de contexto temporal (Zona Horaria Argentina)
    const fechaActual = new Date().toLocaleString("es-AR", { timeZone: "America/Argentina/Buenos_Aires" });

    // 3. Prompt de clasificación de intención para Gemini
    const promptAI = `
    La fecha y hora actual en Argentina es ${fechaActual}.
    El usuario dijo: "${textoUsuario}".

    Analizá la intención de la entrada. Si el usuario solicita interactuar con la planilla de reservas de Audiovisuales, devolvé ÚNICAMENTE un objeto JSON estructurado (sin formato Markdown, sin \`\`\`json):

    1. Si requiere CONSULTAR la agenda (ejemplo: "¿Qué hay en audiovisuales el 5 de septiembre?"):
    {"accion": "consultar_audiovisual", "fecha": "5/9"}

    2. Si requiere AGREGAR una reserva (ejemplo: "Agendá proyector para 4to A el 10/9 a las 09:00 en el Hall"):
    {"accion": "agregar_audiovisual", "fecha": "10/09/2026", "unidad": "SECUNDARIA", "horaInicio": "09:00", "lugar": "Hall", "actividad": "Proyector para 4to A", "responsable": ""}

    3. Si es una conversación libre, pregunta general o asistencia no relacionada a la planilla:
    {"accion": "charla", "respuesta": "Escribí tu respuesta conversacional habitual aquí."}
    `;

    const result = await model.generateContent(promptAI);
    let respuestaTexto = result.response.text().trim();

    // Limpieza de formato Markdown en la respuesta devuelta por el modelo
    if (respuestaTexto.startsWith("```json")) {
      respuestaTexto = respuestaTexto.replace(/^```json/, "").replace(/```$/, "").trim();
    } else if (respuestaTexto.startsWith("```")) {
      respuestaTexto = respuestaTexto.replace(/^```/, "").replace(/```$/, "").trim();
    }

    const respuestaIA = JSON.parse(respuestaTexto);

    // 4. Ejecución del flujo según la intención clasificada

    if (respuestaIA.accion === "consultar_audiovisual") {
      await bot.sendMessage(chatId, `🔍 Consultando agenda para el ${respuestaIA.fecha}...`);
      const resultado = await consultarAudiovisuales(respuestaIA.fecha);

      if (resultado.status === "success" && resultado.resultados.length > 0) {
        let msgRespuesta = `🎬 *Reservas encontradas para el ${respuestaIA.fecha}:*\n\n`;
        resultado.resultados.forEach(item => {
          msgRespuesta += `• *${item.actividad}*\n  📍 Lugar: ${item.lugar}\n  ⏰ Hora: ${item.horaInicio}\n  🏫 Unidad: ${item.unidad}\n\n`;
        });
        await bot.sendMessage(chatId, msgRespuesta, { parse_mode: "Markdown" });
      } else {
        await bot.sendMessage(chatId, `❌ No se registraron reservas en Audiovisuales para el ${respuestaIA.fecha}.`);
      }
    } 
    else if (respuestaIA.accion === "agregar_audiovisual") {
      await bot.sendMessage(chatId, `⏳ Guardando el registro en la planilla...`);
      const resultado = await agregarAudiovisual(respuestaIA);

      if (resultado.status === "success") {
        await bot.sendMessage(
          chatId, 
          `✅ *¡Reserva guardada con éxito!*\n\n📅 *Fecha:* ${respuestaIA.fecha}\n📌 *Actividad:* ${respuestaIA.actividad}\n📍 *Lugar:* ${respuestaIA.lugar}\n⏰ *Hora:* ${respuestaIA.horaInicio}`, 
          { parse_mode: "Markdown" }
        );
      } else {
        await bot.sendMessage(chatId, `⚠️ No se pudo guardar el registro: ${resultado.message}`);
      }
    } 
    else {
      await bot.sendMessage(chatId, respuestaIA.respuesta || "No pude interpretar tu solicitud.");
    }

  } catch (error) {
    console.error("Error en el ciclo de procesamiento de mensaje:", error);
    await bot.sendMessage(chatId, "⚠️ Ocurrió un error al procesar la solicitud.");
  }
});
