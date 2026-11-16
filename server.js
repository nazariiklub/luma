import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const root = process.cwd();
const rooms = new Map();
const mime = { '.html':'text/html; charset=utf-8', '.css':'text/css; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.json':'application/json' };
const server = http.createServer(async (req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  const file = path === '/' ? 'index.html' : normalize(decodeURIComponent(path).replace(/^\/+/, ''));
  if (file.startsWith('..')) { res.writeHead(403).end(); return; }
  try { const body = await readFile(join(root, file)); res.writeHead(200, { 'Content-Type': mime[extname(file)] || 'application/octet-stream', 'Cache-Control':'no-store' }).end(body); }
  catch { res.writeHead(404, { 'Content-Type':'text/plain; charset=utf-8' }).end('Не знайдено'); }
});

function frame(text) {
  const data = Buffer.from(text); const n = data.length;
  if (n < 126) return Buffer.concat([Buffer.from([0x81, n]), data]);
  if (n < 65536) { const h = Buffer.alloc(4); h[0]=0x81; h[1]=126; h.writeUInt16BE(n,2); return Buffer.concat([h,data]); }
  const h = Buffer.alloc(10); h[0]=0x81; h[1]=127; h.writeBigUInt64BE(BigInt(n),2); return Buffer.concat([h,data]);
}
function send(peer, data) { if (!peer.closed) peer.socket.write(frame(JSON.stringify(data))); }
function roomSend(room, data, except) { for (const peer of room.values()) if (peer.id !== except) send(peer, data); }
function remove(peer) {
  const room = rooms.get(peer.room); if (!room || !room.has(peer.id)) return;
  room.delete(peer.id); roomSend(room, { type:'peer-left', id:peer.id });
  if (!room.size) rooms.delete(peer.room);
}
server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key']; if (!key) { socket.destroy(); return; }
  const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  const peer = { socket, id:randomUUID(), room:'', name:'Гість', buffer:Buffer.alloc(0), closed:false };
  socket.on('data', chunk => {
    peer.buffer = Buffer.concat([peer.buffer, chunk]);
    while (peer.buffer.length >= 2) {
      const b0=peer.buffer[0], b1=peer.buffer[1]; let len=b1&127, offset=2;
      if (len===126) { if(peer.buffer.length<4) return; len=peer.buffer.readUInt16BE(2); offset=4; }
      else if(len===127) { if(peer.buffer.length<10)return; const wide=peer.buffer.readBigUInt64BE(2); if(wide>1_000_000n){socket.destroy();return;} len=Number(wide); offset=10; }
      const masked=(b1&128)!==0; if(masked)offset+=4; if(peer.buffer.length<offset+len)return;
      const payload=Buffer.from(peer.buffer.subarray(offset,offset+len));
      if(masked){const mask=peer.buffer.subarray(offset-4,offset);for(let i=0;i<payload.length;i++)payload[i]^=mask[i%4];}
      peer.buffer=peer.buffer.subarray(offset+len);
      if((b0&15)===8){socket.end();return;} if((b0&15)!==1)continue;
      let msg;try{msg=JSON.parse(payload.toString());}catch{continue;}
      if(msg.type==='join'){
        const roomId=String(msg.room||'').replace(/[^a-zA-Z0-9-]/g,'').slice(0,32); if(!roomId)continue;
        const room=rooms.get(roomId)||new Map();
        if(room.size>=4){send(peer,{type:'full'});continue;}
        peer.room=roomId;peer.name=String(msg.name||'Гість').slice(0,24);room.set(peer.id,peer);rooms.set(roomId,room);
        send(peer,{type:'joined',id:peer.id,peers:[...room.values()].filter(p=>p.id!==peer.id).map(p=>({id:p.id,name:p.name}))});
        roomSend(room,{type:'peer-joined',id:peer.id,name:peer.name},peer.id);
      } else if(msg.type==='signal') {
        const target=rooms.get(peer.room)?.get(msg.to); if(target)send(target,{type:'signal',from:peer.id,data:msg.data});
      } else if(msg.type==='name') { peer.name=String(msg.name||'Гість').slice(0,24);roomSend(rooms.get(peer.room)||new Map(),{type:'peer-name',id:peer.id,name:peer.name}); }
      else if(msg.type==='sharing') roomSend(rooms.get(peer.room)||new Map(),{type:'sharing',id:peer.id,active:!!msg.active},peer.id);
    }
  });
  socket.on('close',()=>{peer.closed=true;remove(peer);});socket.on('error',()=>{peer.closed=true;remove(peer);});
});
const port=Number(process.env.PORT||3000);server.listen(port,'0.0.0.0',()=>console.log(`Luma is ready on http://localhost:${port}`));
