import cron from 'node-cron';
import { DbService } from './dbService.js';

export function initScheduler(bot) {
  // Se ejecuta cada minuto (segundo 0)
  cron.schedule('* * * * *', async () => {
    try {
      const pendingTasks = await DbService.getPendingReminders();

      for (const task of pendingTasks) {
        const message =
          `⏰ *¡RECORDATORIO DE TU AGENDA!*\n\n` +
          `📌 *${task.titulo}*\n` +
          `📝 ${task.descripcion}\n` +
          `📍 *Lugar:* ${task.lugar_mencionado || 'No especificado'}`;

        // Enviar el mensaje automático al usuario de Telegram
        await bot.telegram.sendMessage(task.chat_id, message, {
          parse_mode: 'Markdown',
        });

        // Marcar en la base de datos como notificada
        await DbService.markAsNotified(task.id);
        console.log(`🔔 Notificación enviada para la tarea ID: ${task.id}`);
      }
    } catch (error) {
      console.error('Error en el programador de tareas:', error);
    }
  });

  console.log('⏱️ [Scheduler]: Servicio de alertas en tiempo real activado');
}