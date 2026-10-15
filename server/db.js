/** مجمع اتصال MySQL ومعاملات تضمن عدم حفظ نصف عملية. */
import mysql from 'mysql2/promise';
import { config } from './config.js';

export const pool = mysql.createPool(config.database);
pool.on('connection', (connection) => {
  connection.query("SET time_zone = '+00:00'");
});

export async function rows(sql, parameters = [], connection = pool) {
  const [result] = await connection.execute(sql, parameters);
  return result;
}

export async function transaction(callback) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const result = await callback(connection);
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}
