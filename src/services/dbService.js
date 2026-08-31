import sqlite3 from 'sqlite3';
import path from 'path';

const dbPath = path.resolve('agenda.db');
const db = new sqlite3.Database(dbPath);

// Inicializar tabla de tareas
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id INTEGER NOT NULL,
      titulo TEXT NOT NULL,
      descripcion TEXT NOT NULL,
      fecha_recordatorio TEXT NOT NULL,
      lugar_mencionado TEXT,
      notificado INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);
});

export class DbService {
  /**
   * Guarda una nueva tarea en la base de datos.
   */
  static saveTask(chatId, taskData) {
    return new Promise((resolve, reject) => {
      const query = `
        INSERT INTO tasks (chat_id, titulo, descripcion, fecha_recordatorio, lugar_mencionado)
        VALUES (?, ?, ?, ?, ?)
      `;
      db.run(
        query,
        [
          chatId,
          taskData.titulo,
          taskData.descripcion,
          taskData.fecha_recordatorio,
          taskData.lugar_mencionado || null,
        ],
        function (err) {
          if (err) reject(err);
          else resolve(this.lastID);
        }
      );
    });
  }

  /**
   * Obtiene todas las tareas vencidas que aún no han sido notificadas.
   */
  static getPendingReminders() {
    return new Promise((resolve, reject) => {
      const nowISO = new Date().toISOString();
      const query = `
        SELECT * FROM tasks 
        WHERE fecha_recordatorio <= ? AND notificado = 0
      `;
      db.all(query, [nowISO], (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      });
    });
  }

  /**
   * Marca una tarea como ya notificada.
   */
  static markAsNotified(taskId) {
    return new Promise((resolve, reject) => {
      const query = `UPDATE tasks SET notificado = 1 WHERE id = ?`;
      db.run(query, [taskId], (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }
}