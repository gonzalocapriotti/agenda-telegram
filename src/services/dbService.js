import sqlite3 from 'sqlite3';
import path from 'path';

const dbPath = path.resolve('agenda.db');
const db = new sqlite3.Database(dbPath);

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

  static markAsNotified(taskId) {
    return new Promise((resolve, reject) => {
      const query = `UPDATE tasks SET notificado = 1 WHERE id = ?`;
      db.run(query, [taskId], (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  /**
   * NUEVO: Obtiene todas las tareas pendientes futuras de un usuario específico.
   */
  static getAllPendingTasks(chatId) {
    return new Promise((resolve, reject) => {
      const query = `
        SELECT * FROM tasks 
        WHERE chat_id = ? AND notificado = 0 
        ORDER BY fecha_recordatorio ASC
      `;
      db.all(query, [chatId], (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      });
    });
  }

  /**
   * NUEVO: Elimina una tarea por su ID si pertenece al usuario que la solicita.
   */
  static deleteTaskById(taskId, chatId) {
    return new Promise((resolve, reject) => {
      const query = `DELETE FROM tasks WHERE id = ? AND chat_id = ?`;
      db.run(query, [taskId, chatId], function (err) {
        if (err) reject(err);
        else resolve(this.changes > 0); // Devuelve true si eliminó algún registro
      });
    });
  }
}