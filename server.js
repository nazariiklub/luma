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
  try {
    const body = await readFile(join(root, file));
    res.writeHead(200, { 'Content-Type': mime[extname(file)] || 'application/octet-stream', 'Cache-Control':'no-store' }).end(body);
  } catch { res.writeHead(404, { 'Content-Type':'text/plain; charset=utf-8' }).end('Не знайдено'); }
});

function frame(text, opcode = 0x1) {
  const data = Buffer.from(text); const size = data.length;
  if (size < 126) return Buffer.concat([Buffer.from([0x80 | opcode, size]), data]);
  if (size < 65536) { const h = Buffer.alloc(4); h[0]=0x80|opcode; h[1]=126; h.writeUInt16BE(size,2); return Buffer.concat([h,data]); }
  const h = Buffer.alloc(10); h[0]=0x80|opcode; h[1]=127; h.writeBigUInt64BE(BigInt(size),2); return Buffer.concat([h,data]);
}
function send(peer, data) { if (!peer.closed && !peer.socket.destroyed) peer.socket.write(frame(JSON.stringify(data))); }
function roomSend(room, data, exceptId) { for (const peer of room.values()) if (peer.id !== exceptId) send(peer, data); }
function remove(peer) {
  const room = rooms.get(peer.room);
  if (!room || room.get(peer.id) !== peer) return;
  room.delete(peer.id);
  roomSend(room, { type:'peer-left', id:peer.id });
  if (!room.size) rooms.delete(peer.room);
}

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key || req.headers['sec-websocket-version'] !== '13' || req.headers.upgrade?.toLowerCase() !== 'websocket') { socket.destroy(); return; }
  const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  socket.setNoDelay(true);
  const peer = { socket, id:'', room:'', name:'Гість', isSharing:false, buffer:Buffer.alloc(0), closed:false };

  socket.on('data', chunk => {
    peer.buffer = Buffer.concat([peer.buffer, chunk]);
    while (peer.buffer.length >= 2) {
      const b0=peer.buffer[0], b1=peer.buffer[1], opcode=b0&15;
      let size=b1&127, offset=2;
      if(size===126){if(peer.buffer.length<4)return;size=peer.buffer.readUInt16BE(2);offset=4;}
      else if(size===127){if(peer.buffer.length<10)return;const wide=peer.buffer.readBigUInt64BE(2);if(wide>1_000_000n){socket.destroy();return;}size=Number(wide);offset=10;}
      const masked=(b1&128)!==0;
      if(masked)offset+=4;
      if(peer.buffer.length<offset+size)return;
      const payload=Buffer.from(peer.buffer.subarray(offset,offset+size));
      if(masked){const mask=peer.buffer.subarray(offset-4,offset);for(let i=0;i<payload.length;i++)payload[i]^=mask[i%4];}
      peer.buffer=peer.buffer.subarray(offset+size);
      if(opcode===0x8){socket.end(frame('',0x8));return;}
      if(opcode===0x9){socket.write(frame(payload,0xA));continue;}
      if(opcode!==0x1)continue;
      let msg;try{msg=JSON.parse(payload.toString());}catch{continue;}

      if(msg.type==='join'){
        const roomId=String(msg.room||'').replace(/[^a-zA-Z0-9-]/g,'').slice(0,32);
        const requestedId=String(msg.userId||'').replace(/[^a-zA-Z0-9-]/gi,'').slice(0,64);
        if(!roomId)continue;
        let room=rooms.get(roomId);
        if(!room){room=new Map();rooms.set(roomId,room);}
        peer.id=requestedId||randomUUID();
        const current=room.get(peer.id);
        if(current&&(current.closed||current.socket.destroyed||!current.socket.writable)){
          room.delete(peer.id);
          roomSend(room,{type:'peer-left',id:peer.id});
        }
        else if(current){send(peer,{type:'already-here'});socket.end();return;}
        if(room.size>=4){send(peer,{type:'full'});socket.end();return;}
        peer.room=roomId;peer.name=String(msg.name||'Гість').trim().slice(0,24)||'Гість';room.set(peer.id,peer);
        send(peer,{type:'joined',id:peer.id,peers:[...room.values()].filter(p=>p.id!==peer.id).map(p=>({id:p.id,name:p.name}))});
        for(const currentPeer of room.values()) if(currentPeer.id!==peer.id&&currentPeer.isSharing) send(peer,{type:'sharing',id:currentPeer.id,active:true});
        roomSend(room,{type:'peer-joined',id:peer.id,name:peer.name},peer.id);
      }else if(msg.type==='signal'){
        const target=rooms.get(peer.room)?.get(String(msg.to||''));if(target)send(target,{type:'signal',from:peer.id,data:msg.data});
      }else if(msg.type==='name'){
        peer.name=String(msg.name||'Гість').trim().slice(0,24)||'Гість';roomSend(rooms.get(peer.room)||new Map(),{type:'peer-name',id:peer.id,name:peer.name});
      }else if(msg.type==='sharing'){
        const room=rooms.get(peer.room)||new Map();
        if(msg.active){
          const activePeer=[...room.values()].find(currentPeer=>currentPeer.id!==peer.id&&currentPeer.isSharing);
          if(activePeer){send(peer,{type:'sharing-rejected',id:activePeer.id});continue;}
        }
        peer.isSharing=!!msg.active;
        roomSend(room,{type:'sharing',id:peer.id,active:peer.isSharing},peer.id);
      }
    }
  });
  socket.on('close',()=>{peer.closed=true;remove(peer);});
  socket.on('error',()=>{peer.closed=true;remove(peer);});
});

const port=Number(process.env.PORT||3000);
server.listen(port,'0.0.0.0',()=>console.log(`Luma is ready on port ${port}`));
