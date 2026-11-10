const net = require('node:net');
const fs = require('node:fs');
const { EventEmitter } = require('node:events');

function ownSocket(address) {
  let stat;
  try { stat = fs.lstatSync(address); } catch { return; }
  if (!stat.isSocket() || stat.uid !== process.getuid()) {
    const error = new Error(`Сокет ${address} создан не тобой — подключение отменено. Удали его вручную.`);
    error.code = 'HARBOR_FOREIGN_SOCKET'; throw error;
  }
}

class Client extends EventEmitter {
  constructor(address) { super(); this.address = address; this.pending = new Map(); this.sequence = 0; }
  connect() {
    return new Promise((resolve, reject) => {
      try { ownSocket(this.address); } catch (error) { return reject(error); }
      this.socket = net.createConnection(this.address);
      let buffer = '';
      this.socket.setEncoding('utf8');
      this.socket.once('connect', resolve);
      this.socket.once('error', reject);
      this.socket.on('error', () => {});
      this.socket.on('data', data => {
        buffer += data;
        if (buffer.length > 32 * 1024 * 1024) return this.socket.destroy(new Error('Слишком большой ответ'));
        let position;
        while ((position = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, position); buffer = buffer.slice(position + 1);
          let message;
          try { message = JSON.parse(line); } catch { continue; }
          if (message.event) this.emit(message.event, message);
          else {
            const pending = this.pending.get(message.requestId);
            if (pending) {
              clearTimeout(pending.timer); this.pending.delete(message.requestId);
              if (message.error) pending.reject(new Error(message.error)); else pending.resolve(message.result);
            }
          }
        }
      });
      this.socket.on('close', () => {
        for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('Связь с менеджером сессий потеряна')); }
        this.pending.clear(); this.emit('disconnected');
      });
    });
  }
  request(method, params = {}) {
    return new Promise((resolve, reject) => {
      if (!this.socket || this.socket.destroyed) return reject(new Error('Нет подключения к менеджеру сессий'));
      const requestId = ++this.sequence;
      const timer = setTimeout(() => { this.pending.delete(requestId); reject(new Error('Менеджер сессий не ответил вовремя')); }, 30000);
      this.pending.set(requestId, { resolve, reject, timer });
      this.socket.write(JSON.stringify({ requestId, method, params }) + '\n');
    });
  }
  close() { this.socket?.destroy(); }
}
module.exports = { Client };
