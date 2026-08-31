import { GoogleGenAI, Type } from '@google/genai';
import fs from 'fs';
import dotenv from 'dotenv';

dotenv.config();

if (!process.env.GEMINI_API_KEY) {
  throw new Error('CRÍTICO: GEMINI_API_KEY no está definida en el archivo .env');
}

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const taskResponseSchema = {
  type: Type.OBJECT,
  properties: {
    titulo: {
      type: Type.STRING,
      description: 'Título corto e imperativo de la tarea (máximo 6 palabras).',
    },
    descripcion: {
      type: Type.STRING,
      description: 'Detalle o transcripción limpia de la instrucción dada por el usuario.',
    },
    fecha_recordatorio: {
      type: Type.STRING,
      description: 'Fecha y hora exacta calculada en formato ISO 8601 (YYYY-MM-DDTHH:mm:ss.sssZ).',
    },
    lugar_mencionado: {
      type: Type.STRING,
      nullable: true,
      description: 'Nombre o dirección del lugar físico mencionado, o null si no existe.',
    },
  },
  required: ['titulo', 'descripcion', 'fecha_recordatorio'],
};

export class GeminiService {
  static async processText(textInput) {
    const nowISO = new Date().toISOString();
    const systemInstruction = `Eres un asistente de organización. Tu objetivo es procesar la instrucción del usuario y extraer los datos de la tarea.
Fecha y hora de referencia global actual (UTC): ${nowISO}.
Si no se indica una hora específica en la instrucción, asigna las 09:00:00 del día correspondiente.`;

    const response = await ai.models.generateContent({
      model: 'gemini-3.6-flash',
      contents: textInput,
      config: {
        systemInstruction,
        responseMimeType: 'application/json',
        responseSchema: taskResponseSchema,
        temperature: 0.1,
      },
    });

    return JSON.parse(response.text);
  }

  static async processAudio(mp3FilePath) {
    const nowISO = new Date().toISOString();
    const systemInstruction = `Eres un asistente de organización. Transcribe la nota de voz enviada por el usuario y extrae los datos de la tarea.
Fecha y hora de referencia global actual (UTC): ${nowISO}.
Si no se indica una hora específica en la instrucción, asigna las 09:00:00 del día correspondiente.`;

    const audioData = fs.readFileSync(mp3FilePath);

    const audioPart = {
      inlineData: {
        data: audioData.toString('base64'),
        mimeType: 'audio/mp3',
      },
    };

    const response = await ai.models.generateContent({
      model: 'gemini-3.6-flash',
      contents: [
        audioPart,
        { text: 'Procesa esta nota de voz y extrae la tarea según el esquema solicitado.' },
      ],
      config: {
        systemInstruction,
        responseMimeType: 'application/json',
        responseSchema: taskResponseSchema,
        temperature: 0.1,
      },
    });

    return JSON.parse(response.text);
  }
}